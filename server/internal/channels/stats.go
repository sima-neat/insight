package channels

import (
	"fmt"
	"net/netip"
	"sync"
	"time"
)

const (
	// activeFor: a side is active while its last packet is this recent.
	activeFor = 3 * time.Second
	// rateWindow is how long rates are measured over.
	rateWindow   = time.Second
	recentErrors = 8
)

// rate measures a count and bytes per second over windows of rateWindow.
type rate struct {
	started              time.Time
	count, bytes         uint64
	perSecond, bitsPerSc float64
}

func (r *rate) add(bytes int, now time.Time) {
	if r.started.IsZero() {
		r.started = now
	}
	r.count++
	r.bytes += uint64(bytes)
	if elapsed := now.Sub(r.started); elapsed >= rateWindow {
		seconds := elapsed.Seconds()
		r.perSecond, r.bitsPerSc = float64(r.count)/seconds, float64(r.bytes)*8/seconds
		r.started, r.count, r.bytes = now, 0, 0
	}
}

// at reads the rates, zero once the side has gone quiet.
func (r *rate) at(active bool) (perSecond, bitsPerSecond float64) {
	if !active {
		return 0, 0
	}
	return round1(r.perSecond), round1(r.bitsPerSc)
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }

// stats are one channel's counters. Written by its readers and its delivery, read by the API.
type stats struct {
	mu sync.Mutex

	video struct {
		first, last  time.Time
		remote       netip.AddrPort
		packets      uint64
		bytes        uint64
		rate         rate
		ssrc         uint32
		payloadType  uint8
		codec        Codec
		malformed    uint64
		unsupported  uint64 // packets of a payload type Insight does not play
		oversized    uint64 // frames dropped for growing over maxUnitBytes
		keyframes    uint64
		lastKeyframe uint32 // its RTP time, so a keyframe of several packets counts once
		seenSPS      bool
	}
	metadata struct {
		first, last time.Time
		remote      netip.AddrPort
		received    uint64
		bytes       uint64
		rate        rate
		invalid     uint64
		forwarded   uint64 // messages sent to at least one browser
	}
	errors []string
}

func (s *stats) videoPacket(codec Codec, payloadType uint8, ssrc, timestamp uint32, payload []byte, size int, from netip.AddrPort, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := &s.video
	if v.first.IsZero() {
		v.first = now
	}
	v.last, v.remote = now, from
	v.packets++
	v.bytes += uint64(size)
	v.rate.add(size, now)
	v.payloadType = payloadType
	if codec == CodecNone {
		v.unsupported++
		return
	}
	if codec != v.codec {
		v.codec, v.keyframes, v.seenSPS = codec, 0, false
	}
	v.ssrc = ssrc
	for _, unit := range nalsOf(codec, payload) {
		if isRandomAccess(codec, unit) && (v.keyframes == 0 || v.lastKeyframe != timestamp) {
			v.keyframes++
			v.lastKeyframe = timestamp
		}
		v.seenSPS = v.seenSPS || isSequenceParameterSet(codec, unit)
	}
}

func (s *stats) count(counter func(*stats)) {
	s.mu.Lock()
	counter(s)
	s.mu.Unlock()
}

func (s *stats) metadataMessage(size int, valid bool, from netip.AddrPort, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := &s.metadata
	if m.first.IsZero() {
		m.first = now
	}
	m.last, m.remote = now, from
	m.received++
	m.bytes += uint64(size)
	m.rate.add(size, now)
	if !valid {
		m.invalid++
	}
}

func (s *stats) failed(format string, args ...any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.errors = append(s.errors, time.Now().UTC().Format(time.RFC3339)+" "+fmt.Sprintf(format, args...))
	if len(s.errors) > recentErrors {
		s.errors = s.errors[len(s.errors)-recentErrors:]
	}
}
