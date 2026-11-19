package mediamtx

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestSnapshotCallsAndCredentials(t *testing.T) {
	fake, client := newFake(t)
	snapshot(t, client)
	var got []string
	for _, r := range fake.received() {
		if r.Method != http.MethodGet || r.Query != "itemsPerPage=1000&page=0" {
			t.Errorf("request %+v", r)
		}
		got = append(got, r.Path)
	}
	want := []string{"paths/list", "rtspsessions/list", "rtspssessions/list", "webrtcsessions/list", "srtconns/list", "rtmpconns/list", "rtmpsconns/list"}
	if !slices.Equal(got, want) {
		t.Errorf("calls %v", got)
	}
}

func TestSnapshotReadsEveryPage(t *testing.T) {
	fake, client := newFake(t)
	var many []map[string]any
	for i := range 2*pageSize + 1 {
		many = append(many, map[string]any{"name": "p" + string(rune('a'+i%26)) + strings.Repeat("x", i/26), "ready": false})
	}
	fake.set(func(f *fakeMediaMTX) { f.paths = many })
	if n := len(snapshot(t, client).Paths); n != len(many) {
		t.Fatalf("%d paths of %d", n, len(many))
	}
	pages := 0
	for _, r := range fake.received() {
		if r.Path == "paths/list" {
			pages++
		}
	}
	if pages != 3 {
		t.Errorf("%d pages", pages)
	}
}

func TestSnapshotWithoutTheSessionsOfAProtocolThatIsOff(t *testing.T) {
	// MediaMTX serves a session list only for the protocols that are on.
	fake, client := newFake(t)
	fake.set(func(f *fakeMediaMTX) {
		f.sessions = map[string][]map[string]any{"rtspsessions": testSessions["rtspsessions"]}
	})
	snap := snapshot(t, client)
	if src2 := snap.Paths["src2"]; !src2.External() || src2.Source.Protocol != "rtsp" || src2.Source.Address != "172.19.0.1" {
		t.Errorf("src2 %+v", *src2.Source)
	}
	if src3 := snap.Paths["src3"]; src3.Source.Protocol != "srt" || src3.Source.Address != "" {
		t.Errorf("src3 %+v", *src3.Source)
	}
}

func TestSnapshotUnavailable(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*fakeMediaMTX)
		status int
	}{
		{"a path list that is not found", func(f *fakeMediaMTX) { f.status["paths/list"] = 404 }, 404},
		{"a failing path list", func(f *fakeMediaMTX) { f.status["paths/list"] = 500 }, 500},
		{"a failing session list", func(f *fakeMediaMTX) { f.status["srtconns/list"] = 500 }, 500},
		{"another password", func(f *fakeMediaMTX) { f.password = "other" }, 401},
		{"an answer that is not JSON", func(f *fakeMediaMTX) {
			f.status["paths/list"], f.body["paths/list"] = 200, "<html>"
		}, 200},
		{"a list without items", func(f *fakeMediaMTX) {
			f.status["paths/list"], f.body["paths/list"] = 200, `{"pageCount": 1}`
		}, 200},
		{"items of another shape", func(f *fakeMediaMTX) {
			f.status["paths/list"], f.body["paths/list"] = 200, `{"pageCount": 1, "items": ["x"]}`
		}, 200},
		{"a path without a name", func(f *fakeMediaMTX) { f.paths = []map[string]any{{"no": "name"}} }, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake, client := newFake(t)
			fake.set(tc.change)
			_, err := client.Snapshot(context.Background())
			var apiErr *Error
			if !errors.Is(err, ErrUnavailable) || !errors.As(err, &apiErr) || apiErr.Status != tc.status {
				t.Fatalf("error %v", err)
			}
		})
	}
}

func TestACallThatTakesTooLongEnds(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) })
	client := NewClient(server.URL, testSecrets)
	client.timeout = 50 * time.Millisecond

	for name, call := range map[string]func() error{
		"snapshot":   func() error { _, err := client.Snapshot(context.Background()); return err },
		"kick":       func() error { return client.Kick(context.Background(), "rtspSession", "x") },
		"set a pull": func() error { return client.SetPullSource(context.Background(), "src1", "rtsp://cam/x") },
		"clear":      func() error { return client.ClearPullSource(context.Background(), "src1") },
	} {
		t.Run(name, func(t *testing.T) {
			start := time.Now()
			err := call()
			if !errors.Is(err, ErrUnavailable) || !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("error %v", err)
			}
			if took := time.Since(start); took > time.Second {
				t.Errorf("took %v", took)
			}
		})
	}
}

func TestACallToAnAPIThatIsNotListening(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	client := NewClient("http://"+address, testSecrets)
	_, err = client.Snapshot(context.Background())
	if !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), testSecrets.APIPassword) {
		t.Fatalf("error %v", err)
	}
}

func TestACancelledCallSaysSo(t *testing.T) {
	_, client := newFake(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Snapshot(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("error %v", err)
	}
}

func TestKick(t *testing.T) {
	fake, client := newFake(t)
	ctx := context.Background()
	for _, tc := range []struct{ sessionType, id, endpoint string }{
		{"rtspSession", "pub-2", "rtspsessions/kick/pub-2"},
		{"srtConn", "pub-3", "srtconns/kick/pub-3"},
		{"webRTCSession", "pub-4", "webrtcsessions/kick/pub-4"},
		// An id is one path segment, escaped (the fake sees the path decoded).
		{"rtmpsConn", "a/b", "rtmpsconns/kick/a/b"},
	} {
		if err := client.Kick(ctx, tc.sessionType, tc.id); err != nil {
			t.Fatalf("%s: %v", tc.sessionType, err)
		}
		received := fake.received()
		if last := received[len(received)-1]; last.Method != http.MethodPost || last.Path != tc.endpoint {
			t.Errorf("%s: request %+v", tc.sessionType, last)
		}
	}

	fake.set(func(f *fakeMediaMTX) { f.status["rtspsessions/kick/gone"] = 404 })
	if err := client.Kick(ctx, "rtspSession", "gone"); !errors.Is(err, ErrNotFound) {
		t.Errorf("a session that ended: %v", err)
	}
	before := len(fake.received())
	for _, sessionType := range []string{"futureConn", "rtspSource", ""} {
		if err := client.Kick(ctx, sessionType, "x"); err == nil || errors.Is(err, ErrNotFound) || errors.Is(err, ErrUnavailable) {
			t.Errorf("kicking a %q: %v", sessionType, err)
		}
	}
	if len(fake.received()) != before {
		t.Error("an unkickable type still reached MediaMTX")
	}
}

func TestSetAndClearPullSource(t *testing.T) {
	fake, client := newFake(t)
	ctx := context.Background()
	if err := client.SetPullSource(ctx, "src3", "rtsp://u:p@10.0.0.5:554/x"); err != nil {
		t.Fatal(err)
	}
	if err := client.ClearPullSource(ctx, "src3"); err != nil {
		t.Fatal(err)
	}
	got := fake.received()
	if len(got) != 2 {
		t.Fatalf("requests %+v", got)
	}
	for i, want := range []map[string]any{
		{"source": "rtsp://u:p@10.0.0.5:554/x", "sourceOnDemand": false, "rtspTransport": "tcp"},
		{"source": "publisher"},
	} {
		r := got[i]
		if r.Method != http.MethodPatch || r.Path != "config/paths/patch/src3" || r.ContentType != "application/json" || !sameBody(r.Body, want) {
			t.Errorf("request %+v", r)
		}
	}
}

func sameBody(got, want map[string]any) bool {
	if len(got) != len(want) {
		return false
	}
	for k, v := range want {
		if got[k] != v {
			return false
		}
	}
	return true
}

func TestSetPullSourceErrorsNeverRepeatTheURL(t *testing.T) {
	const source = "rtsp://admin:hunter2@10.0.0.5:554/x"
	fake, client := newFake(t)
	fake.set(func(f *fakeMediaMTX) {
		f.status["config/paths/patch/src3"] = 400
		f.body["config/paths/patch/src3"] = `{"error":"invalid source: '` + source + `' (password hunter2)"}`
	})
	err := client.SetPullSource(context.Background(), "src3", source)
	var apiErr *Error
	if !errors.Is(err, ErrRejected) || !errors.As(err, &apiErr) || apiErr.Status != 400 {
		t.Fatalf("error %v", err)
	}
	if strings.Contains(err.Error(), "hunter2") || !strings.Contains(err.Error(), "invalid source") {
		t.Errorf("message %q", err.Error())
	}

	fake.set(func(f *fakeMediaMTX) { f.status["config/paths/patch/src9"] = 404 })
	if err := client.SetPullSource(context.Background(), "src9", source); !errors.Is(err, ErrNotFound) {
		t.Errorf("a path MediaMTX lacks: %v", err)
	}
}

func TestClearPullSourceOfAPathMediaMTXLacks(t *testing.T) {
	fake, client := newFake(t)
	fake.set(func(f *fakeMediaMTX) { f.status["config/paths/patch/src3"] = 404 })
	if err := client.ClearPullSource(context.Background(), "src3"); err != nil {
		t.Fatal(err)
	}
	fake.set(func(f *fakeMediaMTX) { f.status["config/paths/patch/src3"] = 500 })
	if err := client.ClearPullSource(context.Background(), "src3"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("error %v", err)
	}
}

func TestErrorText(t *testing.T) {
	for _, tc := range []struct {
		err  *Error
		want string
	}{
		{&Error{Call: "list paths", Status: 500, Message: "boom", Kind: ErrUnavailable}, "mediamtx: list paths: 500: boom"},
		{&Error{Call: "list paths", Message: "connection refused", Kind: ErrUnavailable}, "mediamtx: list paths: connection refused"},
		{&Error{Call: "kick rtspSession x", Status: 404, Kind: ErrNotFound}, "mediamtx: kick rtspSession x: 404"},
	} {
		if got := tc.err.Error(); got != tc.want {
			t.Errorf("got %q, want %q", got, tc.want)
		}
	}
	if got := errorMessage([]byte(strings.Repeat("x", 300))); len(got) > 210 {
		t.Errorf("a long answer gave %d bytes", len(got))
	}
}
