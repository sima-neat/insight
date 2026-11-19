package peripherals

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"insight/internal/apierr"
	"insight/internal/board"
	"insight/internal/relay"
	"insight/internal/sentinel"
)

// maxFrameWait is the longest a preview waits for a picture, however slow its mode.
const maxFrameWait = time.Minute

// cameraRateTimeout bounds the rescan that reads a MIPI camera's rate once its preview runs.
const cameraRateTimeout = 10 * time.Second

// Preview is a camera preview as the API shows it.
type Preview struct {
	// ID tells this preview from the next one of the same camera.
	ID        string    `json:"id"`
	Camera    string    `json:"camera"`
	Mode      Mode      `json:"mode"`
	StartedAt time.Time `json:"started_at"`
	// CameraFPS is the rate the camera runs at: the mode's for USB; for MIPI, Sentinel's
	// reading once the camera runs in the mode, nil until then.
	CameraFPS *float64 `json:"camera_fps"`
	// Viewer says whether a browser shows the preview: its stream has one viewer.
	Viewer bool `json:"viewer"`
}

// PreviewAnswer is the board's preview, nil when none runs.
type PreviewAnswer struct {
	Preview *Preview `json:"preview"`
}

var (
	errStopped    = errors.New("stopped")
	errStalled    = errors.New("the camera sent no picture in time")
	errUnclaimed  = errors.New("no browser opened the preview")
	errViewerLeft = errors.New("its viewer left")
)

// preview is one running preview: the board's pipeline, its newest picture as a part of the
// stream's answer, and its one viewer.
type preview struct {
	stream *board.Stream
	stall  time.Duration
	onEnd  func(*preview)

	mu       sync.Mutex
	info     Preview
	part     []byte
	seq      uint64
	next     chan struct{} // closed at each picture
	claimed  bool
	reason   error
	first    chan struct{} // closed at the first picture
	ended    chan struct{}
	endOnce  sync.Once
	stallT   *time.Timer
	unclaimT *time.Timer
}

// Preview is b's running preview, from memory.
func (m *Manager) Preview(b *board.Board) (PreviewAnswer, error) {
	s, err := m.state(b)
	if err != nil {
		return PreviewAnswer{}, err
	}
	return PreviewAnswer{Preview: s.livePreview()}, nil
}

func (s *boardState) livePreview() *Preview {
	s.mu.Lock()
	p := s.preview
	s.mu.Unlock()
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reason != nil {
		return nil
	}
	info := p.info
	return &info
}

// StartPreview starts previewing camera in mode on b: the board runs a GStreamer pipeline
// whose first picture the start waits for, so a camera that cannot stream says why here. One
// preview runs on a board at a time; it stops when its viewer leaves, when no browser opens it
// within Timing.Unclaimed, when it stalls, and when it is stopped.
func (m *Manager) StartPreview(ctx context.Context, b *board.Board, camera string, mode Mode) (PreviewAnswer, error) {
	s, err := m.state(b)
	if err != nil {
		return PreviewAnswer{}, err
	}
	s.work.Lock()
	defer s.work.Unlock()
	if running := s.livePreview(); running != nil {
		return PreviewAnswer{}, apierr.Errorf(http.StatusConflict, "preview_active", "Stop that preview before starting another.",
			"A preview of %s is already running.", running.Camera)
	}
	scanned, err := s.scanned()
	if err != nil {
		return PreviewAnswer{}, err
	}
	d, ok := scanned.device(camera)
	if !ok || d.Type != "camera" {
		return PreviewAnswer{}, apierr.Errorf(http.StatusNotFound, "not_found", "Refresh, and pick a camera from the list.",
			"The last scan lists no camera %s.", camera)
	}
	if scanned.stale(d) {
		return PreviewAnswer{}, apierr.Errorf(http.StatusConflict, "stale_scan",
			"Refresh again; if Sentinel's camera provider keeps failing, check Sentinel on the board.",
			"%s is listed from Sentinel's last successful scan: its provider failed in this one.", d.name())
	}
	source, err := previewable(d, mode)
	if err != nil {
		return PreviewAnswer{}, err
	}
	argv := pipeline(source)
	// The pipeline outlives the request; it ends with the preview, or with the board.
	stream, err := b.Stream(context.Background(), argv)
	if err != nil {
		return PreviewAnswer{}, err
	}
	frames := framesWait(m.timing.FirstFrame, source.rate)
	p := &preview{
		stream: stream, stall: framesWait(m.timing.Stall, source.rate), onEnd: s.previewEnded,
		info: Preview{ID: newID(), Camera: camera, Mode: mode, StartedAt: time.Now()},
		next: make(chan struct{}), first: make(chan struct{}), ended: make(chan struct{}),
	}
	if source.connection == "usb" {
		fps := source.rate.fps()
		p.info.CameraFPS = &fps
	}
	p.stallT = time.AfterFunc(time.Hour, func() { p.end(errStalled) })
	p.stallT.Stop() // armed by each picture
	go p.read()

	timer := time.NewTimer(frames)
	defer timer.Stop()
	select {
	case <-p.first:
	case <-p.ended:
		return PreviewAnswer{}, startFailure(d.name(), source, p, "")
	case <-timer.C:
		p.end(errStalled)
		return PreviewAnswer{}, startFailure(d.name(), source, p, fmt.Sprintf("The camera sent no picture within %s.", frames.Round(time.Second)))
	case <-ctx.Done():
		p.end(errStopped)
		return PreviewAnswer{}, ctx.Err()
	}
	s.mu.Lock()
	s.preview = p
	s.mu.Unlock()
	p.mu.Lock()
	p.unclaimT = time.AfterFunc(m.timing.Unclaimed, func() { p.end(errUnclaimed) })
	info := p.info
	p.mu.Unlock()
	if source.connection == "mipi" {
		go p.readCameraRate(b, camera)
	}
	return PreviewAnswer{Preview: &info}, nil
}

// framesWait is base, or two frame periods of a slower mode, at most maxFrameWait.
func framesWait(base time.Duration, r rate) time.Duration {
	return max(base, min(time.Duration(2/r.fps()*float64(time.Second)), maxFrameWait))
}

func newID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// read relays the pipeline's pictures until it ends.
func (p *preview) read() {
	err := relay.ReadFrames(p.stream, func(jpeg []byte) {
		part := relay.AppendPart(nil, jpeg)
		p.mu.Lock()
		if p.seq == 0 {
			close(p.first)
		}
		p.part, p.seq = part, p.seq+1
		close(p.next)
		p.next = make(chan struct{})
		p.mu.Unlock()
		p.stallT.Reset(p.stall)
	})
	if err == nil {
		err = errors.New("the pipeline ended")
	}
	p.end(err)
}

// end stops the preview for reason, once: the pipeline is killed and its viewer's stream ends.
func (p *preview) end(reason error) {
	p.endOnce.Do(func() {
		p.mu.Lock()
		p.reason = reason
		unclaimed := p.unclaimT
		p.mu.Unlock()
		p.stallT.Stop()
		if unclaimed != nil {
			unclaimed.Stop()
		}
		// Closed before ended is: the pipeline's stderr is whole once Close returns.
		_ = p.stream.Close()
		close(p.ended)
		if p.onEnd != nil {
			p.onEnd(p)
		}
		if !errors.Is(reason, errStopped) && !errors.Is(reason, errViewerLeft) {
			slog.Info("camera preview ended", "camera", p.info.Camera, "reason", reason)
		}
	})
}

func (s *boardState) previewEnded(p *preview) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.preview == p {
		s.preview = nil
	}
}

// readCameraRate sets a MIPI preview's camera rate from a rescan by Sentinel, which reads the
// sensor's current mode, now the preview's. The scan is not recorded, and the preview goes on
// whatever it finds.
func (p *preview) readCameraRate(b *board.Board, camera string) {
	ctx, cancel := context.WithTimeout(context.Background(), cameraRateTimeout)
	defer cancel()
	go func() {
		select {
		case <-p.ended:
			cancel()
		case <-ctx.Done():
		}
	}()
	body, err := sentinel.Call(ctx, b, http.MethodPost, "/v1/peripherals/refresh", nil)
	if err != nil {
		slog.Info("could not read the previewed camera's rate", "camera", camera, "error", err)
		return
	}
	scanned, err := parseCatalog(body)
	if err != nil {
		return
	}
	d, ok := scanned.device(camera)
	if !ok || scanned.stale(d) || d.MaxFPS <= 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	fps := d.MaxFPS
	p.info.CameraFPS = &fps
}

// What libcamera and v4l2src print when another process holds the camera; what libcamera's
// Modalix pipeline prints when it configures another size than the one asked for, which then
// cannot be negotiated; and what gst-launch prints for an element it lacks.
var (
	cameraBusy = regexp.MustCompile(`Failed to acquire camera|Device or resource busy|Device '[^']*' is busy`)
	configured = regexp.MustCompile(`configuring streams: \(0\) (\d+)x(\d+)-|Applying neutral DV Timings for \S+ \((\d+)x(\d+)\)`)
	noElement  = regexp.MustCompile(`no element "(\w+)"`)
)

const gstHint = "Install GStreamer on the board: `sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-base " +
	"gstreamer1.0-plugins-good`, and `gstreamer1.0-libcamera` for MIPI cameras."

// startFailure says why a preview's pipeline sent no first picture, from what it printed.
// timedOut is the message of a pipeline still running when the wait ended, "" for one that
// exited.
func startFailure(name string, s previewSource, p *preview, timedOut string) error {
	<-p.ended
	text := string(p.stream.Stderr())
	if match := cameraBusy.FindString(text); match != "" {
		return apierr.Errorf(http.StatusConflict, "camera_in_use", "Stop the application using the camera, then start the preview.",
			"%s is in use by another process (the board says %q).", name, match)
	}
	if match := configured.FindStringSubmatch(text); match != nil {
		w, h := match[1]+match[3], match[2]+match[4]
		if w != strconv.Itoa(s.width) || h != strconv.Itoa(s.height) {
			return apierr.Errorf(http.StatusUnprocessableEntity, "mode_adjusted",
				fmt.Sprintf("Pick %sx%s. The board lists %dx%d as a sensor size, but its libcamera pipeline does not output it.", w, h, s.width, s.height),
				"libcamera streams %s at %sx%s, not %dx%d.", name, w, h, s.width, s.height)
		}
	}
	if match := noElement.FindStringSubmatch(text); match != nil {
		return apierr.Errorf(http.StatusBadGateway, "tool_missing", gstHint,
			"The board's GStreamer has no %s element, which the preview needs.", match[1])
	}
	if strings.Contains(text, "gst-launch-1.0: not found") || strings.Contains(text, "gst-launch-1.0: command not found") {
		return apierr.Errorf(http.StatusBadGateway, "tool_missing", gstHint,
			"The preview runs gst-launch-1.0 on the board, which is not installed there.")
	}
	said := lastLine(text)
	if timedOut != "" {
		return apierr.Errorf(http.StatusGatewayTimeout, "preview_timeout",
			"Check that the camera is connected and that no other application holds it."+said, "%s", timedOut)
	}
	return apierr.Errorf(http.StatusBadGateway, "command_failed",
		"Check that the camera is connected and that no other application holds it."+said,
		"The preview's pipeline stopped before it sent a picture.")
}

// lastLine is " The board said: <the last line of text>.", or "" for no text.
func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	if last == "" {
		return ""
	}
	if len(last) > 300 {
		last = last[:300]
	}
	return " The board said: " + last
}

// ServePreview answers with camera's preview on b as multipart/x-mixed-replace, to one viewer:
// the preview stops when this answer ends. id, when not "", must name the running preview.
func (m *Manager) ServePreview(w http.ResponseWriter, r *http.Request, b *board.Board, camera, id string) {
	s, err := m.state(b)
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	s.mu.Lock()
	p := s.preview
	s.mu.Unlock()
	if p == nil || p.info.Camera != camera || (id != "" && p.info.ID != id) {
		apierr.Write(w, http.StatusNotFound, "not_found", "No preview of this camera is running.", "Start the preview again.")
		return
	}
	p.mu.Lock()
	refusal := ""
	switch {
	case p.reason != nil:
		refusal = "ended"
	case p.claimed:
		refusal = "claimed"
	default:
		p.claimed, p.info.Viewer = true, true
	}
	unclaimed := p.unclaimT
	p.mu.Unlock()
	switch refusal {
	case "ended":
		apierr.Write(w, http.StatusNotFound, "not_found", "No preview of this camera is running.", "Start the preview again.")
		return
	case "claimed":
		apierr.Write(w, http.StatusConflict, "preview_active", "This preview is shown in another tab or window.",
			"Close the other view, or stop the preview and start it again here.")
		return
	}
	if unclaimed != nil {
		unclaimed.Stop()
	}
	// The pipeline must not outlive its only viewer.
	defer p.end(errViewerLeft)

	w.Header().Set("Content-Type", relay.ContentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if _, err := io.WriteString(w, relay.OpeningBoundary); err != nil {
		return
	}
	control := http.NewResponseController(w)
	var sent uint64
	for {
		p.mu.Lock()
		part, seq, next := p.part, p.seq, p.next
		p.mu.Unlock()
		if seq != sent {
			// A viewer that cannot take one picture within the stall time is gone.
			_ = control.SetWriteDeadline(time.Now().Add(p.stall))
			if _, err := w.Write(part); err != nil {
				return
			}
			if err := control.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
				return
			}
			_ = control.SetWriteDeadline(time.Time{})
			sent = seq
			continue
		}
		select {
		case <-next:
		case <-p.ended:
			return
		case <-r.Context().Done():
			return
		}
	}
}

// StopPreview stops camera's preview on b and answers with the board's preview afterwards: the
// one of another camera, or of the camera but another id, goes on.
func (m *Manager) StopPreview(b *board.Board, camera, id string) (PreviewAnswer, error) {
	s, err := m.state(b)
	if err != nil {
		return PreviewAnswer{}, err
	}
	s.mu.Lock()
	p := s.preview
	s.mu.Unlock()
	if p != nil && p.info.Camera == camera && (id == "" || p.info.ID == id) {
		p.end(errStopped)
	}
	return PreviewAnswer{Preview: s.livePreview()}, nil
}
