package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// Every producer in these tests is a shell script started here, given a file of its own as $1;
// no test signals anything it did not start.

// numbered prints a numbered picture every 20 ms: FF D8, four digits, FF D9.
const numbered = `i=0
while :; do
	printf '%s\r\nContent-type: image/jpeg\r\nContent-length: 8\r\n\r\n\377\330%04d\377\331\r\n' --frame $i
	i=$((i+1))
	sleep 0.02
done`

type fake struct {
	sh     string
	script string
	dir    string

	starts  atomic.Int32
	mu      sync.Mutex
	sources []string
}

func (f *fake) start(key, source string) (*exec.Cmd, error) {
	n := f.starts.Add(1)
	f.mu.Lock()
	f.sources = append(f.sources, source)
	f.mu.Unlock()
	file := filepath.Join(f.dir, fmt.Sprintf("%s-%d", key, n))
	return exec.Command(f.sh, "-c", f.script, "producer", file), nil
}

// newRelays makes relays whose producers run script; they are closed when the test ends.
func newRelays(t *testing.T, opts Options, script string) (*Relays, *fake) {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	f := &fake{sh: sh, script: script, dir: t.TempDir()}
	if opts.Start == nil {
		opts.Start = f.start
	}
	relays, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(relays.Close)
	return relays, f
}

// serve serves ?key= from relays; the relays close before the server, so its streams end.
func serve(t *testing.T, relays *Relays) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		relays.Serve(w, req, req.URL.Query().Get("key"), "the source")
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(relays.Close)
	return srv
}

var client = &http.Client{Timeout: 20 * time.Second}

type reader struct {
	t      *testing.T
	resp   *http.Response
	parts  *multipart.Reader
	cancel context.CancelFunc
}

// open starts reading key's stream and expects it to begin.
func open(t *testing.T, srv *httptest.Server, key string) *reader {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/?key="+key, nil)
	resp, err := client.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		cancel()
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	mediaType, params, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/x-mixed-replace" || params["boundary"] != Boundary {
		t.Fatalf("Content-Type %q", resp.Header.Get("Content-Type"))
	}
	r := &reader{t: t, resp: resp, parts: multipart.NewReader(resp.Body, params["boundary"]), cancel: cancel}
	t.Cleanup(r.close)
	return r
}

// next reads the next picture.
func (r *reader) next() ([]byte, error) {
	part, err := r.parts.NextPart()
	if err != nil {
		return nil, err
	}
	jpeg, err := io.ReadAll(part)
	if err == nil && (len(jpeg) < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8) {
		err = fmt.Errorf("not a JPEG: %q", jpeg)
	}
	return jpeg, err
}

// number reads the next picture of a numbered stream and returns its number.
func (r *reader) number() int {
	r.t.Helper()
	jpeg, err := r.next()
	if err != nil {
		r.t.Fatal(err)
	}
	return pictureNumber(r.t, jpeg)
}

func (r *reader) close() {
	r.cancel()
	r.resp.Body.Close()
}

func pictureNumber(t *testing.T, jpeg []byte) int {
	t.Helper()
	n, err := strconv.Atoi(string(jpeg[2 : len(jpeg)-2]))
	if err != nil {
		t.Fatalf("picture %q", jpeg)
	}
	return n
}

// apiError reads a refusal: its status and the error shape's code and hint.
func apiError(t *testing.T, srv *httptest.Server, key string) (int, string, string) {
	t.Helper()
	resp, err := client.Get(srv.URL + "/?key=" + key)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("status %d, Content-Type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	var body struct {
		Error struct{ Code, Message, Hint string }
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, body.Error.Code, body.Error.Hint
}

func eventually(t *testing.T, within time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("not within %v: %s", within, what)
}

// alive says whether pid still runs; signal 0 only checks.
func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func readersOf(r *Relays, key string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s := r.streams[key]; s != nil {
		return s.readers
	}
	return 0
}

func liveStreams(r *Relays) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.live
}

// producerPID returns the PID of key's running producer.
func producerPID(t *testing.T, r *Relays, key string) int {
	t.Helper()
	r.mu.Lock()
	s := r.streams[key]
	r.mu.Unlock()
	if s == nil {
		t.Fatalf("%s is not running", key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc == nil {
		t.Fatalf("%s has no producer", key)
	}
	return s.proc.pid
}

func TestNewChecksItsOptions(t *testing.T) {
	start := func(string, string) (*exec.Cmd, error) { return nil, nil }
	for _, opts := range []Options{
		{MaxRelays: 0, StallTimeout: time.Second, Start: start},
		{MaxRelays: 1, IdleStop: -1, StallTimeout: time.Second, Start: start},
		{MaxRelays: 1, Start: start},
		{MaxRelays: 1, StallTimeout: time.Second},
	} {
		if _, err := New(opts); err == nil {
			t.Errorf("%+v was accepted", opts)
		}
	}
}

func TestReadersShareOneProducer(t *testing.T) {
	relays, f := newRelays(t, Options{MaxRelays: 4, IdleStop: time.Second, StallTimeout: 2 * time.Second}, numbered)
	srv := serve(t, relays)

	a := open(t, srv, "a")
	first := a.number()
	b := open(t, srv, "a")
	// b begins with the latest picture, so it starts where a is, not at the beginning.
	if n := b.number(); n < first {
		t.Errorf("b began at picture %d, before a's %d", n, first)
	}
	for range 5 {
		a.number()
		b.number()
	}
	if f.starts.Load() != 1 || liveStreams(relays) != 1 || readersOf(relays, "a") != 2 {
		t.Errorf("%d starts, %d streams, %d readers", f.starts.Load(), liveStreams(relays), readersOf(relays, "a"))
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sources) != 1 || f.sources[0] != "the source" {
		t.Errorf("sources %q", f.sources)
	}
}

func TestProducerRunsOnBrieflyAfterTheLastReader(t *testing.T) {
	relays, f := newRelays(t, Options{MaxRelays: 4, IdleStop: 400 * time.Millisecond, StallTimeout: 2 * time.Second}, numbered)
	srv := serve(t, relays)

	a := open(t, srv, "a")
	a.number()
	pid := producerPID(t, relays, "a")
	a.close()
	eventually(t, 2*time.Second, "a has left", func() bool { return readersOf(relays, "a") == 0 })

	// A reader that comes back within IdleStop finds the producer running.
	b := open(t, srv, "a")
	b.number()
	if f.starts.Load() != 1 || producerPID(t, relays, "a") != pid {
		t.Fatalf("a second producer started")
	}
	b.close()
	eventually(t, 3*time.Second, "the producer stops", func() bool { return !alive(pid) && liveStreams(relays) == 0 })

	// The next reader starts a new one.
	c := open(t, srv, "a")
	c.number()
	if f.starts.Load() != 2 {
		t.Errorf("%d starts", f.starts.Load())
	}
}

func TestTheCapCountsStreamsNotReaders(t *testing.T) {
	relays, _ := newRelays(t, Options{MaxRelays: 1, IdleStop: 0, StallTimeout: 2 * time.Second}, numbered)
	srv := serve(t, relays)

	a1 := open(t, srv, "a")
	a1.number()
	a2 := open(t, srv, "a") // a second reader of a running stream is no further stream
	a2.number()
	status, code, _ := apiError(t, srv, "b")
	if status != http.StatusTooManyRequests || code != "too_many_streams" {
		t.Errorf("b: %d %s", status, code)
	}

	a1.close()
	a2.close()
	eventually(t, 3*time.Second, "a's stream stops", func() bool { return liveStreams(relays) == 0 })
	open(t, srv, "b").number()
}

func TestAStallEndsTheStreamItsReadersAndItsGroup(t *testing.T) {
	// Two pictures, then nothing; a child in the producer's group must go with it.
	script := `printf '%s\r\nContent-length: 6\r\n\r\n\377\33001\377\331\r\n%s\r\nContent-length: 6\r\n\r\n\377\33002\377\331\r\n' --frame --frame
sleep 60 & echo $! > "$1"
wait`
	relays, f := newRelays(t, Options{MaxRelays: 4, IdleStop: time.Second, StallTimeout: 300 * time.Millisecond}, script)
	srv := serve(t, relays)

	r := open(t, srv, "a")
	r.number()
	pid := producerPID(t, relays, "a")
	var child int
	eventually(t, 2*time.Second, "the script names its child", func() bool {
		content, err := os.ReadFile(filepath.Join(f.dir, "a-1"))
		child, _ = strconv.Atoi(strings.TrimSpace(string(content)))
		return err == nil && child > 0
	})

	began := time.Now()
	for {
		if _, err := r.next(); err != nil {
			break
		}
	}
	if waited := time.Since(began); waited > 2*time.Second {
		t.Errorf("the response ended after %v", waited)
	}
	eventually(t, 3*time.Second, "the producer and its child are gone", func() bool {
		return !alive(pid) && !alive(child) && liveStreams(relays) == 0
	})
}

func TestAStallBeforeTheFirstPictureIsAnError(t *testing.T) {
	relays, _ := newRelays(t, Options{MaxRelays: 4, StallTimeout: 300 * time.Millisecond}, `exec sleep 60`)
	srv := serve(t, relays)
	status, code, _ := apiError(t, srv, "a")
	if status != http.StatusGatewayTimeout || code != "stream_stalled" {
		t.Errorf("%d %s", status, code)
	}
	eventually(t, 3*time.Second, "the producer stops", func() bool { return liveStreams(relays) == 0 })
}

func TestAProducerThatFailsIsAnError(t *testing.T) {
	relays, _ := newRelays(t, Options{MaxRelays: 4, StallTimeout: 5 * time.Second},
		`echo "the source cannot be opened" >&2; exit 1`)
	srv := serve(t, relays)
	status, code, hint := apiError(t, srv, "a")
	if status != http.StatusBadGateway || code != "stream_failed" || hint != "the source cannot be opened" {
		t.Errorf("%d %s %q", status, code, hint)
	}
	if liveStreams(relays) != 0 {
		t.Errorf("%d streams", liveStreams(relays))
	}
}

func TestAStartThatFailsIsAnError(t *testing.T) {
	relays, _ := newRelays(t, Options{MaxRelays: 1, StallTimeout: time.Second,
		Start: func(string, string) (*exec.Cmd, error) { return nil, errors.New("no such slot") }}, "")
	srv := serve(t, relays)
	status, code, hint := apiError(t, srv, "a")
	if status != http.StatusBadGateway || code != "stream_failed" || hint != "no such slot" {
		t.Errorf("%d %s %q", status, code, hint)
	}
	// It took no place under the cap.
	status, _, _ = apiError(t, srv, "b")
	if status != http.StatusBadGateway || liveStreams(relays) != 0 {
		t.Errorf("b: %d, %d streams", status, liveStreams(relays))
	}
}

// stuckWriter is a reader whose writes after its first picture block until release is closed.
type stuckWriter struct {
	header  http.Header
	release chan struct{}
	mu      sync.Mutex
	parts   [][]byte
}

func (w *stuckWriter) Header() http.Header { return w.header }
func (w *stuckWriter) WriteHeader(int)     {}
func (w *stuckWriter) Flush()              {}

func (w *stuckWriter) Write(b []byte) (int, error) {
	if string(b) == openingBoundary {
		return len(b), nil
	}
	w.mu.Lock()
	first := len(w.parts) == 0
	w.mu.Unlock()
	if !first {
		<-w.release
	}
	w.mu.Lock()
	w.parts = append(w.parts, bytes.Clone(b))
	w.mu.Unlock()
	return len(b), nil
}

func (w *stuckWriter) written() [][]byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([][]byte(nil), w.parts...)
}

func TestASlowReaderSkipsPicturesAndHoldsBackNoOne(t *testing.T) {
	relays, _ := newRelays(t, Options{MaxRelays: 4, IdleStop: time.Second, StallTimeout: 2 * time.Second}, numbered)
	srv := serve(t, relays)

	slow := &stuckWriter{header: http.Header{}, release: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan struct{})
	go func() {
		defer close(served)
		relays.Serve(slow, httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx), "a", "the source")
	}()
	eventually(t, 2*time.Second, "the slow reader takes its first picture", func() bool { return len(slow.written()) == 1 })

	fast := open(t, srv, "a")
	first := fast.number()
	var last int
	for range 10 {
		last = fast.number()
	}
	if last < first+10 {
		t.Errorf("the fast reader got pictures %d to %d", first, last)
	}

	close(slow.release)
	eventually(t, 2*time.Second, "the slow reader takes the latest picture", func() bool { return len(slow.written()) >= 3 })
	cancel()
	<-served
	parts := slow.written()
	numbers := make([]int, 0, len(parts))
	for _, part := range parts {
		_, jpeg, _ := bytes.Cut(part, []byte("\r\n\r\n"))
		numbers = append(numbers, pictureNumber(t, bytes.TrimSuffix(jpeg, []byte("\r\n"+openingBoundary))))
	}
	// Its first write blocked; the next picture it got was one of the latest, not the one after.
	if numbers[2] <= numbers[0]+2 {
		t.Errorf("the slow reader got pictures %v", numbers)
	}
}

func TestAReaderThatStopsReadingIsDropped(t *testing.T) {
	// Pictures of 1 MiB fill a reader's socket buffers in a few pictures.
	script := `while :; do
	printf '%s\r\nContent-length: 1048580\r\n\r\n\377\330' --frame
	head -c 1048576 /dev/zero
	printf '\377\331\r\n'
	sleep 0.05
done`
	relays, _ := newRelays(t, Options{MaxRelays: 4, IdleStop: time.Second, StallTimeout: time.Second}, script)
	srv := serve(t, relays)

	fast := open(t, srv, "a")
	reading := make(chan struct{})
	go func() {
		defer close(reading)
		for {
			if _, err := fast.next(); err != nil {
				return
			}
		}
	}()

	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.(*net.TCPConn).SetReadBuffer(4096)
	if _, err := fmt.Fprintf(conn, "GET /?key=a HTTP/1.1\r\nHost: relay\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	// It never reads.
	eventually(t, 3*time.Second, "both readers watch", func() bool { return readersOf(relays, "a") == 2 })
	eventually(t, 10*time.Second, "the stuck reader is dropped", func() bool { return readersOf(relays, "a") == 1 })

	fast.close()
	<-reading
}

func TestCloseStopsEveryStream(t *testing.T) {
	relays, _ := newRelays(t, Options{MaxRelays: 4, IdleStop: time.Minute, StallTimeout: 2 * time.Second}, numbered)
	srv := serve(t, relays)

	a, b := open(t, srv, "a"), open(t, srv, "b")
	a.number()
	b.number()
	pids := []int{producerPID(t, relays, "a"), producerPID(t, relays, "b")}
	b.close() // an idle stream, waiting for its stop, goes too
	eventually(t, 2*time.Second, "b has left", func() bool { return readersOf(relays, "b") == 0 })

	relays.Close()
	for _, pid := range pids {
		if alive(pid) {
			t.Errorf("producer %d still runs", pid)
		}
	}
	for {
		if _, err := a.next(); err != nil {
			break
		}
	}
	if status, code, _ := apiError(t, srv, "a"); status != http.StatusServiceUnavailable || code != "shutting_down" {
		t.Errorf("after Close: %d %s", status, code)
	}
}

func TestTailKeepsTheLastLines(t *testing.T) {
	var tl tail
	fmt.Fprint(&tl, "one\ntwo\n\n  three  \nfour\nfive\nsix")
	if got := strings.Join(tl.last(), "|"); got != "two|three|four|five|six" {
		t.Errorf("lines %q", got)
	}
	fmt.Fprint(&tl, strings.Repeat("x", 2*maxStderrLine)+"\n")
	if lines := tl.last(); len(lines[len(lines)-1]) != maxStderrLine {
		t.Errorf("a long line kept %d bytes", len(lines[len(lines)-1]))
	}
}
