// Package peripherals is the Peripherals page's backend: what cameras and microphones the
// selected board has, as SiMa Sentinel scans them, with Sentinel's own verdicts on each camera
// mode; a camera's live preview (a GStreamer pipeline on the board whose JPEG pictures Insight
// relays); and a microphone test (a short recording with a live level, then the WAV).
//
// Everything is per board and lasts while that board is selected: one scan (the last), one
// preview and one test at a time. Selecting another board, or the board's replacement (its host
// key trusted), drops them; what still ran on the board ended with its connection.
package peripherals

import (
	"context"
	"net/http"
	"sync"
	"time"

	"insight/internal/apierr"
	"insight/internal/board"
	"insight/internal/sentinel"
)

// Timing are the waits of the previews; zero fields take the defaults.
type Timing struct {
	// FirstFrame is how long a preview's start waits for its first picture, Stall how long a
	// running preview may send none: each at least this, or two frame periods of a slow mode.
	FirstFrame, Stall time.Duration
	// Unclaimed is how long a preview runs before a browser opens its stream.
	Unclaimed time.Duration
}

var defaultTiming = Timing{FirstFrame: 10 * time.Second, Stall: 10 * time.Second, Unclaimed: 15 * time.Second}

// Manager holds the selected board's scan, preview and microphone test.
type Manager struct {
	timing Timing

	mu      sync.Mutex
	current *boardState
	closed  bool
}

// New makes a Manager.
func New(timing Timing) *Manager {
	if timing.FirstFrame == 0 {
		timing.FirstFrame = defaultTiming.FirstFrame
	}
	if timing.Stall == 0 {
		timing.Stall = defaultTiming.Stall
	}
	if timing.Unclaimed == 0 {
		timing.Unclaimed = defaultTiming.Unclaimed
	}
	return &Manager{timing: timing}
}

// boardState is what the Manager holds for one board.
type boardState struct {
	board *board.Board
	// work is held by a scan and by a preview's start: a scan stops the preview first, and no
	// preview starts while one runs.
	work sync.Mutex

	mu      sync.Mutex
	scan    *Scan
	preview *preview
	test    *micTest
	// testStarting is set while a test's recording starts on the board.
	testStarting bool
}

// state is b's state: a board other than the one held before (another selected, or this one
// replaced) starts empty, and what the one before ran stops.
func (m *Manager) state(b *board.Board) (*boardState, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, apierr.Errorf(http.StatusServiceUnavailable, "shutting_down", "", "Insight is shutting down.")
	}
	if m.current != nil && m.current.board == b {
		defer m.mu.Unlock()
		return m.current, nil
	}
	old := m.current
	m.current = &boardState{board: b}
	current := m.current
	m.mu.Unlock()
	if old != nil {
		old.stop()
	}
	return current, nil
}

// stop ends the state's preview and test.
func (s *boardState) stop() {
	s.mu.Lock()
	p, test := s.preview, s.test
	s.mu.Unlock()
	if p != nil {
		p.end(errStopped)
	}
	if test != nil {
		test.stop()
	}
}

// Close stops the preview and the test, at shutdown; nothing starts after it.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	current := m.current
	m.current = nil
	m.mu.Unlock()
	if current != nil {
		current.stop()
	}
}

// Scan is one scan of a board's peripherals.
type Scan struct {
	ScannedAt time.Time `json:"scanned_at"`
	// ScanMs is how long Sentinel's scan took.
	ScanMs int64 `json:"scan_ms"`
	// Items are the devices the scan found (devices.go).
	Items []Item `json:"items"`
	// Issues are the providers that failed in the scan.
	Issues []Issue `json:"issues"`
	// CameraSetup is the board's, nil from a Sentinel that does not read it.
	CameraSetup *CameraSetup `json:"camera_setup"`
	// Changes say what the scan found or missed against the one before; nil for the first.
	Changes *Changes `json:"changes"`

	devices catalog
}

// Peripherals is the board's last scan, nil before the first.
type Peripherals struct {
	Scan *Scan `json:"scan"`
}

// Peripherals answers from memory: the last scan of b.
func (m *Manager) Peripherals(b *board.Board) (Peripherals, error) {
	s, err := m.state(b)
	if err != nil {
		return Peripherals{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return Peripherals{Scan: s.scan}, nil
}

// Refresh has Sentinel scan b's peripherals and answers with the scan. The camera preview stops
// first, so the scan finds the camera free. A refresh that waited for another gets that one's
// scan.
func (m *Manager) Refresh(ctx context.Context, b *board.Board) (Peripherals, error) {
	s, err := m.state(b)
	if err != nil {
		return Peripherals{}, err
	}
	asked := time.Now()
	s.work.Lock()
	defer s.work.Unlock()
	s.mu.Lock()
	previous, p := s.scan, s.preview
	s.mu.Unlock()
	if previous != nil && !previous.ScannedAt.Before(asked) {
		return Peripherals{Scan: previous}, nil
	}
	if p != nil {
		p.end(errStopped)
	}
	started := time.Now()
	body, err := sentinel.Call(ctx, b, http.MethodPost, "/v1/peripherals/refresh", nil)
	if err != nil {
		return Peripherals{}, err
	}
	parsed, err := parseCatalog(body)
	if err != nil {
		return Peripherals{}, err
	}
	scan := &Scan{ScannedAt: time.Now(), ScanMs: time.Since(started).Milliseconds(), Items: parsed.items(),
		Issues: parsed.issues(), CameraSetup: parsed.cameraSetup(), devices: parsed}
	if previous != nil {
		scan.Changes = changes(previous.devices, parsed)
	}
	s.mu.Lock()
	s.scan = scan
	s.mu.Unlock()
	return Peripherals{Scan: scan}, nil
}

// scanned is the last scan's catalog, or why there is none.
func (s *boardState) scanned() (catalog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.scan == nil {
		return catalog{}, apierr.Errorf(http.StatusConflict, "no_scan", "Refresh, then try again.",
			"The board's peripherals have not been scanned yet.")
	}
	return s.scan.devices, nil
}
