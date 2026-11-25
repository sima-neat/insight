// Package slots is the Streaming page's backend: the 48 sources src1 to src48, each publishing a
// library file, a browser's webcam or a camera Insight pulls as rtsp://<host>:8554/srcN through
// MediaMTX (docs/contracts.md, "Sources").
//
// Insight keeps one thing about a slot, what the user asked of it (Desired, in the Store, saved
// across restarts). Everything a slot shows is derived from the world when it is listed: the
// publisher process the supervisor runs for a file slot, a MediaMTX snapshot the Manager takes
// once a second (who publishes and reads each path), and the jobs that encode renditions. A
// reconcile step per slot makes the world match what was asked: it starts or stops the
// publisher, sets or clears MediaMTX's pull of a camera and ends a webcam publisher the slot no
// longer wants. It runs after every change and on every snapshot, and doing it again changes
// nothing, so a failed step, a crash of a publisher or a restart of MediaMTX is mended by the
// next one.
package slots

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/mediamtx"
	"insight/internal/supervisor"
)

// Count is how many slots there are: src1 to src48. It is stated here once; MediaMTX's
// configuration (webrtc/mediamtx.yml) names the same paths and its webcam paths cam1 to cam48.
const Count = 48

// Kind is what feeds a slot.
type Kind string

const (
	KindNone   Kind = "none"
	KindFile   Kind = "file"
	KindWebcam Kind = "webcam"
	KindPull   Kind = "pull"
)

// State is how a slot stands, derived from the world.
type State string

const (
	// Idle: the slot is stopped, has nothing assigned, or is a webcam no browser publishes.
	Idle State = "idle"
	// Preparing: a rendition of the slot's file at its frame rate is being encoded (Job).
	Preparing State = "preparing"
	// Starting: the slot is to run and its stream is on its way.
	Starting State = "starting"
	// Live: MediaMTX has the slot's stream.
	Live State = "live"
	// Failed: the slot is to run and cannot (Error says why).
	Failed State = "failed"
	// External: a publisher Insight did not start holds the slot.
	External State = "external"
)

// RenditionJob is the kind of the jobs that encode renditions; the runner's limit for it is
// how many encode at once.
const RenditionJob jobs.Kind = "rendition"

// MediaMTX is the part of MediaMTX's API the slots use (*mediamtx.Client).
type MediaMTX interface {
	Snapshot(ctx context.Context) (mediamtx.Snapshot, error)
	Kick(ctx context.Context, sessionType, id string) error
	SetPullSource(ctx context.Context, name, source string) error
	ClearPullSource(ctx context.Context, name string) error
}

// Probes is what the media library knows of its files (*media.Cache).
type Probes interface {
	Get(abs string) (media.Info, bool)
	Want(abs string)
}

// Relay serves a relayed MJPEG stream (*relay.Relays).
type Relay interface {
	Serve(w http.ResponseWriter, req *http.Request, key, source string)
}

// URLOptions say how apps and browsers reach the slots, resolved once at start.
type URLOptions struct {
	// RTSPPort is the port apps read sources on: the SDK port map's rtsp.tcp host port, or 0
	// for MediaMTX's 8554.
	RTSPPort int
	// WHIPPort is the port browsers post their webcam's WHIP offer to: the port map's
	// webrtcWhip host port, or 0 for MediaMTX's 8889.
	WHIPPort int
	// PublicOrigin is the origin a shared proxy serves Insight under ("https://host/",
	// config.Network.PublicOrigin), or "" when browsers reach Insight directly. The HTTP
	// MJPEG and WHIP URLs go through it.
	PublicOrigin string
}

// Options say what the slots work with.
type Options struct {
	// StorePath is the file the desired state is saved to (<data>/sources.json).
	StorePath string
	// MediaRoot is the media library's folder; renditions are kept in its .renditions.
	MediaRoot string
	// Probes are the library's probes, which the slots read and ask for.
	Probes Probes
	// MediaMTX is its API, with this run's credentials.
	MediaMTX MediaMTX
	// PublisherQuery marks the streams Insight publishes as its own (Secrets.PublisherQuery).
	PublisherQuery string
	// RTSPBase is MediaMTX's RTSP listener as Insight reaches it; "" for mediamtx.RTSPURL.
	RTSPBase string
	// Start runs the publishers and the encodes (Supervisor.Starter).
	Start supervisor.Starter
	// Jobs runs the renditions' encodes as jobs of kind RenditionJob.
	Jobs *jobs.Runner
	// Relays serve the slot previews and the slots' HTTP MJPEG output; their Start must make
	// a slot key's producer with RelayCommand.
	Relays Relay
	// FFmpeg and FFprobe are the programs.
	FFmpeg, FFprobe string
	// Preload is the TCP_NODELAY shim the RTSP publishers run with (ffmpeg_nodelay.so), or ""
	// for none.
	Preload string
	// URLs say how the slots are reached from outside.
	URLs URLOptions
	// Output receives the publishers' and encodes' lines, as the supervisor writes them; nil
	// discards them.
	Output io.Writer

	// Seams for the tests: zero values are the real ones. With driven, New starts neither the
	// loop nor the slots' workers: the test takes the snapshots and runs the reconciles itself
	// (tick, reconcile), so none runs between its steps.
	driven        bool
	snapshotEvery time.Duration
	probeStream   StreamProber
	encode        encoder
}

const (
	defaultSnapshotEvery = time.Second
	// pullProbeEvery is how often a pull that is not live is probed again, so the slot can say
	// why it is not (no answer, or refused credentials).
	pullProbeEvery = 10 * time.Second
	// streamProbes is how many stream probes run at once.
	streamProbes = 4
	// stopTimeout bounds stopping one child.
	stopTimeout = 10 * time.Second
	// publisherGrace is how long a publisher gets to exit after SIGTERM.
	publisherGrace = 3 * time.Second
)

// Manager is the slots: their store, their processes and their state. It is safe for
// concurrent use; every operation changes the desired state in memory, saves it and returns,
// and the slot's reconcile does the rest.
type Manager struct {
	opts Options
	root string
	urls urls
	env  []string // the publishers' environment

	ctx    context.Context
	cancel context.CancelFunc
	done   sync.WaitGroup

	refresh chan struct{} // asks the loop for a snapshot now
	probing chan struct{} // a slot per stream probe running

	mu      sync.Mutex
	store   *Store
	rt      [Count]*slotRuntime
	snap    mediamtx.Snapshot // the latest; empty while MediaMTX is unavailable
	prev    mediamtx.Snapshot // the one before, for bitrates
	mtxUp   bool
	encodes map[string]*encodeJob // by rendition file name
}

// New loads the store and starts the slots' loop. Nothing a slot had runs again by itself: a
// restored slot is stopped until it is started. A damaged store is logged and starts empty.
func New(opts Options) (*Manager, error) {
	switch {
	case opts.StorePath == "" || opts.MediaRoot == "":
		return nil, errors.New("slots: StorePath and MediaRoot are required")
	case opts.Probes == nil || opts.MediaMTX == nil || opts.Start == nil || opts.Jobs == nil || opts.Relays == nil:
		return nil, errors.New("slots: Probes, MediaMTX, Start, Jobs and Relays are required")
	case opts.PublisherQuery == "":
		return nil, errors.New("slots: PublisherQuery is required")
	}
	if opts.RTSPBase == "" {
		opts.RTSPBase = mediamtx.RTSPURL
	}
	if opts.snapshotEvery == 0 {
		opts.snapshotEvery = defaultSnapshotEvery
	}
	if opts.probeStream == nil {
		opts.probeStream = FFprobeStream(opts.FFprobe)
	}
	store, err := LoadStore(opts.StorePath)
	if err != nil {
		slog.Warn("the sources were not all restored", "error", err)
	}
	m := &Manager{
		opts:    opts,
		root:    filepath.Clean(opts.MediaRoot),
		urls:    newURLs(opts.URLs),
		refresh: make(chan struct{}, 1),
		probing: make(chan struct{}, streamProbes),
		store:   store,
		encodes: map[string]*encodeJob{},
	}
	if m.opts.encode == nil {
		m.opts.encode = m.runEncode
	}
	m.env = preloadEnv(opts.Preload)
	for i := range m.rt {
		m.rt[i] = &slotRuntime{wake: make(chan struct{}, 1)}
		// A camera URL without secrets was kept whole; one with secrets needs them again.
		if pull := store.get(i + 1).Pull; pull != nil {
			m.rt[i].fullURL = pull.URL
		}
	}
	m.ctx, m.cancel = context.WithCancel(context.Background())
	m.removeUnfinishedRenditions()
	if !opts.driven {
		m.done.Add(1 + Count)
		go m.loop()
		for n := 1; n <= Count; n++ {
			go m.worker(n)
		}
	}
	m.done.Add(1)
	go func() {
		defer m.done.Done()
		if err := m.PruneRenditions(); err != nil {
			slog.Warn("pruning renditions", "error", err)
		}
	}()
	return m, nil
}

// Close stops the loop, every publisher the slots started and their encodes, and returns once
// they have exited or ctx ends. The desired state stays saved.
func (m *Manager) Close(ctx context.Context) error {
	m.cancel()
	m.done.Wait()
	m.mu.Lock()
	var procs []supervisor.Child
	for _, rt := range m.rt {
		if rt.proc != nil {
			procs = append(procs, rt.proc)
			rt.proc = nil
		}
	}
	var encodes []*encodeJob
	for _, e := range m.encodes {
		encodes = append(encodes, e)
	}
	m.mu.Unlock()
	for _, e := range encodes {
		e.job.Cancel()
	}
	var problems []error
	for _, p := range procs {
		if err := p.Stop(ctx); err != nil {
			problems = append(problems, err)
		}
	}
	for _, e := range encodes {
		select {
		case <-e.job.Done():
		case <-ctx.Done():
			problems = append(problems, fmt.Errorf("an encode did not stop: %w", ctx.Err()))
		}
	}
	return errors.Join(problems...)
}

// checkSlot refuses a number that names no slot.
func checkSlot(n int) error {
	if n < 1 || n > Count {
		return noSuchSlot(n)
	}
	return nil
}

// save writes the store as it is now; the caller does not hold m.mu.
func (m *Manager) save() {
	m.mu.Lock()
	version, content := m.store.encode()
	m.mu.Unlock()
	if err := m.store.write(version, content); err != nil {
		slog.Error("the sources could not be saved", "error", err)
	}
}

// wake asks slot n's worker to reconcile it.
func (m *Manager) wake(n int) {
	select {
	case m.rt[n-1].wake <- struct{}{}:
	default: // a reconcile is due already
	}
}

func (m *Manager) wakeAll() {
	for n := 1; n <= Count; n++ {
		m.wake(n)
	}
}

// requestSnapshot asks the loop for a snapshot now rather than at its next tick.
func (m *Manager) requestSnapshot() {
	select {
	case m.refresh <- struct{}{}:
	default:
	}
}

func (m *Manager) worker(n int) {
	defer m.done.Done()
	rt := m.rt[n-1]
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-rt.wake:
			m.reconcile(n)
		}
	}
}
