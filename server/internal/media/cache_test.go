package media

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakeProber answers every probe with a video of the file's base name as codec, or with fail's
// error for the paths in it. While hold is set it waits for release before answering.
type fakeProber struct {
	mu      sync.Mutex
	calls   map[string]int
	running int
	most    int
	fail    map[string]error
	hold    bool
	release chan struct{}
	started chan string
}

func newFakeProber() *fakeProber {
	return &fakeProber{
		calls:   map[string]int{},
		fail:    map[string]error{},
		release: make(chan struct{}),
		started: make(chan string, 100),
	}
}

func (f *fakeProber) probe(ctx context.Context, abs string) (Info, error) {
	f.mu.Lock()
	f.calls[abs]++
	f.running++
	f.most = max(f.most, f.running)
	hold, err := f.hold, f.fail[abs]
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.running--
		f.mu.Unlock()
	}()
	f.started <- abs
	if hold {
		select {
		case <-f.release:
		case <-ctx.Done():
			return Info{}, ctx.Err()
		}
	}
	if err != nil {
		return Info{}, err
	}
	return Info{Kind: KindVideo, Codec: filepath.Base(abs)}, nil
}

func (f *fakeProber) callsOf(abs string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[abs]
}

// eventually waits up to 5 s for Get to answer for abs.
func eventually(t *testing.T, c *Cache, abs string) Info {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if info, ok := c.Get(abs); ok {
			return info
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("no probe result for %s", abs)
	return Info{}
}

// idle waits up to 5 s until the cache has no workers left.
func idle(t *testing.T, c *Cache) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		workers := c.workers
		c.mu.Unlock()
		if workers == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("the cache's workers did not stop")
}

func TestCacheProbesOnceWhileTheFileStaysTheSame(t *testing.T) {
	fake := newFakeProber()
	c := NewCache(t.Context(), fake.probe)
	path := writeFile(t, t.TempDir(), "clip.mp4", "x")

	if _, ok := c.Get(path); ok {
		t.Fatal("Get answered before any probe")
	}
	c.Want(path)
	if info := eventually(t, c, path); info.Codec != "clip.mp4" {
		t.Fatalf("Get = %+v", info)
	}
	idle(t, c)
	c.Want(path)
	idle(t, c)
	if n := fake.callsOf(path); n != 1 {
		t.Fatalf("probed %d times, want 1", n)
	}

	// New content and a new modification time: the result no longer holds.
	if err := os.WriteFile(path, []byte("longer"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Get(path); ok {
		t.Fatal("Get answered for a file that changed")
	}
	c.Want(path)
	eventually(t, c, path)
	if n := fake.callsOf(path); n != 2 {
		t.Fatalf("probed %d times, want 2", n)
	}
}

func TestCacheQueuesAFileOnce(t *testing.T) {
	fake := newFakeProber()
	fake.hold = true
	c := NewCache(t.Context(), fake.probe)
	path := writeFile(t, t.TempDir(), "clip.mp4", "x")

	c.Want(path)
	<-fake.started
	c.Want(path) // while it is being probed
	close(fake.release)
	eventually(t, c, path)
	idle(t, c)
	if n := fake.callsOf(path); n != 1 {
		t.Fatalf("probed %d times, want 1", n)
	}
}

func TestCacheRunsTwoProbesAtOnceAndGetDoesNotWait(t *testing.T) {
	fake := newFakeProber()
	fake.hold = true
	c := NewCache(t.Context(), fake.probe)
	dir := t.TempDir()
	var paths []string
	for _, name := range []string{"a.mp4", "b.mp4", "c.mp4", "d.mp4", "e.mp4", "f.mp4"} {
		path := writeFile(t, dir, name, "x")
		paths = append(paths, path)
		c.Want(path)
	}
	<-fake.started
	<-fake.started

	start := time.Now()
	for _, path := range paths {
		if _, ok := c.Get(path); ok {
			t.Fatalf("Get answered for %s while its probe waits", path)
		}
	}
	if waited := time.Since(start); waited > time.Second {
		t.Fatalf("Get took %v while probes ran", waited)
	}

	close(fake.release)
	for _, path := range paths {
		eventually(t, c, path)
	}
	idle(t, c)
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.most != probeWorkers {
		t.Fatalf("%d probes ran at once, want %d", fake.most, probeWorkers)
	}
}

func TestCacheRetriesAFailureAfterAMinute(t *testing.T) {
	fake := newFakeProber()
	c := NewCache(t.Context(), fake.probe)
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	path := writeFile(t, t.TempDir(), "broken.mp4", "xyz")
	fake.fail[path] = errors.New("ffprobe could not read broken.mp4: Invalid data")

	c.Want(path)
	info := eventually(t, c, path)
	want := Info{Kind: KindUnknown, Size: 3, Problem: "ffprobe could not read broken.mp4: Invalid data"}
	if info != want {
		t.Fatalf("Get = %+v, want %+v", info, want)
	}
	idle(t, c)

	now = now.Add(retryFailedAfter - time.Second)
	c.Want(path)
	idle(t, c)
	if n := fake.callsOf(path); n != 1 {
		t.Fatalf("probed %d times within the minute, want 1", n)
	}

	now = now.Add(2 * time.Second)
	delete(fake.fail, path)
	c.Want(path)
	idle(t, c)
	if info, _ := c.Get(path); info.Kind != KindVideo {
		t.Fatalf("after the retry Get = %+v", info)
	}
	if n := fake.callsOf(path); n != 2 {
		t.Fatalf("probed %d times, want 2", n)
	}
}

func TestCacheIgnoresMissingFiles(t *testing.T) {
	fake := newFakeProber()
	c := NewCache(t.Context(), fake.probe)
	path := filepath.Join(t.TempDir(), "gone.mp4")
	c.Want(path)
	idle(t, c)
	if _, ok := c.Get(path); ok || fake.callsOf(path) != 0 {
		t.Fatal("a missing file was probed")
	}
}

func TestCacheForgetsAFileRemovedBeforeItsProbe(t *testing.T) {
	fake := newFakeProber()
	fake.hold = true
	c := NewCache(t.Context(), fake.probe)
	dir := t.TempDir()
	first := writeFile(t, dir, "a.mp4", "x")
	second := writeFile(t, dir, "b.mp4", "x")
	third := writeFile(t, dir, "c.mp4", "x")
	c.Want(first)
	c.Want(second)
	<-fake.started
	<-fake.started
	c.Want(third) // queued behind the two held probes
	if err := os.Remove(third); err != nil {
		t.Fatal(err)
	}
	close(fake.release)
	idle(t, c)
	if fake.callsOf(third) != 0 {
		t.Fatal("a removed file was probed")
	}
}

func TestCacheStopsWithItsContext(t *testing.T) {
	fake := newFakeProber()
	fake.hold = true
	ctx, cancel := context.WithCancel(context.Background())
	c := NewCache(ctx, fake.probe)
	dir := t.TempDir()
	running := writeFile(t, dir, "a.mp4", "x")
	c.Want(running)
	c.Want(writeFile(t, dir, "b.mp4", "x"))
	queued := writeFile(t, dir, "c.mp4", "x")
	c.Want(queued)
	<-fake.started
	<-fake.started

	cancel()
	idle(t, c)
	if _, ok := c.Get(running); ok {
		t.Fatal("a probe stopped by the context left a result")
	}
	if fake.callsOf(queued) != 0 {
		t.Fatal("a queued probe ran after the context ended")
	}
	later := writeFile(t, dir, "d.mp4", "x")
	c.Want(later)
	idle(t, c)
	if fake.callsOf(later) != 0 {
		t.Fatal("Want probed after the context ended")
	}
}

func TestCacheWithFFprobe(t *testing.T) {
	ffprobe, ffmpeg := tools(t)
	path := encode(t, ffmpeg, t.TempDir(), "clip.mjpeg", "-t", "1", "-c:v", "mjpeg", "-f", "mjpeg")
	c := NewCache(t.Context(), FFprobe(ffprobe))
	c.Want(path)
	if info := eventually(t, c, path); info.Codec != CodecMJPEG || !info.Streamable() {
		t.Fatalf("Get = %+v", info)
	}
}
