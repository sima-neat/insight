package library

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
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
	"insight/internal/supervisor"
)

// fakeFiles are slots: using says which slots use which library path.
type fakeFiles struct {
	mu         sync.Mutex
	using      map[string][]int
	restartErr map[int]error
	restarted  []int
	unassigned []int
	// atRestart, when set, is called with each restart's slots, to look at the library then.
	atRestart func(slots []int)
}

func newFakeFiles() *fakeFiles {
	return &fakeFiles{using: map[string][]int{}, restartErr: map[int]error{}}
}

func (f *fakeFiles) use(path string, slots ...int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.using[path] = slots
}

func (f *fakeFiles) SlotsUsing(path string) []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.using[path])
}

func (f *fakeFiles) Restart(_ context.Context, slots []int) []error {
	f.mu.Lock()
	at := f.atRestart
	errs := make([]error, len(slots))
	for i, n := range slots {
		errs[i] = f.restartErr[n]
	}
	f.restarted = append(f.restarted, slots...)
	f.mu.Unlock()
	if at != nil {
		at(slots)
	}
	return errs
}

func (f *fakeFiles) Unassign(slots []int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unassigned = append(f.unassigned, slots...)
}

func (f *fakeFiles) calls() (restarted, unassigned []int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.restarted), slices.Clone(f.unassigned)
}

// fakeProbes answer probes by a file's base name: a video of the given Info, else a file with
// no video stream; gaps are its keyframe gaps.
type fakeProbes struct {
	mu     sync.Mutex
	byName map[string]media.Info
	gaps   map[string]time.Duration
	calls  int
}

func newFakeProbes() *fakeProbes {
	return &fakeProbes{byName: map[string]media.Info{}, gaps: map[string]time.Duration{}}
}

func (p *fakeProbes) set(name string, info media.Info) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.byName[name] = info
}

func (p *fakeProbes) probe(_ context.Context, abs string) (media.Info, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	info, ok := p.byName[filepath.Base(abs)]
	if !ok {
		return media.Info{Kind: media.KindUnknown}, nil
	}
	if info.Problem != "" {
		return media.Info{}, errors.New(info.Problem)
	}
	return info, nil
}

func (p *fakeProbes) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

func (p *fakeProbes) keyframes(_ context.Context, abs string) (time.Duration, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.gaps[filepath.Base(abs)], nil
}

// h264 is a video the board streams well.
func h264() media.Info {
	return media.Info{Kind: media.KindVideo, Codec: media.CodecH264, CodecName: "H.264",
		Profile: "High", PixelFormat: "yuv420p", Width: 1920, Height: 1080, FPS: 30,
		Duration: time.Second}
}

// bframes is a video a board streams badly.
func bframes() media.Info {
	info := h264()
	info.HasBFrames = true
	return info
}

type fixture struct {
	lib    *Library
	root   string
	files  *fakeFiles
	probes *fakeProbes
	jobs   *jobs.Runner
}

// newFixture makes a library in a new media folder with fake slots and probes; change adjusts
// its options before it is made.
func newFixture(t *testing.T, change func(*Options)) *fixture {
	t.Helper()
	root := filepath.Join(t.TempDir(), "media")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	f := &fixture{root: root, files: newFakeFiles(), probes: newFakeProbes(), jobs: jobs.New(JobLimits())}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = f.jobs.Shutdown(ctx)
	})
	sup, err := supervisor.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sup.StopAll(context.Background()) })
	opts := Options{
		Start:     sup.Starter(),
		Root:      root,
		Cache:     media.NewCache(t.Context(), f.probes.probe),
		Probe:     f.probes.probe,
		Keyframes: f.probes.keyframes,
		Jobs:      f.jobs,
		Files:     f.files,
	}
	if change != nil {
		change(&opts)
	}
	lib, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	f.lib = lib
	return f
}

// write makes the file at the library path rel with content.
func (f *fixture) write(t *testing.T, rel, content string) string {
	t.Helper()
	abs := filepath.Join(f.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return abs
}

// read is the content of the library file at rel, "" when there is none.
func (f *fixture) read(t *testing.T, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.root, filepath.FromSlash(rel)))
	if errors.Is(err, os.ErrNotExist) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// noStages fails when a staging folder is left in the media folder.
func (f *fixture) noStages(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		entries, err := os.ReadDir(f.root)
		if err != nil {
			t.Fatal(err)
		}
		left := ""
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), stagePrefix) {
				left = e.Name()
			}
		}
		if left == "" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("a staging folder is left: %s", left)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// uploadRequest makes a multipart upload of content as name, with fields before the file.
func uploadRequest(t *testing.T, name string, content []byte, fields ...string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for i := 0; i+1 < len(fields); i += 2 {
		if err := form.WriteField(fields[i], fields[i+1]); err != nil {
			t.Fatal(err)
		}
	}
	if name != "" || content != nil {
		part, err := form.CreateFormFile("file", name)
		if err != nil {
			t.Fatal(err)
		}
		part.Write(content)
	}
	form.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/media/uploads", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	return req
}

// upload uploads content as name with on_conflict mode ("" sends none).
func (f *fixture) upload(t *testing.T, name string, content []byte, mode string) (UploadResult, error) {
	t.Helper()
	var fields []string
	if mode != "" {
		fields = []string{"on_conflict", mode}
	}
	return f.lib.Upload(httptest.NewRecorder(), uploadRequest(t, name, content, fields...))
}

// save uploads as upload does and returns what was saved, after the job when there is one.
func (f *fixture) save(t *testing.T, name string, content []byte, mode string) *Saved {
	t.Helper()
	result, err := f.upload(t, name, content, mode)
	return saved(t, result, err)
}

// saved waits for an upload's job when it has one and returns what was saved.
func saved(t *testing.T, result UploadResult, err error) *Saved {
	t.Helper()
	if err != nil {
		t.Fatalf("upload failed: %v", err)
	}
	if result.Job == nil {
		return result.Saved
	}
	snapshot := waitJob(t, result.Job)
	if snapshot.State != jobs.Done {
		t.Fatalf("the job ended %s: %s", snapshot.State, snapshot.Error)
	}
	return snapshot.Result.(*Saved)
}

func waitJob(t *testing.T, job *jobs.Job) jobs.Snapshot {
	t.Helper()
	select {
	case <-job.Done():
	case <-time.After(20 * time.Second):
		t.Fatalf("job %s did not finish", job.ID())
	}
	return job.Snapshot()
}

// code is err's library error code, "" for none.
func code(err error) string {
	var e *apierr.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// fakeFFmpeg writes a script standing in for ffmpeg: it reports progress and copies its input
// to its output with "+encoded" after it; with fail it reports an error and exits 1; with hang
// it waits until it is killed.
func fakeFFmpeg(t *testing.T, behavior string) string {
	t.Helper()
	script := `#!/bin/sh
in=""; out=""; prev=""
for a in "$@"; do
	if [ "$prev" = "-i" ]; then in="${a#file:}"; fi
	prev="$a"; out="${a#file:}"
done
echo "out_time_us=500000"
echo "progress=continue"
`
	switch behavior {
	case "fail":
		script += "echo 'Error while opening encoder' >&2\nexit 1\n"
	case "hang":
		script += "exec sleep 60\n"
	default:
		script += `cat "$in" > "$out" && printf '+encoded' >> "$out"
echo "out_time_us=1000000"
echo "progress=end"
`
	}
	path := filepath.Join(t.TempDir(), "ffmpeg")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
