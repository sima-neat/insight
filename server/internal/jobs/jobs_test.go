package jobs

import (
	"context"
	"errors"
	"maps"
	"math"
	"regexp"
	"slices"
	"sync"
	"testing"
	"time"
)

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("not within 5 s: %s", what)
}

func waitDone(t *testing.T, j *Job) Snapshot {
	t.Helper()
	select {
	case <-j.Done():
	case <-time.After(5 * time.Second):
		t.Fatalf("job %s did not finish", j.ID())
	}
	return j.Snapshot()
}

func next(t *testing.T, events <-chan Snapshot) (Snapshot, bool) {
	t.Helper()
	select {
	case s, open := <-events:
		return s, open
	case <-time.After(5 * time.Second):
		t.Fatal("no snapshot within 5 s")
		return Snapshot{}, false
	}
}

// kept are the jobs the runner holds now, active or finished recently.
func kept(r *Runner) []*Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked()
	return slices.Collect(maps.Values(r.jobs))
}

func states(r *Runner, kind Kind) map[State]int {
	out := map[State]int{}
	for _, j := range kept(r) {
		if s := j.Snapshot(); s.Kind == kind {
			out[s.State]++
		}
	}
	return out
}

func idle(context.Context, *Progress) (any, error) { return nil, nil }

func TestLimitsPerKind(t *testing.T) {
	r := New(map[Kind]int{"encode": 1, "download": 2})
	release := make(chan struct{})
	var mu sync.Mutex
	current, peak := map[Kind]int{}, map[Kind]int{}
	work := func(kind Kind) Work {
		return func(context.Context, *Progress) (any, error) {
			mu.Lock()
			current[kind]++
			peak[kind] = max(peak[kind], current[kind])
			mu.Unlock()
			<-release
			mu.Lock()
			current[kind]--
			mu.Unlock()
			return nil, nil
		}
	}
	var all []*Job
	for range 3 {
		for _, kind := range []Kind{"encode", "download", "unlisted"} {
			all = append(all, r.Submit(kind, string(kind), work(kind)))
		}
	}
	for kind, running := range map[Kind]int{"encode": 1, "download": 2, "unlisted": 1} {
		eventually(t, string(kind)+" jobs running up to the limit", func() bool {
			mu.Lock()
			working := current[kind]
			mu.Unlock()
			s := states(r, kind)
			return working == running && s[Running] == running && s[Queued] == 3-running
		})
	}
	close(release)
	for _, j := range all {
		if s := waitDone(t, j); s.State != Done {
			t.Errorf("%s ended %s", s.Title, s.State)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if want := (map[Kind]int{"encode": 1, "download": 2, "unlisted": 1}); !maps.Equal(peak, want) {
		t.Errorf("most at once %v, want %v", peak, want)
	}
}

func TestQueueRunsInSubmissionOrder(t *testing.T) {
	r := New(map[Kind]int{"encode": 1})
	gate := make(chan struct{})
	var mu sync.Mutex
	var order []int
	var all []*Job
	for i := range 5 {
		all = append(all, r.Submit("encode", "encode", func(context.Context, *Progress) (any, error) {
			if i == 0 {
				<-gate
			}
			mu.Lock()
			order = append(order, i)
			mu.Unlock()
			return nil, nil
		}))
	}
	for _, j := range all[1:] {
		if s := j.Snapshot(); s.State != Queued || s.StartedAt != nil {
			t.Errorf("a waiting job is %s, started %v", s.State, s.StartedAt)
		}
	}
	close(gate)
	waitDone(t, all[4])
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(order, []int{0, 1, 2, 3, 4}) {
		t.Errorf("ran in order %v", order)
	}
}

func TestCancelQueuedNeverRuns(t *testing.T) {
	r := New(map[Kind]int{"encode": 1})
	block := make(chan struct{})
	first := r.Submit("encode", "first", func(context.Context, *Progress) (any, error) {
		<-block
		return nil, nil
	})
	ran := make(chan struct{}, 1)
	second := r.Submit("encode", "second", func(context.Context, *Progress) (any, error) {
		ran <- struct{}{}
		return nil, nil
	})
	third := r.Submit("encode", "third", idle)

	second.Cancel()
	if s := second.Snapshot(); s.State != Cancelled || s.FinishedAt == nil || s.StartedAt != nil {
		t.Fatalf("cancelled queued job: %+v", s)
	}
	select {
	case <-second.Done():
	default:
		t.Fatal("a cancelled queued job is not done at once")
	}
	close(block)
	waitDone(t, first)
	if s := waitDone(t, third); s.State != Done {
		t.Errorf("the job queued behind it ended %s", s.State)
	}
	select {
	case <-ran:
		t.Error("a cancelled queued job ran")
	default:
	}
}

func TestCancelRunningWaitsForTheWork(t *testing.T) {
	r := New(map[Kind]int{"encode": 1})
	started := make(chan struct{})
	cleaned := make(chan struct{})
	j := r.Submit("encode", "encode", func(ctx context.Context, p *Progress) (any, error) {
		p.Set(ProgressValue{Phase: "encode"})
		close(started)
		<-ctx.Done()
		time.Sleep(20 * time.Millisecond) // stopping ffmpeg, removing its file
		close(cleaned)
		return "partial", ctx.Err()
	})
	queued := r.Submit("encode", "next", idle)
	<-started
	j.Cancel()
	if s := j.Snapshot(); s.State != Running {
		t.Fatalf("right after Cancel the job is %s, want running until its work returns", s.State)
	}
	s := waitDone(t, j)
	select {
	case <-cleaned:
	default:
		t.Fatal("reported cancelled before its work returned")
	}
	if s.State != Cancelled || s.Error != "" || s.Result != nil {
		t.Errorf("cancelled job: %+v", s)
	}
	if s := waitDone(t, queued); s.State != Done {
		t.Errorf("the next job ended %s", s.State)
	}
	j.Cancel()
	if again := j.Snapshot(); again.State != Cancelled {
		t.Errorf("cancelling a finished job changed it to %s", again.State)
	}
}

func TestCancelledWorkThatFinishesAnywayIsDone(t *testing.T) {
	r := New(nil)
	started := make(chan struct{})
	j := r.Submit("encode", "encode", func(ctx context.Context, p *Progress) (any, error) {
		close(started)
		<-ctx.Done()
		return "kept", nil
	})
	<-started
	j.Cancel()
	if s := waitDone(t, j); s.State != Done || s.Result != "kept" {
		t.Errorf("got %+v", s)
	}
}

func TestFailures(t *testing.T) {
	r := New(nil)
	failed := r.Submit("encode", "fails", func(context.Context, *Progress) (any, error) {
		return "ignored", errors.New("FFmpeg could not open the file.")
	})
	panicked := r.Submit("encode", "panics", func(context.Context, *Progress) (any, error) {
		panic("boom")
	})
	if s := waitDone(t, failed); s.State != Failed || s.Error != "FFmpeg could not open the file." || s.Result != nil {
		t.Errorf("failed job: %+v", s)
	}
	if s := waitDone(t, panicked); s.State != Failed || s.Error == "" {
		t.Errorf("panicked job: %+v", s)
	}
}

func TestProgressSetters(t *testing.T) {
	r := New(nil)
	check := make(chan func(), 1)
	stop := make(chan struct{})
	var kept *Progress
	j := r.Submit("encode", "encode", func(ctx context.Context, p *Progress) (any, error) {
		kept = p
		for {
			select {
			case f := <-check:
				f()
			case <-stop:
				return nil, nil
			}
		}
	})
	step := func(f func(p *Progress), want ProgressValue) {
		t.Helper()
		done := make(chan struct{})
		check <- func() { f(kept); close(done) }
		<-done
		got := j.Snapshot().Progress
		if got.Phase != want.Phase || got.Detail != want.Detail || !samePercent(got.Percent, want.Percent) {
			t.Errorf("progress %+v (percent %v), want %+v (percent %v)", got, deref(got.Percent), want, deref(want.Percent))
		}
	}
	pct := func(v float64) *float64 { return &v }
	step(func(p *Progress) { p.Set(ProgressValue{Phase: "encode", Percent: pct(12.5)}) }, ProgressValue{Phase: "encode", Percent: pct(12.5)})
	step(func(p *Progress) { p.SetPercent(150) }, ProgressValue{Phase: "encode", Percent: pct(100)})
	step(func(p *Progress) { p.SetPercent(-3) }, ProgressValue{Phase: "encode", Percent: pct(0)})
	step(func(p *Progress) { p.SetPercent(40) }, ProgressValue{Phase: "encode", Percent: pct(40)})
	step(func(p *Progress) { p.SetPercent(math.NaN()) }, ProgressValue{Phase: "encode", Percent: pct(40)})
	step(func(p *Progress) { p.SetDetail("00:25 / 01:00") }, ProgressValue{Phase: "encode", Detail: "00:25 / 01:00", Percent: pct(40)})
	step(func(p *Progress) { p.Set(ProgressValue{Phase: "validate"}) }, ProgressValue{Phase: "validate"})
	close(stop)
	final := waitDone(t, j)
	kept.SetPercent(77)
	kept.Set(ProgressValue{Phase: "late"})
	if got := j.Snapshot().Progress; got.Phase != final.Progress.Phase || got.Percent != nil {
		t.Errorf("a setter after the end changed the job: %+v", got)
	}
}

func samePercent(a, b *float64) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

func deref(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func TestNotificationsAreThrottledButStatesAreNot(t *testing.T) {
	r := New(nil)
	subscribed := make(chan struct{})
	j := r.Submit("encode", "encode", func(ctx context.Context, p *Progress) (any, error) {
		<-subscribed
		for i := 1; i <= 300; i++ {
			p.SetPercent(float64(i) / 3)
			time.Sleep(2 * time.Millisecond)
		}
		return "ok", nil
	})
	events, unsubscribe, ok := r.Subscribe(j.ID())
	if !ok {
		t.Fatal("no such job")
	}
	defer unsubscribe()
	first, _ := next(t, events)
	if first.State != Running || first.Progress.Percent != nil {
		t.Fatalf("first snapshot %+v", first)
	}
	close(subscribed)
	var progressAt []time.Time
	var last Snapshot
	for {
		s, open := next(t, events)
		if !open {
			break
		}
		last = s
		if s.State == Running {
			progressAt = append(progressAt, time.Now())
		}
	}
	// About 300 updates over at least 600 ms: three or four notifications, not hundreds.
	if n := len(progressAt); n < 2 || n > 5 {
		t.Errorf("%d progress notifications", n)
	}
	for i := 1; i < len(progressAt); i++ {
		if gap := progressAt[i].Sub(progressAt[i-1]); gap < 150*time.Millisecond {
			t.Errorf("notifications %v apart", gap)
		}
	}
	if last.State != Done || last.Result != "ok" || last.Progress.Percent == nil || *last.Progress.Percent != 100 {
		t.Errorf("final snapshot %+v, percent %v", last, deref(last.Progress.Percent))
	}
}

func TestSubscriberSeesEveryStateChange(t *testing.T) {
	r := New(map[Kind]int{"encode": 1})
	block := make(chan struct{})
	r.Submit("encode", "first", func(context.Context, *Progress) (any, error) {
		<-block
		return nil, nil
	})
	running := make(chan struct{})
	finish := make(chan struct{})
	j := r.Submit("encode", "second", func(context.Context, *Progress) (any, error) {
		close(running)
		<-finish
		return nil, nil
	})
	events, unsubscribe, _ := r.Subscribe(j.ID())
	defer unsubscribe()
	if s, _ := next(t, events); s.State != Queued {
		t.Fatalf("first snapshot %s", s.State)
	}
	close(block)
	<-running
	if s, _ := next(t, events); s.State != Running {
		t.Fatalf("second snapshot %s", s.State)
	}
	start := time.Now()
	close(finish)
	if s, _ := next(t, events); s.State != Done {
		t.Fatalf("third snapshot %s", s.State)
	}
	if waited := time.Since(start); waited > 200*time.Millisecond {
		t.Errorf("the final state took %v, as if throttled", waited)
	}
	if _, open := next(t, events); open {
		t.Error("the channel stays open after the final state")
	}
	unsubscribe() // after the end, and twice: harmless

	finished, unsubscribe2, ok := r.Subscribe(j.ID())
	if !ok {
		t.Fatal("a finished job cannot be followed")
	}
	defer unsubscribe2()
	if s, _ := next(t, finished); s.State != Done {
		t.Errorf("a finished job's subscription starts with %s", s.State)
	}
	if _, open := next(t, finished); open {
		t.Error("a finished job's subscription stays open")
	}
	if _, _, ok := r.Subscribe("no-such-job"); ok {
		t.Error("an unknown job was followed")
	}
}

func TestUnsubscribeClosesTheChannel(t *testing.T) {
	r := New(nil)
	release := make(chan struct{})
	defer close(release)
	j := r.Submit("encode", "encode", func(context.Context, *Progress) (any, error) {
		<-release
		return nil, nil
	})
	events, unsubscribe, _ := r.Subscribe(j.ID())
	next(t, events)
	unsubscribe()
	if _, open := next(t, events); open {
		t.Error("open after unsubscribe")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.subs) != 0 {
		t.Errorf("%d subscribers left", len(j.subs))
	}
}

func TestFinishedJobsAreDroppedAfterAWhile(t *testing.T) {
	r := New(nil)
	r.keep = 30 * time.Millisecond
	j := r.Submit("encode", "encode", idle)
	waitDone(t, j)
	if _, _, ok := r.Subscribe(j.ID()); !ok {
		t.Fatal("a job just finished is gone")
	}
	time.Sleep(60 * time.Millisecond)
	if _, _, ok := r.Subscribe(j.ID()); ok {
		t.Error("a finished job outlived keep")
	}
	if n := len(kept(r)); n != 0 {
		t.Errorf("%d jobs kept", n)
	}
}

func TestAtMostMaxKeptFinishedJobs(t *testing.T) {
	r := New(map[Kind]int{"download": 1})
	r.maxKept = 2
	release := make(chan struct{})
	defer close(release)
	active := r.Submit("encode", "running", func(context.Context, *Progress) (any, error) {
		<-release
		return nil, nil
	})
	var finished []*Job
	for range 4 {
		j := r.Submit("download", "download", idle)
		waitDone(t, j)
		finished = append(finished, j)
	}
	var ids []string
	for _, j := range kept(r) {
		ids = append(ids, j.ID())
	}
	want := []string{active.ID(), finished[2].ID(), finished[3].ID()}
	slices.Sort(ids)
	slices.Sort(want)
	if !slices.Equal(ids, want) {
		t.Errorf("kept %v, want the running job and the last two finished %v", ids, want)
	}
}

func TestShutdownCancelsEverything(t *testing.T) {
	r := New(map[Kind]int{"encode": 1})
	started := make(chan struct{})
	running := r.Submit("encode", "running", func(ctx context.Context, p *Progress) (any, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	queued := r.Submit("encode", "queued", idle)
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	for _, j := range []*Job{running, queued} {
		if s := j.Snapshot(); s.State != Cancelled {
			t.Errorf("%s is %s after Shutdown", s.Title, s.State)
		}
	}
	ran := false
	late := r.Submit("encode", "late", func(context.Context, *Progress) (any, error) {
		ran = true
		return nil, nil
	})
	if s := waitDone(t, late); s.State != Cancelled || ran {
		t.Errorf("a job submitted after Shutdown: %s, ran %v", s.State, ran)
	}
}

func TestShutdownGivesUpOnStuckWork(t *testing.T) {
	r := New(nil)
	release := make(chan struct{})
	defer close(release)
	started := make(chan struct{})
	r.Submit("encode", "stuck", func(context.Context, *Progress) (any, error) {
		close(started)
		<-release
		return nil, nil
	})
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := r.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Shutdown returned %v", err)
	}
}

func TestIDsAreRandomAndURLSafe(t *testing.T) {
	r := New(nil)
	urlSafe := regexp.MustCompile(`^[A-Za-z0-9_-]{16}$`)
	seen := map[string]bool{}
	for range 100 {
		id := r.Submit("encode", "encode", idle).ID()
		if !urlSafe.MatchString(id) || seen[id] {
			t.Fatalf("id %q (seen before: %v)", id, seen[id])
		}
		seen[id] = true
	}
}
