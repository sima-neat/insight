package sentinel

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"insight/internal/apierr"
	"insight/internal/board"
	"insight/internal/board/boardtest"
)

// fakeSentinel answers fixed bodies by method and path (query included), and records what it
// was sent.
type fakeSentinel struct {
	mu      sync.Mutex
	answers map[string]answer
	sent    []string // "POST /v1/traces {...}"
}

type answer struct {
	status int
	body   string
}

func newFake() *fakeSentinel { return &fakeSentinel{answers: map[string]answer{}} }

func (f *fakeSentinel) answer(route string, status int, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers[route] = answer{status, body}
}

func (f *fakeSentinel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body := make([]byte, 4096)
	n, _ := r.Body.Read(body)
	route := r.Method + " " + r.URL.RequestURI()
	f.mu.Lock()
	f.sent = append(f.sent, strings.TrimSpace(route+" "+string(body[:n])))
	a, ok := f.answers[route]
	f.mu.Unlock()
	if !ok {
		a = answer{http.StatusNotFound, `{"error":"no route"}`}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(a.status)
	_, _ = w.Write([]byte(a.body))
}

func (f *fakeSentinel) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.sent...)
}

func ctx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func codeOf(err error) string {
	var e *apierr.Error
	if errors.As(err, &e) {
		return e.Code
	}
	var b *board.Error
	if errors.As(err, &b) {
		return string(b.Code)
	}
	return ""
}

func TestCallDropsTheSchemaAndRefusesAnother(t *testing.T) {
	fake := newFake()
	f := boardtest.New(t, fake)
	fake.answer("GET /v1/metrics", 200, `{"schema":1,"metrics":[{"key":"cpu_usage_pct"}]}`)
	body, err := Metrics(ctx(t), f.Board)
	if err != nil {
		t.Fatal(err)
	}
	if _, has := body["schema"]; has || string(body["metrics"]) != `[{"key":"cpu_usage_pct"}]` {
		t.Errorf("body %v", body)
	}

	fake.answer("GET /v1/metrics", 200, `{"schema":2,"metrics":[]}`)
	if _, err := Metrics(ctx(t), f.Board); codeOf(err) != CodeSchema {
		t.Errorf("another schema: %v", err)
	}
	fake.answer("GET /v1/metrics", 200, `[1]`)
	if _, err := Metrics(ctx(t), f.Board); codeOf(err) != CodeFailed {
		t.Errorf("not an object: %v", err)
	}
}

func TestRefusalsKeepTheirMeaning(t *testing.T) {
	fake := newFake()
	f := boardtest.New(t, fake)
	fake.answer("GET /v1/runs/nope", 404, `{"error":"unknown run 'nope'"}`)
	_, err := Run(ctx(t), f.Board, "nope")
	var e *apierr.Error
	if !errors.As(err, &e) || e.Status != 404 || e.Code != CodeNotFound || e.Message != "unknown run 'nope'" {
		t.Errorf("an unknown run: %v", err)
	}
	// A route Sentinel does not have.
	if _, err := ActiveTrace(ctx(t), f.Board); codeOf(err) != CodeOutdated {
		t.Errorf("no route: %v", err)
	}
	fake.answer("POST /v1/traces", 409, `{"error":"a trace is already active"}`)
	if _, err := StartTrace(ctx(t), f.Board, TraceRequest{Name: "a"}); codeOf(err) != CodeTraceConflict {
		t.Errorf("conflict: %v", err)
	}
	fake.answer("GET /v1/runs", 500, `oops`)
	if _, err := Runs(ctx(t), f.Board); !errors.As(err, &e) || e.Code != CodeFailed || e.Message != "oops" {
		t.Errorf("a failure: %v", err)
	}
}

func TestAnAnswerTooLargeIsNotRead(t *testing.T) {
	fake := newFake()
	f := boardtest.New(t, fake)
	fake.answer("GET /v1/runs/big", 200, `{"schema":1,"samples":"`+strings.Repeat("x", MaxAnswer)+`"}`)
	if _, err := Run(ctx(t), f.Board, "big"); codeOf(err) != CodeAnswerTooLarge {
		t.Errorf("got %v", err)
	}
}

func TestAMissingSocketSaysWhetherSentinelIsInstalled(t *testing.T) {
	f := boardtest.New(t, nil)
	for _, c := range []struct {
		name, show, code string
	}{
		{"not installed", "LoadState=not-found\nActiveState=inactive", string(board.CodeSentinelMissing)},
		{"stopped", "LoadState=loaded\nActiveState=failed", CodeStopped},
		{"no systemd", "", string(board.CodeSentinelMissing)},
	} {
		t.Run(c.name, func(t *testing.T) {
			f.Program(t, "systemctl", "printf '%s\\n' '"+strings.ReplaceAll(c.show, "\n", "' '")+"'")
			_, err := ReadHealth(ctx(t), f.Board)
			if codeOf(err) != c.code {
				t.Errorf("got %v, want %s", err, c.code)
			}
		})
	}
}

func TestHealthSaysWhenTheServiceStarted(t *testing.T) {
	fake := newFake()
	f := boardtest.New(t, fake)
	fake.answer("GET /v1/health", 200, `{"schema":1,"version":"main:80ab7de4da31","errors":[]}`)
	f.Program(t, "systemctl", `printf 'LoadState=loaded\nActiveState=active\nActiveEnterTimestampMonotonic=1000000\n'`)
	health, err := ReadHealth(ctx(t), f.Board)
	if err != nil {
		t.Fatal(err)
	}
	if string(health.Health["version"]) != `"main:80ab7de4da31"` || health.StartedAt == nil {
		t.Fatalf("health %+v", health)
	}
	// Started one second after this machine booted.
	uptime, err := os.ReadFile("/proc/uptime")
	if err != nil {
		t.Fatal(err)
	}
	up, err := strconv.ParseFloat(strings.Fields(string(uptime))[0], 64)
	if err != nil {
		t.Fatal(err)
	}
	booted := time.Now().Add(-time.Duration(up * float64(time.Second)))
	if d := health.StartedAt.Sub(booted.Add(time.Second)); d < -2*time.Second || d > 2*time.Second {
		t.Errorf("started %v, booted %v", health.StartedAt, booted)
	}
}

func TestParseDaemon(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	d := parseDaemon("LoadState=loaded\nActiveState=active\nActiveEnterTimestampMonotonic=5000000\n@@\n65.50 100.0\n", now)
	if d.loaded != "loaded" || d.active != "active" || !d.started.Equal(now.Add(-60500*time.Millisecond)) {
		t.Errorf("parsed %+v", d)
	}
	if d := parseDaemon("LoadState=loaded\nActiveState=inactive\nActiveEnterTimestampMonotonic=0\n@@\n65.5 1\n", now); !d.started.IsZero() {
		t.Errorf("an inactive service has a start: %+v", d)
	}
	if d := parseDaemon("garbage", now); d != (daemon{}) {
		t.Errorf("garbage: %+v", d)
	}
}

func samples(stamps ...string) []json.RawMessage {
	out := make([]json.RawMessage, len(stamps))
	for i, stamp := range stamps {
		out[i] = json.RawMessage(`{"timestamp":"` + stamp + `","values":{"a":` + string(rune('0'+i%10)) + `}}`)
	}
	return out
}

func stampsOf(t *testing.T, window []json.RawMessage) []string {
	t.Helper()
	var out []string
	for _, sample := range window {
		var s struct{ Timestamp string }
		if err := json.Unmarshal(sample, &s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s.Timestamp)
	}
	return out
}

func TestWindow(t *testing.T) {
	const a, b, c, d = "2026-09-22T20:55:41.1Z", "2026-09-22T20:55:43.1Z", "2026-09-22T20:55:45.1Z", "2026-09-22T20:55:47.1Z"
	cases := []struct {
		name    string
		samples []json.RawMessage
		after   string
		want    []string
		full    bool
	}{
		{"nothing held", samples(a, b, c), "", []string{a, b, c}, true},
		{"the newer ones", samples(a, b, c, d), b, []string{c, d}, false},
		{"nothing newer", samples(a, b), b, nil, false},
		{"an after the cache no longer holds", samples(b, c), a, []string{b, c}, true},
		{"a clock that stepped back", samples(c, d, a, b), "", []string{a, b}, true},
		{"held before the step", samples(c, d, a, b), d, []string{a, b}, true},
		{"held after the step", samples(c, d, a, b), a, []string{b}, false},
		{"an empty cache", nil, a, nil, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			window, full := Window(c.samples, c.after)
			if got := stampsOf(t, window); strings.Join(got, ",") != strings.Join(c.want, ",") || full != c.full {
				t.Errorf("got %v %v, want %v %v", got, full, c.want, c.full)
			}
		})
	}
}

func TestReadCacheAnswersTheWindow(t *testing.T) {
	fake := newFake()
	f := boardtest.New(t, fake)
	fake.answer("GET /v1/cache", 200, `{"schema":1,"version":"v","metrics":[{"key":"a"}],"latest":null,`+
		`"samples":[{"timestamp":"2026-09-22T20:55:41Z","values":{}},{"timestamp":"2026-09-22T20:55:43Z","values":{}}],"errors":[]}`)
	body, err := ReadCache(ctx(t), f.Board, "2026-09-22T20:55:41Z")
	if err != nil {
		t.Fatal(err)
	}
	if string(body["full"]) != "false" || string(body["samples"]) != `[{"timestamp":"2026-09-22T20:55:43Z","values":{}}]` ||
		string(body["metrics"]) != `[{"key":"a"}]` {
		t.Errorf("body %v", body)
	}
}

func TestTraceRequests(t *testing.T) {
	fake := newFake()
	f := boardtest.New(t, fake)
	fake.answer("POST /v1/traces", 200, `{"schema":1,"trace":{"id":"t"}}`)
	if _, err := StartTrace(ctx(t), f.Board, TraceRequest{Name: "  bench  ", Tags: []string{"v2"}}); err != nil {
		t.Fatal(err)
	}
	if sent := fake.requests(); sent[len(sent)-1] != `POST /v1/traces {"name":"bench","tags":["v2"]}` {
		t.Errorf("sent %v", sent)
	}
	for name, request := range map[string]TraceRequest{
		"no name":       {Name: " "},
		"a comma":       {Name: "before,after"},
		"too long":      {Name: strings.Repeat("é", 41)},
		"a line break":  {Name: "a\nb"},
		"a C1 control":  {Name: "a\u0085b"},
		"a long note":   {Name: "a", Note: strings.Repeat("n", MaxNote+1)},
		"too many tags": {Name: "a", Tags: make([]string, MaxTags+1)},
		"an empty tag":  {Name: "a", Tags: []string{""}},
	} {
		if _, err := StartTrace(ctx(t), f.Board, request); codeOf(err) != CodeInvalidRequest {
			t.Errorf("%s: %v", name, err)
		}
	}

	fake.answer("POST /v1/traces/trace%20a%2F1/stop", 200, `{"schema":1,"run":{}}`)
	fake.answer("POST /v1/traces/stop", 200, `{"schema":1,"run":{}}`)
	for _, id := range []string{"trace a/1", ""} {
		if _, err := StopTrace(ctx(t), f.Board, id); err != nil {
			t.Errorf("stop %q: %v", id, err)
		}
	}
}

func TestCompare(t *testing.T) {
	fake := newFake()
	f := boardtest.New(t, fake)
	fake.answer("GET /v1/compare?runs=base%2Bline,other&raw=1", 200, `{"schema":1,"baseline_id":"x"}`)
	if _, err := Compare(ctx(t), f.Board, []string{"base+line", "other"}, true); err != nil {
		t.Fatal(err)
	}
	for _, runs := range [][]string{{"one"}, make([]string, MaxCompared+1), {"a", ""}} {
		if _, err := Compare(ctx(t), f.Board, runs, false); codeOf(err) != CodeInvalidRequest {
			t.Errorf("%v: %v", runs, err)
		}
	}
}

func TestValidRunID(t *testing.T) {
	for _, id := range []string{"20260924T175231.958Z-baseline", "20260923T152712.952Z-insight-hw-1790177227", "20260101T000000.000Z-a.b_c"} {
		if !ValidRunID(id) {
			t.Errorf("%q refused", id)
		}
	}
	for _, id := range []string{"", "baseline", "--all", "20260924T175231.958Z-", "20260924T175231.958Z--all",
		"20260924T175231.958Z-a b", "20260924T175231.958Z-a;reboot", "20260924T175231.958Z-$(id)", "20260924T175231.958Z-a\nb",
		"x20260924T175231.958Z-a", "20260924T175231.958Z-a/../b", "20260924T175231.958Z-" + strings.Repeat("a", 129)} {
		if ValidRunID(id) {
			t.Errorf("%q accepted", id)
		}
	}
}

// deleteFixture is a board whose simaai-sentinel records its arguments and prints output.
func deleteFixture(t *testing.T, output string) (*boardtest.Fixture, *fakeSentinel, string) {
	fake := newFake()
	f := boardtest.New(t, fake)
	calls := filepath.Join(t.TempDir(), "calls")
	f.Program(t, "simaai-sentinel", `printf '%s\n' "$@" >> '`+calls+`'; printf '%s\n' '`+output+`'`)
	return f, fake, calls
}

const finished = `{"id":"20260924T175231.958Z-baseline","name":"baseline","ended_at":"2026-09-24T17:52:40Z"}`

func TestDeleteRun(t *testing.T) {
	f, fake, calls := deleteFixture(t, "")
	fake.answer("GET /v1/runs", 200, `{"schema":1,"runs":[`+finished+`]}`)
	// The CLI deletes nothing here: Sentinel still lists the run, which is a failure.
	if _, err := DeleteRun(ctx(t), f.Board, "20260924T175231.958Z-baseline"); codeOf(err) != CodeFailed {
		t.Errorf("a run still listed: %v", err)
	}
	argv, _ := os.ReadFile(calls)
	if string(argv) != "runs\ndelete\n20260924T175231.958Z-baseline\n" {
		t.Errorf("the CLI got %q", argv)
	}
}

func TestDeleteRunConfirmsTheRunIsGone(t *testing.T) {
	// Sentinel lists the run until the CLI has run, as the real one does once it deleted it.
	var mu sync.Mutex
	listings := 0
	f := boardtest.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if listings++; listings == 1 {
			_, _ = w.Write([]byte(`{"schema":1,"runs":[` + finished + `]}`))
			return
		}
		_, _ = w.Write([]byte(`{"schema":1,"runs":[]}`))
	}))
	f.Program(t, "simaai-sentinel", "exit 0")
	deleted, err := DeleteRun(ctx(t), f.Board, "20260924T175231.958Z-baseline")
	if err != nil {
		t.Fatal(err)
	}
	if deleted.Deleted != (RunRef{ID: "20260924T175231.958Z-baseline", Name: "baseline"}) || string(deleted.Runs["runs"]) != "[]" {
		t.Errorf("deleted %+v", deleted)
	}
}

func TestDeleteRunRefusals(t *testing.T) {
	cases := []struct {
		name, id, runs, output, code string
	}{
		{"not an id", "--all", `[]`, "", CodeInvalidRequest},
		{"a hostile id", "20260924T175231.958Z-$(reboot)", `[]`, "", CodeInvalidRequest},
		{"not listed", "20260924T175231.958Z-other", `[` + finished + `]`, "", CodeNotFound},
		{"recording", "20260924T175231.958Z-baseline", `[{"id":"20260924T175231.958Z-baseline","ended_at":null}]`, "", CodeTraceConflict},
		{"the CLI says active", "20260924T175231.958Z-baseline", `[` + finished + `]`, "Error: cannot delete active run", CodeTraceConflict},
		{"the CLI says unknown", "20260924T175231.958Z-baseline", `[` + finished + `]`, "Error: unknown completed run", CodeNotFound},
		{"denied", "20260924T175231.958Z-baseline", `[` + finished + `]`, "rm: Permission denied", CodeDenied},
		{"another error", "20260924T175231.958Z-baseline", `[` + finished + `]`, "error: disk on fire", CodeFailed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f, fake, calls := deleteFixture(t, c.output)
			fake.answer("GET /v1/runs", 200, `{"schema":1,"runs":`+c.runs+`}`)
			_, err := DeleteRun(ctx(t), f.Board, c.id)
			if codeOf(err) != c.code {
				t.Errorf("got %v, want %s", err, c.code)
			}
			if c.output == "" {
				if _, err := os.Stat(calls); err == nil {
					t.Error("the CLI ran")
				}
			}
		})
	}
}

func TestDeleteRunWithoutTheCLI(t *testing.T) {
	if _, err := os.Stat("/usr/local/bin/simaai-sentinel"); err == nil {
		t.Skip("this machine has Sentinel's CLI")
	}
	fake := newFake()
	f := boardtest.New(t, fake)
	fake.answer("GET /v1/runs", 200, `{"schema":1,"runs":[`+finished+`]}`)
	if _, err := DeleteRun(ctx(t), f.Board, "20260924T175231.958Z-baseline"); codeOf(err) != CodeToolMissing {
		t.Errorf("got %v", err)
	}
}
