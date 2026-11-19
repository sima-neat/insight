// Package jobs runs Insight's long work (a rendition's encode, an upload's re-encode, a catalog
// download) as jobs: each is queued, runs when its kind has room, reports its progress, can be
// cancelled, and is kept for a while after it ends so that a browser tab opened later still sees
// how it went.
//
// A job outlives the request that started it. Its state is followed as it changes (Subscribe,
// ServeEvents); progress reaches subscribers at most every 250 ms, however often the work reports
// it, and every change of state at once.
package jobs

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"maps"
	"math"
	"slices"
	"sync"
	"time"
)

// Kind names a sort of work ("rendition", "upload", "catalog_import"); each kind has its own
// limit on how many run at once.
type Kind string

// State is where a job is in its life. Queued and Running are active; the others are final.
type State string

const (
	Queued    State = "queued"
	Running   State = "running"
	Done      State = "done"
	Failed    State = "failed"
	Cancelled State = "cancelled"
)

// Final says whether a job in this state has ended.
func (s State) Final() bool { return s == Done || s == Failed || s == Cancelled }

// Work is what a job does. It returns when ctx is cancelled, as soon as it has cleaned up (a
// child process stopped, a temporary file removed). Its result must be JSON-able; its error's
// message is shown to the user as it is, so it is a sentence.
type Work func(ctx context.Context, progress *Progress) (any, error)

// ProgressValue is how far a job has come: a percent when the work knows it, the phase it is in
// ("encode", "download") and a detail ("00:25 / 01:00").
type ProgressValue struct {
	Percent *float64 `json:"percent,omitempty"`
	Phase   string   `json:"phase"`
	Detail  string   `json:"detail"`
}

// Snapshot is a job at one moment, as the API shows it.
type Snapshot struct {
	ID       string        `json:"id"`
	Kind     Kind          `json:"kind"`
	Title    string        `json:"title"`
	State    State         `json:"state"`
	Progress ProgressValue `json:"progress"`
	// Result is the work's result once the job is done.
	Result any `json:"result,omitempty"`
	// Error is the work's error message once the job has failed.
	Error      string     `json:"error,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

const (
	// keepFinished is how long a finished job stays readable.
	keepFinished = 10 * time.Minute
	// maxFinished bounds the finished jobs kept, whatever their age; the oldest go first.
	maxFinished = 200
	// notifyEvery is the least time between two progress notifications of one job.
	notifyEvery = 250 * time.Millisecond
)

// Runner runs jobs, a limited number of each kind at once, the rest waiting in the order they
// were submitted.
type Runner struct {
	limits map[Kind]int
	// keep, maxKept and every are keepFinished, maxFinished and notifyEvery; tests shorten them.
	keep    time.Duration
	maxKept int
	every   time.Duration

	mu       sync.Mutex
	jobs     map[string]*Job
	queues   map[Kind][]*Job
	running  map[Kind]int
	finished []*Job // in the order they finished, for retention
	closed   bool
	active   sync.WaitGroup
}

// New makes a runner that runs at most limits[kind] jobs of each kind at once. A kind without a
// limit (or with one below 1) runs one at a time.
func New(limits map[Kind]int) *Runner {
	return &Runner{
		limits:  maps.Clone(limits),
		keep:    keepFinished,
		maxKept: maxFinished,
		every:   notifyEvery,
		jobs:    map[string]*Job{},
		queues:  map[Kind][]*Job{},
		running: map[Kind]int{},
	}
}

func (r *Runner) limit(kind Kind) int {
	return max(1, r.limits[kind])
}

// Job is one submitted piece of work.
type Job struct {
	r       *Runner
	id      string
	kind    Kind
	title   string
	work    Work
	created time.Time
	done    chan struct{}

	mu         sync.Mutex
	state      State
	phase      string
	detail     string
	percent    float64
	hasPercent bool
	result     any
	err        string
	started    time.Time
	finished   time.Time
	cancel     context.CancelFunc // while running
	cancelled  bool               // Cancel was called while it ran
	subs       map[chan Snapshot]struct{}
	dirty      bool // progress changed since the last notification
	lastSent   time.Time
	timer      *time.Timer // a pending notification
}

// ID is the job's random, URL-safe identifier.
func (j *Job) ID() string { return j.id }

// Done is closed when the job has reached a final state.
func (j *Job) Done() <-chan struct{} { return j.done }

// Snapshot returns the job as it is now.
func (j *Job) Snapshot() Snapshot {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.snapshotLocked()
}

// Submit queues work as a job of kind, titled for the user ("Encode clip.mp4 at 15 fps"), and
// starts it when its kind has room. After Shutdown the job is cancelled without running.
func (r *Runner) Submit(kind Kind, title string, work Work) *Job {
	j := &Job{
		r: r, id: newID(), kind: kind, title: title, work: work,
		created: time.Now(), done: make(chan struct{}),
		state: Queued, subs: map[chan Snapshot]struct{}{},
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked()
	r.jobs[j.id] = j
	if r.closed {
		r.finishLocked(j, Cancelled, nil, "")
		return j
	}
	r.queues[kind] = append(r.queues[kind], j)
	r.startLocked(kind)
	return j
}

// Cancel cancels the job: a queued one ends at once without running; a running one has its
// context cancelled and stays running until its work returns, so that what it cleans up is gone
// before the job is reported cancelled (a work that finishes regardless is done). Cancelling a
// finished job changes nothing.
func (j *Job) Cancel() {
	j.r.mu.Lock()
	defer j.r.mu.Unlock()
	j.r.cancelLocked(j)
}

func (r *Runner) cancelLocked(j *Job) {
	j.mu.Lock()
	switch j.state {
	case Queued:
		j.mu.Unlock()
		r.queues[j.kind] = slices.DeleteFunc(r.queues[j.kind], func(q *Job) bool { return q == j })
		r.finishLocked(j, Cancelled, nil, "")
	case Running:
		j.cancelled = true
		cancel := j.cancel
		j.mu.Unlock()
		cancel()
	default:
		j.mu.Unlock()
	}
}

// Subscribe follows the job: the channel holds its current snapshot at once, then the latest one
// after each change, and is closed after the final one. A reader that falls behind gets the
// latest snapshot, never a backlog; the final one is never lost. unsubscribe ends the
// subscription and closes the channel; it may be called more than once.
func (r *Runner) Subscribe(id string) (events <-chan Snapshot, unsubscribe func(), ok bool) {
	j, ok := r.lookup(id)
	if !ok {
		return nil, nil, false
	}
	ch := make(chan Snapshot, 1)
	j.mu.Lock()
	defer j.mu.Unlock()
	ch <- j.snapshotLocked()
	if j.state.Final() {
		close(ch)
		return ch, func() {}, true
	}
	j.subs[ch] = struct{}{}
	return ch, func() {
		j.mu.Lock()
		defer j.mu.Unlock()
		if _, ok := j.subs[ch]; ok {
			delete(j.subs, ch)
			close(ch)
		}
	}, true
}

// Shutdown cancels every job and refuses new ones, then waits for the running ones to return or
// ctx to end.
func (r *Runner) Shutdown(ctx context.Context) error {
	r.mu.Lock()
	r.closed = true
	for _, j := range r.jobs {
		r.cancelLocked(j)
	}
	r.mu.Unlock()
	returned := make(chan struct{})
	go func() {
		r.active.Wait()
		close(returned)
	}()
	select {
	case <-returned:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("jobs still running: %w", ctx.Err())
	}
}

func (r *Runner) lookup(id string) (*Job, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked()
	j, ok := r.jobs[id]
	return j, ok
}

// startLocked starts queued jobs of kind while the kind has room.
func (r *Runner) startLocked(kind Kind) {
	for r.running[kind] < r.limit(kind) && len(r.queues[kind]) > 0 {
		j := r.queues[kind][0]
		r.queues[kind] = r.queues[kind][1:]
		ctx, cancel := context.WithCancel(context.Background())
		j.mu.Lock()
		j.state, j.started, j.cancel = Running, time.Now(), cancel
		j.publishLocked()
		j.mu.Unlock()
		r.running[kind]++
		r.active.Add(1)
		go r.run(ctx, j)
	}
}

func (r *Runner) run(ctx context.Context, j *Job) {
	defer r.active.Done()
	result, err := call(ctx, j)
	j.mu.Lock()
	cancel, cancelled := j.cancel, j.cancelled
	j.mu.Unlock()
	cancel()

	state, message := Done, ""
	if err != nil {
		result = nil
		if cancelled {
			state = Cancelled
		} else {
			state, message = Failed, err.Error()
			slog.Warn("job failed", "job", j.id, "kind", j.kind, "title", j.title, "error", message)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.running[j.kind]--
	r.finishLocked(j, state, result, message)
	r.startLocked(j.kind)
}

// call runs the job's work. A panic fails the job rather than the whole server.
func call(ctx context.Context, j *Job) (result any, err error) {
	defer func() {
		if p := recover(); p != nil {
			slog.Error("job panicked", "job", j.id, "kind", j.kind, "panic", p)
			result, err = nil, fmt.Errorf("The job stopped on an internal error: %v", p)
		}
	}()
	return j.work(ctx, &Progress{j: j})
}

// finishLocked puts j in its final state, tells its subscribers and keeps it for retention.
func (r *Runner) finishLocked(j *Job, state State, result any, message string) {
	j.mu.Lock()
	j.state, j.result, j.err, j.finished, j.cancel = state, result, message, time.Now(), nil
	if j.timer != nil {
		j.timer.Stop()
		j.timer = nil
	}
	j.publishLocked()
	for ch := range j.subs {
		close(ch)
	}
	clear(j.subs)
	j.mu.Unlock()
	close(j.done)
	r.finished = append(r.finished, j)
	r.pruneLocked()
}

// pruneLocked drops the finished jobs older than keep and, beyond maxKept, the oldest.
func (r *Runner) pruneLocked() {
	cutoff := time.Now().Add(-r.keep)
	drop := 0
	for drop < len(r.finished) {
		j := r.finished[drop]
		if len(r.finished)-drop <= r.maxKept && j.finished.After(cutoff) {
			break
		}
		delete(r.jobs, j.id)
		drop++
	}
	if drop > 0 {
		r.finished = slices.Delete(r.finished, 0, drop)
	}
}

func (j *Job) snapshotLocked() Snapshot {
	s := Snapshot{
		ID: j.id, Kind: j.kind, Title: j.title, State: j.state,
		Progress:  ProgressValue{Phase: j.phase, Detail: j.detail},
		Result:    j.result,
		Error:     j.err,
		CreatedAt: j.created,
	}
	if j.hasPercent {
		percent := j.percent
		s.Progress.Percent = &percent
	}
	if !j.started.IsZero() {
		started := j.started
		s.StartedAt = &started
	}
	if !j.finished.IsZero() {
		finished := j.finished
		s.FinishedAt = &finished
	}
	return s
}

// publishLocked hands every subscriber the job as it is now, replacing a snapshot it has not read.
func (j *Job) publishLocked() {
	j.dirty, j.lastSent = false, time.Now()
	if len(j.subs) == 0 {
		return
	}
	s := j.snapshotLocked()
	for ch := range j.subs {
		// Only this job sends, under j.mu, so after the drain the send cannot block.
		select {
		case ch <- s:
		default:
			select {
			case <-ch:
			default:
			}
			ch <- s
		}
	}
}

// progressedLocked notes a change of progress and notifies now, or when notifyEvery has passed
// since the last notification.
func (j *Job) progressedLocked() {
	j.dirty = true
	if j.timer != nil {
		return
	}
	wait := time.Until(j.lastSent.Add(j.r.every))
	if wait <= 0 {
		j.publishLocked()
		return
	}
	j.timer = time.AfterFunc(wait, j.flush)
}

func (j *Job) flush() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.timer = nil
	if j.dirty && j.state == Running {
		j.publishLocked()
	}
}

// Progress is how a job's work reports how far it has come. Its setters are cheap and safe to
// call as often as the work likes (on every line an encoder prints) and from any goroutine; a
// call after the job has ended is ignored.
type Progress struct{ j *Job }

// Set replaces the whole progress: a new phase with its own percent (nil or NaN when unknown,
// else held to 0–100) and detail.
func (p *Progress) Set(v ProgressValue) {
	p.update(func(j *Job) {
		j.phase, j.detail = v.Phase, v.Detail
		j.percent, j.hasPercent = 0, false
		if v.Percent != nil && !math.IsNaN(*v.Percent) {
			j.percent, j.hasPercent = clampPercent(*v.Percent), true
		}
	})
}

// SetPercent sets the percent done, held to 0–100; NaN is ignored.
func (p *Progress) SetPercent(percent float64) {
	if math.IsNaN(percent) {
		return
	}
	p.update(func(j *Job) {
		j.percent, j.hasPercent = clampPercent(percent), true
	})
}

// SetDetail sets the detail and keeps the phase and percent.
func (p *Progress) SetDetail(detail string) {
	p.update(func(j *Job) { j.detail = detail })
}

func (p *Progress) update(change func(*Job)) {
	j := p.j
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.state != Running {
		return
	}
	before := progressOf(j)
	change(j)
	if progressOf(j) != before {
		j.progressedLocked()
	}
}

type progressKey struct {
	phase, detail string
	percent       float64
	hasPercent    bool
}

func progressOf(j *Job) progressKey {
	return progressKey{j.phase, j.detail, j.percent, j.hasPercent}
}

func clampPercent(percent float64) float64 {
	return min(100, max(0, percent))
}

func newID() string {
	var b [12]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails
	return base64.RawURLEncoding.EncodeToString(b[:])
}
