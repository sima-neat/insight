package slots

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"insight/internal/apierr"
	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/mediamtx"
	"insight/internal/supervisor"
)

const testPublisherQuery = "publisher=insight-0123456789abcdef"

// fakeMTX is MediaMTX's API: a snapshot the test sets, and the calls the slots made.
type fakeMTX struct {
	mu    sync.Mutex
	paths map[string]mediamtx.Path
	down  bool
	calls []string
	// hold, when set, makes the next Snapshot answer only once it is closed, with the paths it
	// read when it was called: a slow answer that lands after later ones.
	hold chan struct{}
	// setErr is what SetPullSource answers.
	setErr error
}

func newFakeMTX() *fakeMTX {
	f := &fakeMTX{paths: map[string]mediamtx.Path{}}
	for n := 1; n <= Count; n++ {
		f.paths[pathName(n)] = mediamtx.Path{Name: pathName(n), Readers: []mediamtx.Reader{}}
	}
	return f
}

func (f *fakeMTX) Snapshot(context.Context) (mediamtx.Snapshot, error) {
	snap, hold, err := f.read()
	if hold != nil {
		<-hold
	}
	return snap, err
}

// holding is whether a held Snapshot has not been called yet.
func (f *fakeMTX) holding() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hold != nil
}

func (f *fakeMTX) read() (mediamtx.Snapshot, chan struct{}, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	hold := f.hold
	f.hold = nil
	if f.down {
		return mediamtx.Snapshot{}, hold, &mediamtx.Error{Call: "list paths", Kind: mediamtx.ErrUnavailable}
	}
	snap := mediamtx.Snapshot{At: time.Now(), Paths: map[string]mediamtx.Path{}}
	for name, path := range f.paths {
		snap.Paths[name] = path
	}
	return snap, hold, nil
}

func (f *fakeMTX) Kick(_ context.Context, sessionType, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "kick "+sessionType+" "+id)
	for name, path := range f.paths {
		if path.Source != nil && path.Source.ID == id {
			if strings.HasPrefix(name, "cam") {
				delete(f.paths, name)
			} else {
				f.paths[name] = mediamtx.Path{Name: name, Readers: []mediamtx.Reader{}}
			}
			return nil
		}
	}
	return &mediamtx.Error{Call: "kick", Kind: mediamtx.ErrNotFound}
}

func (f *fakeMTX) SetPullSource(_ context.Context, name, source string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "set "+name+" "+source)
	if f.setErr != nil {
		return f.setErr
	}
	f.paths[name] = mediamtx.Path{Name: name, Source: &mediamtx.Source{Type: "rtspSource", Protocol: "rtspSource"}, Readers: []mediamtx.Reader{}}
	return nil
}

func (f *fakeMTX) ClearPullSource(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "clear "+name)
	f.paths[name] = mediamtx.Path{Name: name, Readers: []mediamtx.Reader{}}
	return nil
}

func (f *fakeMTX) setPath(p mediamtx.Path) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if p.Readers == nil {
		p.Readers = []mediamtx.Reader{}
	}
	f.paths[p.Name] = p
}

func (f *fakeMTX) failSets(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.setErr = err
}

func (f *fakeMTX) setDown(down bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.down = down
}

// takeCalls returns the calls made since the last takeCalls.
func (f *fakeMTX) takeCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	calls := f.calls
	f.calls = nil
	return calls
}

// publishing is srcN carried by a publisher; insight says whether it is Insight's own.
func publishing(n int, codec string, insight bool) mediamtx.Path {
	tracks := map[string]string{"h264": "H264", "h265": "H265", "mjpeg": "M-JPEG"}
	return mediamtx.Path{
		Name: pathName(n), Ready: true, ReadySince: time.Now(), Codec: codec, Tracks: []string{tracks[codec]},
		Source: &mediamtx.Source{Type: "rtspSession", ID: "session-" + pathName(n), Protocol: "rtsp", Address: "10.0.0.9", Insight: insight},
	}
}

// fakeProbes is the library's probe cache.
type fakeProbes struct {
	mu     sync.Mutex
	infos  map[string]media.Info
	wanted []string
}

func (f *fakeProbes) Get(abs string) (media.Info, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	info, ok := f.infos[abs]
	return info, ok
}

func (f *fakeProbes) Want(abs string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wanted = append(f.wanted, abs)
}

func (f *fakeProbes) wasWanted(abs string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Contains(f.wanted, abs)
}

func (f *fakeProbes) set(abs string, info media.Info) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.infos[abs] = info
}

// fakeProcess is a supervised child that runs until stopped.
type fakeProcess struct {
	spec supervisor.Spec
	mu   sync.Mutex
	st   supervisor.Status
	tail []string
	done chan struct{}
	once sync.Once
}

func (p *fakeProcess) Status() supervisor.Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.st
}

func (p *fakeProcess) Tail() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.tail...)
}

func (p *fakeProcess) Done() <-chan struct{} { return p.done }

func (p *fakeProcess) Stop(context.Context) error {
	p.exit("signal: terminated")
	return nil
}

// exit ends the child for good with how it ended.
func (p *fakeProcess) exit(how string) {
	p.once.Do(func() {
		p.mu.Lock()
		p.st.Running, p.st.LastExit = false, how
		p.mu.Unlock()
		close(p.done)
	})
}

// crash makes the child exit with lines, as a publisher the supervisor restarts after a pause.
func (p *fakeProcess) crash(lines ...string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.st.Running, p.st.LastExit = false, "exit status 1"
	p.tail = append(p.tail, lines...)
}

// fakeStarter starts fakeProcesses and keeps them.
type fakeStarter struct {
	mu      sync.Mutex
	started []*fakeProcess
	err     error
}

func (f *fakeStarter) start(spec supervisor.Spec) (supervisor.Child, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	p := &fakeProcess{spec: spec, st: supervisor.Status{Running: true, PID: 1000 + len(f.started)}, done: make(chan struct{})}
	f.started = append(f.started, p)
	return p, nil
}

// running returns the children named name that have not been stopped.
func (f *fakeStarter) running(name string) []*fakeProcess {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*fakeProcess
	for _, p := range f.started {
		select {
		case <-p.done:
		default:
			if p.spec.Name == name {
				out = append(out, p)
			}
		}
	}
	return out
}

func (f *fakeStarter) fail(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func (f *fakeStarter) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.started)
}

// fakeRelay records what it was asked to serve.
type fakeRelay struct {
	mu     sync.Mutex
	served []string
}

func (f *fakeRelay) Serve(w http.ResponseWriter, _ *http.Request, key, source string) {
	f.mu.Lock()
	f.served = append(f.served, key+" "+source)
	f.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func (f *fakeRelay) servedAll() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.served...)
}

// jobSnapshot is the job with this ID as it is now.
func jobSnapshot(r *jobs.Runner, id string) (jobs.Snapshot, bool) {
	events, unsubscribe, ok := r.Subscribe(id)
	if !ok {
		return jobs.Snapshot{}, false
	}
	defer unsubscribe()
	return <-events, true
}

// fakeEncoder writes each encode's output when the test lets it, or fails it.
type fakeEncoder struct {
	mu      sync.Mutex
	runs    []encodeRun
	release chan error // nil: finish at once
}

func (f *fakeEncoder) encode(ctx context.Context, run encodeRun, progress *jobs.Progress) error {
	f.mu.Lock()
	f.runs = append(f.runs, run)
	release := f.release
	f.mu.Unlock()
	progress.SetPercent(50)
	if release != nil {
		select {
		case err := <-release:
			if err != nil {
				return err
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return os.WriteFile(run.output, []byte("rendition"), 0o644)
}

func (f *fakeEncoder) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.runs)
}

func (f *fakeEncoder) run(i int) encodeRun {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.runs[i]
}

// fakeStreams answers stream probes by URL prefix.
type fakeStreams struct {
	mu      sync.Mutex
	answers map[string]error
	probed  []string // the stream probes, of MediaMTX's paths
	cameras []string // the camera probes
	// onProbe runs while a pull's camera probe is under way, as the world changing meanwhile.
	onProbe func()
}

func (f *fakeStreams) probe(_ context.Context, url string) (StreamInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.probed = append(f.probed, url)
	for prefix, err := range f.answers {
		if strings.HasPrefix(url, prefix) {
			return StreamInfo{Codec: "h264", Width: 1280, Height: 720, FPS: 25}, err
		}
	}
	return StreamInfo{Codec: "h264", Width: 640, Height: 480, FPS: 30}, nil
}

// camera answers a pull's camera probe by the same prefixes, and records it apart.
func (f *fakeStreams) camera(_ context.Context, url string) error {
	if f.onProbe != nil {
		f.onProbe()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cameras = append(f.cameras, url)
	for prefix, err := range f.answers {
		if strings.HasPrefix(url, prefix) {
			return err
		}
	}
	return nil
}

func (f *fakeStreams) answer(prefix string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers[prefix] = err
}

// harness is a Manager over fakes, in a temporary folder.
type harness struct {
	t       *testing.T
	m       *Manager
	root    string
	store   string
	mtx     *fakeMTX
	probes  *fakeProbes
	starter *fakeStarter
	relay   *fakeRelay
	encoder *fakeEncoder
	streams *fakeStreams
	jobs    *jobs.Runner
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	h := &harness{
		t:       t,
		root:    filepath.Join(dir, "media"),
		store:   filepath.Join(dir, "data", "sources.json"),
		mtx:     newFakeMTX(),
		probes:  &fakeProbes{infos: map[string]media.Info{}},
		starter: &fakeStarter{},
		relay:   &fakeRelay{},
		encoder: &fakeEncoder{},
		streams: &fakeStreams{answers: map[string]error{}},
		jobs:    jobs.New(map[jobs.Kind]int{RenditionJob: 1}),
	}
	if err := os.MkdirAll(h.root, 0o755); err != nil {
		t.Fatal(err)
	}
	h.open()
	return h
}

// open makes the Manager, as a start of Insight does.
func (h *harness) open() {
	h.t.Helper()
	m, err := New(Options{
		StorePath:      h.store,
		MediaRoot:      h.root,
		Probes:         h.probes,
		MediaMTX:       h.mtx,
		PublisherQuery: testPublisherQuery,
		Start:          h.starter.start,
		Jobs:           h.jobs,
		Relays:         h.relay,
		FFmpeg:         "/usr/bin/ffmpeg",
		URLs:           URLOptions{RTSPPort: 18554, WHIPPort: 18889},
		driven:         true, // settle runs the loop's and the workers' steps
		probeStream:    h.streams.probe,
		probeCamera:    h.streams.camera,
		encode:         h.encoder.encode,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	h.m = m
	h.t.Cleanup(h.close)
}

func (h *harness) close() {
	if h.m == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.m.Close(ctx); err != nil {
		h.t.Errorf("Close: %v", err)
	}
	h.m = nil
}

// reopen closes the Manager and makes a new one over the same store, as a restart does.
func (h *harness) reopen() {
	h.t.Helper()
	h.close()
	h.open()
}

// settle takes a snapshot and reconciles every slot, twice, so what one step changed in the
// fakes is seen by the next. It does not wait for the stream and pull probes a snapshot starts,
// which run on goroutines of their own: a test that needs a probe's outcome waits for it.
func (h *harness) settle() {
	h.t.Helper()
	for range 2 {
		h.m.tick()
		for n := 1; n <= Count; n++ {
			h.m.reconcile(n)
		}
	}
}

// file writes a library file and gives it a probe.
func (h *harness) file(rel string, info media.Info) string {
	h.t.Helper()
	abs := filepath.Join(h.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte("video of "+rel), 0o644); err != nil {
		h.t.Fatal(err)
	}
	if info.Kind == "" {
		info.Kind = media.KindVideo
	}
	h.probes.set(abs, info)
	return abs
}

var (
	h264Info  = media.Info{Codec: media.CodecH264, Width: 1280, Height: 720, FPS: 25, Duration: 10 * time.Second}
	h265Info  = media.Info{Codec: media.CodecH265, Width: 1920, Height: 1080, FPS: 30, Duration: 10 * time.Second}
	mjpegInfo = media.Info{Codec: media.CodecMJPEG, Width: 640, Height: 480, FPS: 15, Duration: 5 * time.Second}
	vp9Info   = media.Info{Codec: "vp9", Width: 640, Height: 480, FPS: 30}
)

func (h *harness) slot(n int) Slot {
	h.t.Helper()
	s, err := h.m.Slot(n, "insight.local:9900")
	if err != nil {
		h.t.Fatal(err)
	}
	return s
}

// publisher is slot n's one running publisher; it fails the test when there is not exactly one.
func (h *harness) publisher(n int) *fakeProcess {
	h.t.Helper()
	running := h.starter.running(pathName(n))
	if len(running) != 1 {
		h.t.Fatalf("src%d has %d publishers running", n, len(running))
	}
	return running[0]
}

func (h *harness) noPublisher(n int) {
	h.t.Helper()
	if running := h.starter.running(pathName(n)); len(running) != 0 {
		h.t.Fatalf("src%d has %d publishers running", n, len(running))
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// wantCode checks err is an *apierr.Error with code.
func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *apierr.Error
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("got %v, want an error %s", err, code)
	}
}

// eventually waits for cond, failing the test after a while.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting until %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func contains(list []string, want string) bool { return slices.Contains(list, want) }
