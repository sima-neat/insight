package slots

import (
	"context"
	"errors"
	"net/http"
	"time"

	"insight/internal/apierr"
	"insight/internal/media"
	"insight/internal/mediamtx"
)

// List returns every slot as it stands, from memory: for a browser that reached Insight at host
// (the request's Host), which the slots' URLs name.
func (m *Manager) List(host string) []Slot {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Slot, Count)
	for n := 1; n <= Count; n++ {
		out[n-1] = derive(m.observeLocked(n, host))
	}
	return out
}

// Slot returns slot n as it stands, as List does.
func (m *Manager) Slot(n int, host string) (Slot, error) {
	if err := checkSlot(n); err != nil {
		return Slot{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return derive(m.observeLocked(n, host)), nil
}

// change replaces slot n's desired state with what edit makes of it, unless edit refuses, then
// saves the store and reconciles the slot. edit runs under m.mu.
func (m *Manager) change(n int, edit func(d *Desired, rt *slotRuntime) error) error {
	if err := checkSlot(n); err != nil {
		return err
	}
	m.mu.Lock()
	d := m.store.get(n)
	rt := m.rt[n-1]
	if err := edit(&d, rt); err != nil {
		m.mu.Unlock()
		return err
	}
	m.store.set(n, d)
	m.mu.Unlock()
	m.save()
	m.wake(n)
	return nil
}

// refuseExternalLocked refuses an operation on a slot a foreign publisher holds; m.mu is held.
func (m *Manager) refuseExternalLocked(n int) error {
	if path := m.externalLocked(n); path != nil {
		return slotBusy(n, path.Source.Protocol, path.Source.Address)
	}
	return nil
}

// AssignFile makes slot n stream the library file file, at fps frames per second or, with fps
// 0, at the file's own rate. A slot that streamed a file before keeps running, with the new one;
// any other slot is stopped. A file not probed yet is accepted and checked when it is.
func (m *Manager) AssignFile(n int, file string, fps int) error {
	if err := checkSlot(n); err != nil {
		return err
	}
	if fps < 0 {
		return newError(http.StatusBadRequest, CodeInvalidFPS, "The frame rate must be a whole number of at least 1.")
	}
	abs, err := m.resolveFile(file)
	if err != nil {
		return err
	}
	if info, ok := m.opts.Probes.Get(abs); ok {
		if !info.Streamable() {
			return notStreamable(file, info)
		}
		if fps > 0 && fps != nativeFPS(info) {
			if err := checkRendition(file, info, fps); err != nil {
				return err
			}
		}
	} else {
		m.opts.Probes.Want(abs)
	}
	return m.change(n, func(d *Desired, rt *slotRuntime) error {
		if err := m.refuseExternalLocked(n); err != nil {
			return err
		}
		run := d.Kind == KindFile && d.Run
		*d = Desired{Kind: KindFile, File: file, FPS: fps, Run: run}
		rt.fullURL, rt.blocked = "", ""
		return nil
	})
}

// resolveFile checks that file is a regular file of the library and returns its absolute path.
func (m *Manager) resolveFile(file string) (string, error) {
	abs, err := media.Resolve(m.root, file)
	if errors.Is(err, media.ErrInvalidPath) {
		return "", newError(http.StatusBadRequest, CodeInvalidPath, "%s is not a path in the media library.", file)
	}
	if err != nil {
		return "", err
	}
	if _, ok := stampOf(abs); !ok {
		return "", newError(http.StatusNotFound, CodeFileNotFound, "%s is not in the media library.", file)
	}
	return abs, nil
}

func notStreamable(file string, info media.Info) *apierr.Error {
	what := "it has no video"
	switch {
	case info.Problem != "":
		what = info.Problem
	case info.Codec != "":
		what = "its codec is " + media.CodecName(info.Codec)
	}
	return withHint(newError(http.StatusBadRequest, CodeNotStreamable,
		"%s cannot be streamed: %s.", file, what), "A source streams H.264, H.265 or MJPEG.")
}

// AssignPull makes slot n pull a camera: MediaMTX pulls url (rtsp:// or rtsps://) and forwards
// its stream unchanged. user and password, when given, replace credentials in the URL. The
// camera is probed first: a camera that refuses the credentials or does not answer is not
// assigned (CodePullAuthFailed, CodePullUnreachable). The credentials are kept in memory only.
// The slot starts pulling at once.
func (m *Manager) AssignPull(ctx context.Context, n int, url, user, password string) error {
	if err := checkSlot(n); err != nil {
		return err
	}
	pull, err := parsePullURL(url, user, password)
	if err != nil {
		return err
	}
	m.mu.Lock()
	err = m.refuseExternalLocked(n)
	m.mu.Unlock()
	if err != nil {
		return err
	}
	err = m.probeCameraCtx(ctx, pull.full)
	if err != nil {
		var probeErr *ProbeError
		switch {
		case ctx.Err() != nil:
			return ctx.Err()
		case errors.As(err, &probeErr) && probeErr.Auth && pull.user == "":
			return newError(http.StatusUnprocessableEntity, CodePullAuthFailed, "The camera at %s requires a username and password.", pull.target.Host)
		case errors.As(err, &probeErr) && probeErr.Auth:
			return newError(http.StatusUnprocessableEntity, CodePullAuthFailed, "The camera at %s rejected the username or password.", pull.target.Host)
		}
		detail := "it did not answer"
		if errors.As(err, &probeErr) && probeErr.Detail != "" {
			detail = pull.redact(probeErr.Detail)
		}
		return newError(http.StatusBadGateway, CodePullUnreachable, "The camera at %s could not be reached: %s.", pull.target.Host, detail)
	}
	// The view the check above used predates the probe, which can take seconds: a publisher
	// that connected meanwhile is in a fresh one, and a MediaMTX that does not answer means
	// nobody can say the slot is still free.
	fresh, err := m.takeSnapshot()
	switch {
	case m.ctx.Err() != nil:
		return newError(http.StatusServiceUnavailable, CodeShuttingDown, "Insight is shutting down.")
	case err != nil:
		return newError(http.StatusServiceUnavailable, CodeMediaMTXDown,
			"src%d cannot be checked as still free: MediaMTX does not answer. Try again.", n)
	}
	defer m.requestSnapshot() // the loop catches up with what this reading showed
	return m.change(n, func(d *Desired, rt *slotRuntime) error {
		if path := m.externalIn(fresh, n); path != nil {
			return slotBusy(n, path.Source.Protocol, path.Source.Address)
		}
		target := pull.target
		*d = Desired{Kind: KindPull, Pull: &target, Run: true}
		rt.fullURL, rt.blocked = pull.full, ""
		rt.pullProbe = pullProbe{status: PullConnecting, at: time.Now()}
		return nil
	})
}

// probeInfoCtx runs one stream probe of a MediaMTX path, probeCameraCtx one of a pull's camera,
// at most streamProbes of either at once, until ctx (a request's) or the Manager ends.
func (m *Manager) probeInfoCtx(ctx context.Context, url string) (info StreamInfo, err error) {
	err = m.limitProbe(ctx, func(ctx context.Context) error {
		info, err = m.opts.probeStream(ctx, url)
		return err
	})
	return info, err
}

func (m *Manager) probeCameraCtx(ctx context.Context, url string) error {
	return m.limitProbe(ctx, func(ctx context.Context) error { return m.opts.probeCamera(ctx, url) })
}

func (m *Manager) limitProbe(ctx context.Context, probe func(context.Context) error) error {
	select {
	case m.probing <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	case <-m.ctx.Done():
		return newError(http.StatusServiceUnavailable, CodeShuttingDown, "Insight is shutting down.")
	}
	defer func() { <-m.probing }()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(m.ctx, cancel)
	defer stop()
	return probe(ctx)
}

// AssignWebcam makes slot n a webcam's and returns where the browser publishes it (WHIP) for a
// browser that reached Insight at host. MediaMTX re-encodes what the browser publishes onto
// srcN. The slot is ready at once: Stop disconnects whatever publishes on it.
func (m *Manager) AssignWebcam(n int, host string) (string, error) {
	err := m.change(n, func(d *Desired, rt *slotRuntime) error {
		if err := m.refuseExternalLocked(n); err != nil {
			return err
		}
		*d = Desired{Kind: KindWebcam, Run: true}
		rt.fullURL, rt.blocked = "", ""
		return nil
	})
	if err != nil {
		return "", err
	}
	return m.urls.whip(host, n), nil
}

// Clear leaves slot n with nothing assigned, and stopped. A foreign publisher on it is left
// alone.
func (m *Manager) Clear(n int) error {
	return m.change(n, func(d *Desired, rt *slotRuntime) error {
		*d = Desired{Kind: KindNone}
		rt.fullURL, rt.blocked = "", ""
		return nil
	})
}

// Start makes slot n run: a file slot streams (after encoding its rendition, when it needs one),
// a pull slot pulls, a webcam slot takes a browser's camera. It returns before the stream is
// live; the slot's state says how it goes. Starting a slot that failed tries again.
func (m *Manager) Start(n int) error {
	if err := checkSlot(n); err != nil {
		return err
	}
	m.mu.Lock()
	d := m.store.get(n)
	m.mu.Unlock()
	if d.Kind == KindFile {
		if _, err := m.resolveFile(d.File); err != nil {
			return err
		}
	}
	m.mu.Lock()
	err := m.startLocked(n)
	m.mu.Unlock()
	if err != nil {
		return err
	}
	m.wake(n)
	return nil
}

// startLocked sets slot n running, or says why it cannot; m.mu is held.
func (m *Manager) startLocked(n int) error {
	d, rt := m.store.get(n), m.rt[n-1]
	switch {
	case d.Kind == KindNone:
		return newError(http.StatusConflict, CodeNothingAssigned, "src%d has nothing assigned.", n)
	case d.Kind == KindPull && rt.fullURL == "":
		return newError(http.StatusConflict, CodePullCredentials,
			"Insight keeps no camera credentials across a restart, so src%d needs its stream URL again.", n)
	}
	if err := m.refuseExternalLocked(n); err != nil {
		return err
	}
	m.store.setRun(n, true)
	rt.blocked = ""
	if d.Kind == KindPull {
		rt.pullProbe = pullProbe{status: PullConnecting, at: time.Now()}
	}
	return nil
}

// Stop makes slot n stop: its publisher is stopped, its rendition's encode cancelled (unless
// another slot waits for it), its pull cleared, and its webcam's publisher disconnected. The
// assignment stays.
func (m *Manager) Stop(n int) error {
	if err := checkSlot(n); err != nil {
		return err
	}
	m.mu.Lock()
	m.store.setRun(n, false)
	m.mu.Unlock()
	m.wake(n)
	return nil
}

// TakeOver disconnects the foreign publisher that holds slot n, so the slot's own assignment can
// run; the publisher may connect again at once, which Insight does not prevent.
func (m *Manager) TakeOver(ctx context.Context, n int) error {
	if err := checkSlot(n); err != nil {
		return err
	}
	m.mu.Lock()
	up := m.mtxUp
	path := m.externalLocked(n)
	m.mu.Unlock()
	switch {
	case !up:
		return newError(http.StatusServiceUnavailable, CodeMediaMTXDown, "MediaMTX does not answer, so the publisher cannot be disconnected.")
	case path == nil:
		return newError(http.StatusConflict, CodeNotExternal, "src%d is not held by an external publisher.", n)
	}
	err := m.opts.MediaMTX.Kick(ctx, path.Source.Type, path.Source.ID)
	if err != nil && !errors.Is(err, mediamtx.ErrNotFound) {
		return newError(http.StatusBadGateway, CodeMediaMTXFailed, "src%d's publisher could not be disconnected: %v", n, err)
	}
	m.requestSnapshot()
	return nil
}

// StartResult is what StartFirst did.
type StartResult struct {
	Started         []int         `json:"started"`
	AlreadyRunning  []int         `json:"already_running"`
	SkippedExternal []int         `json:"skipped_external"`
	Errors          []SlotFailure `json:"errors"`
}

// SlotFailure is a slot a bulk operation could not do, and why.
type SlotFailure struct {
	N     int    `json:"n"`
	Code  string `json:"code"`
	Error string `json:"error"`
}

// StartFirst starts the first count file slots, in their order, that a foreign publisher does
// not hold. It returns at once; the slots' states say how each goes.
func (m *Manager) StartFirst(count int) (StartResult, error) {
	if count < 1 {
		return StartResult{}, newError(http.StatusBadRequest, CodeInvalidCount, "The number of sources to start must be at least 1.")
	}
	result := StartResult{Started: []int{}, AlreadyRunning: []int{}, SkippedExternal: []int{}, Errors: []SlotFailure{}}
	type candidate struct {
		n    int
		file string
		run  bool
	}
	var targets []candidate
	m.mu.Lock()
	assigned := 0
	for n := 1; n <= Count && len(targets) < count; n++ {
		d := m.store.get(n)
		if d.Kind != KindFile {
			continue
		}
		assigned++
		if m.externalLocked(n) != nil {
			result.SkippedExternal = append(result.SkippedExternal, n)
			continue
		}
		targets = append(targets, candidate{n, d.File, d.Run})
	}
	m.mu.Unlock()
	if assigned == 0 {
		return result, newError(http.StatusConflict, CodeNothingAssigned, "No source has a file assigned.")
	}
	for _, c := range targets {
		if c.run {
			result.AlreadyRunning = append(result.AlreadyRunning, c.n)
			continue
		}
		if _, err := m.resolveFile(c.file); err != nil {
			result.Errors = append(result.Errors, failureOf(c.n, err))
			continue
		}
		m.mu.Lock()
		err := m.startLocked(c.n)
		m.mu.Unlock()
		if err != nil {
			result.Errors = append(result.Errors, failureOf(c.n, err))
			continue
		}
		result.Started = append(result.Started, c.n)
		m.wake(c.n)
	}
	return result, nil
}

func failureOf(n int, err error) SlotFailure {
	var e *apierr.Error
	if errors.As(err, &e) {
		return SlotFailure{N: n, Code: e.Code, Error: e.Message}
	}
	return SlotFailure{N: n, Code: "internal_error", Error: err.Error()}
}

// StopResult is what StopAll and Reset did.
type StopResult struct {
	// Stopped are the slots that were to run.
	Stopped []int `json:"stopped"`
	// SkippedExternal are the slots a foreign publisher holds, whose streams go on.
	SkippedExternal []int `json:"skipped_external"`
}

// StopAll stops every slot, as Stop does; foreign publishers go on.
func (m *Manager) StopAll() StopResult {
	return m.stopEvery(false)
}

// Reset stops every slot and leaves each with nothing assigned; foreign publishers go on.
func (m *Manager) Reset() StopResult {
	return m.stopEvery(true)
}

func (m *Manager) stopEvery(clear bool) StopResult {
	result := StopResult{Stopped: []int{}, SkippedExternal: []int{}}
	m.mu.Lock()
	for n := 1; n <= Count; n++ {
		if m.store.get(n).Run {
			result.Stopped = append(result.Stopped, n)
		}
		if m.externalLocked(n) != nil {
			result.SkippedExternal = append(result.SkippedExternal, n)
		}
		if clear {
			m.store.set(n, Desired{Kind: KindNone})
			m.rt[n-1].fullURL, m.rt[n-1].blocked = "", ""
		} else {
			m.store.setRun(n, false)
		}
	}
	m.mu.Unlock()
	if clear {
		m.save()
	}
	m.wakeAll()
	return result
}

// AutoAssignResult is what AutoAssign did.
type AutoAssignResult struct {
	// Assigned counts the slots given a file.
	Assigned int `json:"assigned"`
	// Available counts the files there were to give.
	Available int `json:"available"`
	// SkippedExternal and SkippedPulled are the slots left as they were: held by a foreign
	// publisher, or pulling a camera.
	SkippedExternal []int `json:"skipped_external"`
	SkippedPulled   []int `json:"skipped_pulled"`
}

// AutoAssign gives the slots the library files files (library paths, in the order to give
// them), one each, every slot stopped. Slots held by a foreign publisher or pulling a camera
// keep what they have, and so do their files; slots beyond the files are cleared. A file the
// probes say cannot be streamed is left out; one not probed yet is given (and checked when it
// is). A slot keeps its frame rate when it keeps its file.
func (m *Manager) AutoAssign(files []string) AutoAssignResult {
	var usable []string
	seen := map[string]bool{}
	for _, file := range files {
		if seen[file] {
			continue
		}
		seen[file] = true
		abs, err := m.resolveFile(file)
		if err != nil {
			continue
		}
		if info, ok := m.opts.Probes.Get(abs); ok {
			if !info.Streamable() {
				continue
			}
		} else {
			m.opts.Probes.Want(abs)
		}
		usable = append(usable, file)
	}

	result := AutoAssignResult{SkippedExternal: []int{}, SkippedPulled: []int{}}
	m.mu.Lock()
	kept := map[string]bool{}
	skip := make([]bool, Count+1)
	for n := 1; n <= Count; n++ {
		d := m.store.get(n)
		switch {
		case m.externalLocked(n) != nil:
			result.SkippedExternal = append(result.SkippedExternal, n)
		case d.Kind == KindPull:
			result.SkippedPulled = append(result.SkippedPulled, n)
		default:
			continue
		}
		skip[n] = true
		if d.Kind == KindFile {
			kept[d.File] = true
		}
	}
	var pool []string
	for _, file := range usable {
		if !kept[file] {
			pool = append(pool, file)
		}
	}
	result.Available = len(pool)
	for n := 1; n <= Count; n++ {
		d := m.store.get(n)
		if skip[n] {
			m.store.setRun(n, false)
			continue
		}
		next := Desired{Kind: KindNone}
		if len(pool) > 0 {
			next = Desired{Kind: KindFile, File: pool[0]}
			if d.Kind == KindFile && d.File == pool[0] {
				next.FPS = d.FPS
			}
			pool = pool[1:]
			result.Assigned++
		}
		m.store.set(n, next)
		m.rt[n-1].fullURL, m.rt[n-1].blocked = "", ""
	}
	m.mu.Unlock()
	m.save()
	m.wakeAll()
	return result
}
