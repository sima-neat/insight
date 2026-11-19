package slots

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"sync"
	"time"

	"insight/internal/media"
	"insight/internal/mediamtx"
	"insight/internal/supervisor"
)

// slotRuntime is what the Manager knows of one slot's world besides the snapshot. Its fields
// but wake and reconcileMu are guarded by Manager.mu.
type slotRuntime struct {
	wake chan struct{}
	// reconcileMu makes a slot's reconciles one at a time. It is held across their I/O and
	// taken before Manager.mu, never while holding it.
	reconcileMu sync.Mutex

	// The publisher of a file slot, while it runs: what it streams, as an absolute path and as
	// the library path the slot shows (the file, or its rendition under .renditions), and the
	// codec it was started for.
	proc       supervisor.Child
	procInput  string
	procActive string

	// info is the slot's file as last probed; nil when unknown.
	info *media.Info
	// problem is why the slot cannot run now, found by the last reconcile ("" for none); it
	// clears itself when the cause goes.
	problem string
	// blocked is why the slot stopped trying: its publisher could not be started, its
	// rendition failed, MediaMTX refused its camera. It holds until the slot is assigned or
	// started again.
	blocked string
	// rendition is the file name of the rendition the slot waits for, while one is encoded;
	// needs is the one it streams or will stream, while it is to run.
	rendition string
	needs     string

	// A pull's URL with its credentials, in memory only; the pull MediaMTX was given and when.
	fullURL       string
	appliedPull   string
	pullAppliedAt time.Time
	pullProbe     pullProbe
	// clearedAt and kickedID/At keep a reconcile from repeating a clear or kick before a
	// snapshot taken after it could show its effect.
	clearedAt time.Time
	kickedID  string
	kickedAt  time.Time

	// stats is the last probe of the stream the slot's path carries, for a stream Insight
	// knows nothing about (an external publisher, a camera, a webcam).
	stats streamStats
}

type pullProbe struct {
	status  PullStatus // PullConnecting, PullUnreachable or PullAuthFailed
	err     string
	at      time.Time
	running bool
}

type streamStats struct {
	key     string // the path's StreamKey the probe was of
	info    StreamInfo
	ok      bool
	running bool
}

// target is what a slot needs the world to be, by its desired state.
type target struct {
	publish *publishTarget // a publisher to run
	encode  *rendition     // a rendition to encode before the publisher can run
	pull    string         // the camera URL MediaMTX is to pull, "" for none
	webcam  bool           // a browser may publish on camN
	problem string
	info    *media.Info
	needs   string // the rendition the slot streams or will stream, "" for none
}

type publishTarget struct {
	abs, active, codec string
}

// reconcile makes slot n's world match its desired state: first it stops what the slot no
// longer wants (a publisher, a pull, a webcam publisher), then it starts what it wants. Each
// step compares what is wanted with what is known to run, so a step that is done is skipped,
// and one that failed is tried again by the next reconcile.
func (m *Manager) reconcile(n int) {
	rt := m.rt[n-1]
	rt.reconcileMu.Lock()
	defer rt.reconcileMu.Unlock()
	if m.ctx.Err() != nil {
		return
	}
	t := m.want(n)
	m.mu.Lock()
	rt.problem, rt.info, rt.needs = t.problem, t.info, t.needs
	m.mu.Unlock()

	m.stopPublisher(n, t)
	m.clearPull(n, t)
	m.kickWebcam(n, t)
	m.setPull(n, t)
	m.startPublisher(n, t)
	m.followRendition(n, t)
}

// want works out slot n's target from its desired state and what is known of the world.
func (m *Manager) want(n int) target {
	m.mu.Lock()
	d := m.store.get(n)
	rt := m.rt[n-1]
	blocked, fullURL, probe := rt.blocked, rt.fullURL, rt.pullProbe.status
	external := m.externalLocked(n) != nil
	m.mu.Unlock()

	var t target
	if d.Kind == KindFile {
		// The file is looked at even while the slot is stopped, so its row shows the codec
		// and rate.
		m.wantFile(d, &t)
		if !d.Run || external || blocked != "" {
			t.publish, t.encode = nil, nil
		}
		if !d.Run {
			t.problem, t.needs = "", ""
		}
		return t
	}
	if !d.Run || blocked != "" {
		return t
	}
	switch d.Kind {
	case KindWebcam:
		t.webcam = true
	case KindPull:
		if fullURL != "" && probe != PullAuthFailed {
			t.pull = fullURL
		}
	}
	return t
}

// wantFile fills t for a file slot: what to publish, or the rendition to encode first, or the
// problem that stands in the way. A file not probed yet is asked for and the slot waits.
func (m *Manager) wantFile(d Desired, t *target) {
	abs, err := media.Resolve(m.root, d.File)
	if err != nil {
		t.problem = fmt.Sprintf("%s is not a path in the media library.", d.File)
		return
	}
	st, ok := stampOf(abs)
	if !ok {
		t.problem = fmt.Sprintf("%s is not in the media library any more.", d.File)
		return
	}
	info, ok := m.opts.Probes.Get(abs)
	if !ok {
		m.opts.Probes.Want(abs)
		return
	}
	t.info = &info
	if !info.Streamable() {
		t.problem = notStreamable(d.File, info).Message
		return
	}
	if d.FPS == 0 || d.FPS == nativeFPS(info) {
		t.publish = &publishTarget{abs: abs, active: d.File, codec: info.Codec}
		return
	}
	r, err := m.renditionOf(d.File, abs, st, info, d.FPS)
	if err != nil {
		t.problem = err.Error()
		return
	}
	t.needs = r.name
	if _, err := os.Stat(r.out); err == nil {
		t.publish = &publishTarget{abs: r.out, active: r.rel(), codec: info.Codec}
		return
	}
	t.encode = &r
}

// nativeFPS is a file's own rate in whole frames per second, as the FPS override counts them.
func nativeFPS(info media.Info) int { return int(math.Round(info.FPS)) }

// stopPublisher stops slot n's publisher unless the target wants it streaming what it streams.
func (m *Manager) stopPublisher(n int, t target) {
	m.mu.Lock()
	rt := m.rt[n-1]
	proc := rt.proc
	keep := proc != nil && t.publish != nil && t.publish.abs == rt.procInput
	m.mu.Unlock()
	if proc == nil || keep {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), stopTimeout)
	defer cancel()
	if err := proc.Stop(ctx); err != nil {
		slog.Warn("a source's publisher did not stop; trying again", "slot", pathName(n), "error", err)
		return
	}
	m.mu.Lock()
	if rt.proc == proc {
		rt.proc, rt.procInput, rt.procActive = nil, "", ""
	}
	m.mu.Unlock()
}

// startPublisher starts the publisher the target wants, when none runs.
func (m *Manager) startPublisher(n int, t target) {
	m.mu.Lock()
	rt := m.rt[n-1]
	start := t.publish != nil && rt.proc == nil && rt.blocked == ""
	m.mu.Unlock()
	if !start {
		return
	}
	spec := supervisor.Spec{
		Name:    pathName(n),
		Path:    m.opts.FFmpeg,
		Args:    publishArgs(t.publish.abs, t.publish.codec, m.opts.RTSPBase+"/"+pathName(n)+"?"+m.opts.PublisherQuery),
		Env:     m.env,
		Restart: true,
		Grace:   publisherGrace,
		Output:  m.opts.Output,
	}
	proc, err := m.opts.Start(spec)
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		rt.blocked = fmt.Sprintf("The stream could not be started: %v", err)
		return
	}
	rt.proc, rt.procInput, rt.procActive = proc, t.publish.abs, t.publish.active
}

// clearPull clears MediaMTX's pull into slot n when the target wants none or another one: the
// one Insight set, or one a snapshot shows that this run did not set (MediaMTX kept it).
func (m *Manager) clearPull(n int, t target) {
	m.mu.Lock()
	rt := m.rt[n-1]
	path, known := m.snap.Paths[pathName(n)]
	applied := rt.appliedPull
	leftover := m.mtxUp && known && path.Pulled() && t.pull == "" && m.snap.At.After(rt.clearedAt)
	clear := (applied != "" && applied != t.pull) || leftover
	m.mu.Unlock()
	if !clear {
		return
	}
	ctx, cancel := context.WithTimeout(m.ctx, stopTimeout)
	defer cancel()
	err := m.opts.MediaMTX.ClearPullSource(ctx, pathName(n))
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		slog.Warn("a source's pull could not be cleared; trying again", "slot", pathName(n), "error", err)
		return
	}
	rt.appliedPull, rt.clearedAt = "", time.Now()
}

// setPull points slot n's path at the target's camera, unless MediaMTX pulls it already: it
// was set and no snapshot taken since shows the path without its pull (as after a restart of
// MediaMTX).
func (m *Manager) setPull(n int, t target) {
	if t.pull == "" {
		return
	}
	m.mu.Lock()
	rt := m.rt[n-1]
	path, known := m.snap.Paths[pathName(n)]
	lost := m.mtxUp && known && !path.Pulled() && m.snap.At.After(rt.pullAppliedAt)
	set := rt.appliedPull != t.pull || lost
	m.mu.Unlock()
	if !set {
		return
	}
	ctx, cancel := context.WithTimeout(m.ctx, stopTimeout)
	defer cancel()
	err := m.opts.MediaMTX.SetPullSource(ctx, pathName(n), t.pull)
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case errors.Is(err, mediamtx.ErrRejected):
		var apiErr *mediamtx.Error
		message := "MediaMTX refused the camera's URL."
		if errors.As(err, &apiErr) && apiErr.Message != "" {
			message = fmt.Sprintf("MediaMTX refused the camera's URL: %s.", apiErr.Message)
		}
		rt.blocked = message
	case err != nil:
		slog.Warn("a source's pull could not be set; trying again", "slot", pathName(n), "error", err)
	default:
		rt.appliedPull, rt.pullAppliedAt = t.pull, time.Now()
	}
}

// kickWebcam ends a browser's publishing on camN when slot n does not want a webcam: a stop,
// a reassignment, or a tab that kept publishing after either.
func (m *Manager) kickWebcam(n int, t target) {
	if t.webcam {
		return
	}
	m.mu.Lock()
	rt := m.rt[n-1]
	cam, ok := m.snap.Paths[camName(n)]
	var source mediamtx.Source
	if ok && cam.Source != nil {
		source = *cam.Source
	}
	kick := m.mtxUp && source.ID != "" && (source.ID != rt.kickedID || m.snap.At.After(rt.kickedAt))
	m.mu.Unlock()
	if !kick {
		return
	}
	ctx, cancel := context.WithTimeout(m.ctx, stopTimeout)
	defer cancel()
	err := m.opts.MediaMTX.Kick(ctx, source.Type, source.ID)
	if err != nil && !errors.Is(err, mediamtx.ErrNotFound) {
		slog.Warn("a webcam publisher could not be disconnected; trying again", "slot", pathName(n), "error", err)
		return
	}
	m.mu.Lock()
	rt.kickedID, rt.kickedAt = source.ID, time.Now()
	m.mu.Unlock()
}

// followRendition makes the slot wait for the rendition its target needs, starting its encode
// when none runs, and lets go of one it no longer needs, whose encode is cancelled when no other
// slot waits for it.
func (m *Manager) followRendition(n int, t target) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt := m.rt[n-1]
	previous := rt.rendition
	rt.rendition = ""
	if t.encode != nil && rt.blocked == "" {
		rt.rendition = t.encode.name
		if m.encodes[t.encode.name] == nil {
			m.startEncodeLocked(*t.encode)
		}
	}
	if previous != "" && previous != rt.rendition {
		m.releaseEncodeLocked(previous)
	}
}

// externalLocked returns slot n's path when a publisher Insight did not start holds it. A
// publisher of the slot's own is never taken for one, the file slot's or the normalizer of the
// webcam it takes: MediaMTX may show its session before the query that marks it as Insight's.
func (m *Manager) externalLocked(n int) *mediamtx.Path {
	path, ok := m.snap.Paths[pathName(n)]
	if !ok || !path.External() {
		return nil
	}
	if proc := m.rt[n-1].proc; proc != nil && proc.Status().Running {
		return nil
	}
	if d := m.store.get(n); d.Kind == KindWebcam && d.Run {
		if cam, ok := m.snap.Paths[camName(n)]; ok && cam.Source != nil && cam.Source.ID != "" {
			return nil
		}
	}
	return &path
}

// stamp identifies a version of a file's content, as the probe cache does.
type stamp struct{ size, mtime int64 }

// stampOf is the stamp of the file at abs, following links; false when it is no regular file.
func stampOf(abs string) (stamp, bool) {
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return stamp{}, false
	}
	return stamp{size: info.Size(), mtime: info.ModTime().UnixNano()}, true
}
