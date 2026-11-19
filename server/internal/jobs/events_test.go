package jobs

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func eventsServer(t *testing.T, r *Runner) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.ServeEvents(w, req, req.URL.Query().Get("id"))
	}))
	t.Cleanup(server.Close)
	return server
}

// readEvent reads one event from an event stream: its data line, then the blank line ending it.
func readEvent(t *testing.T, body *bufio.Reader) (Snapshot, error) {
	t.Helper()
	line, err := body.ReadString('\n')
	if err != nil {
		return Snapshot{}, err
	}
	data, ok := strings.CutPrefix(strings.TrimSuffix(line, "\n"), "data: ")
	if !ok {
		t.Fatalf("not a data line: %q", line)
	}
	if blank, err := body.ReadString('\n'); err != nil || blank != "\n" {
		t.Fatalf("the event does not end with a blank line: %q, %v", blank, err)
	}
	var s Snapshot
	if err := json.Unmarshal([]byte(data), &s); err != nil {
		t.Fatalf("not JSON: %q: %v", data, err)
	}
	return s, nil
}

func TestServeEventsStreamsUntilTheFinalState(t *testing.T) {
	r := New(nil)
	step := make(chan struct{})
	j := r.Submit("upload", "Upload clip.mp4", func(ctx context.Context, p *Progress) (any, error) {
		<-step
		p.Set(ProgressValue{Phase: "encode", Detail: "00:30 / 01:00"})
		p.SetPercent(50)
		<-step
		return map[string]string{"path": "uploads/clip.mp4"}, nil
	})
	server := eventsServer(t, r)
	resp, err := http.Get(server.URL + "?id=" + j.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Errorf("Content-Type %q", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control %q", got)
	}
	body := bufio.NewReader(resp.Body)

	s, err := readEvent(t, body)
	if err != nil || s.State != Running || s.ID != j.ID() || s.Kind != "upload" || s.Title != "Upload clip.mp4" {
		t.Fatalf("first event %+v, %v", s, err)
	}
	step <- struct{}{}
	// The phase and the percent come as one event, or as two when the phase was sent at once.
	for s.Progress.Percent == nil {
		s, err = readEvent(t, body)
		if err != nil || s.State != Running || s.Progress.Phase != "encode" || s.Progress.Detail != "00:30 / 01:00" {
			t.Fatalf("progress event %+v, %v", s, err)
		}
	}
	if *s.Progress.Percent != 50 {
		t.Errorf("progress percent %v", *s.Progress.Percent)
	}
	step <- struct{}{}
	s, err = readEvent(t, body)
	if err != nil || s.State != Done || s.FinishedAt == nil {
		t.Fatalf("final event %+v, %v", s, err)
	}
	if result, _ := s.Result.(map[string]any); result["path"] != "uploads/clip.mp4" {
		t.Errorf("result %v", s.Result)
	}
	if rest, err := io.ReadAll(body); err != nil || len(rest) != 0 {
		t.Errorf("after the final state: %q, %v", rest, err)
	}
}

func TestServeEventsOfAFinishedJob(t *testing.T) {
	r := New(nil)
	j := r.Submit("upload", "upload", idle)
	waitDone(t, j)
	resp, err := http.Get(eventsServer(t, r).URL + "?id=" + j.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body := bufio.NewReader(resp.Body)
	if s, err := readEvent(t, body); err != nil || s.State != Done {
		t.Fatalf("event %+v, %v", s, err)
	}
	if _, err := readEvent(t, body); err != io.EOF {
		t.Errorf("a second event or %v", err)
	}
}

func TestServeEventsOfAnUnknownJob(t *testing.T) {
	r := New(nil)
	w := httptest.NewRecorder()
	r.ServeEvents(w, httptest.NewRequest(http.MethodGet, "/api/jobs/nope/events", nil), "nope")
	if w.Code != http.StatusNotFound {
		t.Errorf("status %d", w.Code)
	}
	var body struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Error.Code != "job_not_found" {
		t.Errorf("body %s, %v", w.Body.String(), err)
	}
}

func TestServeEventsStopsWhenTheClientLeaves(t *testing.T) {
	r := New(nil)
	release := make(chan struct{})
	defer close(release)
	j := r.Submit("upload", "upload", func(context.Context, *Progress) (any, error) {
		<-release
		return nil, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, eventsServer(t, r).URL+"?id="+j.ID(), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if _, err := readEvent(t, bufio.NewReader(resp.Body)); err != nil {
		t.Fatal(err)
	}
	subscribers := func() int {
		j.mu.Lock()
		defer j.mu.Unlock()
		return len(j.subs)
	}
	if subscribers() != 1 {
		t.Fatalf("%d subscribers while streaming", subscribers())
	}
	cancel()
	eventually(t, "the stream unsubscribed after the client left", func() bool { return subscribers() == 0 })
	if s := j.Snapshot(); s.State != Running {
		t.Errorf("a client leaving changed the job to %s", s.State)
	}
}
