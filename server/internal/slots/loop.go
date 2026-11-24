package slots

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"insight/internal/mediamtx"
)

// loop takes a MediaMTX snapshot every second (or when an operation asks for one), starts the
// stream probes it calls for, and reconciles every slot after it.
func (m *Manager) loop() {
	defer m.done.Done()
	ticker := time.NewTicker(m.opts.snapshotEvery)
	defer ticker.Stop()
	for {
		m.tick()
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
		case <-m.refresh:
		}
	}
}

func (m *Manager) tick() {
	ctx, cancel := context.WithTimeout(m.ctx, 2*time.Second)
	snap, err := m.opts.MediaMTX.Snapshot(ctx)
	cancel()
	if m.ctx.Err() != nil {
		return
	}
	m.mu.Lock()
	if err != nil {
		if m.mtxUp {
			slog.Warn("MediaMTX's API does not answer; the sources' streams are unknown", "error", err)
		}
		m.mtxUp, m.snap, m.prev = false, mediamtx.Snapshot{}, mediamtx.Snapshot{}
	} else {
		if !m.mtxUp {
			// MediaMTX (re)started, or the API answers again: what it was told before may be
			// gone with its runtime configuration, so every pull is set again.
			for _, rt := range m.rt {
				rt.appliedPull = ""
			}
		}
		m.mtxUp, m.prev, m.snap = true, m.snap, snap
	}
	m.scheduleProbesLocked()
	m.mu.Unlock()
	m.wakeAll()
}

// scheduleProbesLocked starts the probes the snapshot calls for: of a pull that is not live,
// so the slot can say why, and of a stream Insight knows nothing about, for its size and rate.
// m.mu is held.
func (m *Manager) scheduleProbesLocked() {
	now := time.Now()
	for i, rt := range m.rt {
		n := i + 1
		d := m.store.get(n)
		path, known := m.snap.Paths[pathName(n)]
		if d.Kind == KindPull && d.Run && rt.fullURL != "" && !(known && path.Ready) &&
			!rt.pullProbe.running && rt.pullProbe.status != PullAuthFailed && now.Sub(rt.pullProbe.at) >= pullProbeEvery {
			rt.pullProbe.running = true
			url := rt.fullURL
			m.background(func() { m.probePull(n, url) })
		}
		key := path.StreamKey()
		ours := d.Kind == KindFile && rt.proc != nil
		if known && path.Ready && key != "" && !ours && rt.stats.key != key && !rt.stats.running {
			rt.stats = streamStats{key: key, running: true}
			m.background(func() { m.probeStats(n, key) })
		}
	}
}

// probePull probes slot n's camera again.
func (m *Manager) probePull(n int, url string) {
	err := m.probeCameraCtx(m.ctx, url)
	m.mu.Lock()
	rt := m.rt[n-1]
	rt.pullProbe.running = false
	if rt.fullURL != url {
		m.mu.Unlock()
		return // the slot pulls another camera now
	}
	rt.pullProbe.at = time.Now()
	rt.pullProbe.status, rt.pullProbe.err = probeOutcome(err)
	auth := rt.pullProbe.status == PullAuthFailed
	m.mu.Unlock()
	if auth {
		slog.Warn("a camera refused the credentials; its pull is paused", "slot", pathName(n))
		m.wake(n)
	}
}

// probeOutcome is a pull probe's status and why.
func probeOutcome(err error) (PullStatus, string) {
	var probeErr *ProbeError
	switch {
	case err == nil:
		return PullConnecting, ""
	case errors.As(err, &probeErr) && probeErr.Auth:
		return PullAuthFailed, "The camera rejected the username or password."
	case errors.As(err, &probeErr) && probeErr.Detail != "":
		return PullUnreachable, probeErr.Detail
	}
	return PullUnreachable, "The camera did not answer."
}

// background runs f in a goroutine Close waits for; called from the loop, whose own count keeps
// the wait group above zero meanwhile.
func (m *Manager) background(f func()) {
	m.done.Add(1)
	go func() {
		defer m.done.Done()
		f()
	}()
}

// probeStats probes the stream slot n's path carries, which key names.
func (m *Manager) probeStats(n int, key string) {
	info, err := m.probeInfo(m.opts.RTSPBase + "/" + pathName(n) + "?" + mediamtx.ProbeReaderQuery)
	m.mu.Lock()
	defer m.mu.Unlock()
	rt := m.rt[n-1]
	if rt.stats.key != key {
		return
	}
	rt.stats = streamStats{key: key, info: info, ok: err == nil}
}

// probeInfo runs one of the loop's stream probes, which end with the Manager.
func (m *Manager) probeInfo(url string) (StreamInfo, error) {
	return m.probeInfoCtx(m.ctx, url)
}
