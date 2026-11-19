package channels

import (
	"encoding/binary"
	"errors"
	"time"
)

const (
	// firstOutgoingTimestamp starts every channel's outgoing clock; browsers need no particular
	// value, only a steady one.
	firstOutgoingTimestamp = uint32(1110000000)
	// maxSourceStep: a source step larger than 5 s is a sender discontinuity, so one bad source
	// cannot move the browser's presentation clock seconds at once.
	maxSourceStep = int32(5 * clockRate)
)

// timeline maps a source's RTP timestamps onto one outgoing clock that survives the source
// restarting, changing SSRC or jumping.
//
// A frame normally moves the outgoing clock by the source's own step, signed, so B-frames sent in
// decode order keep their backward steps. After a discontinuity (a sequence break, a new SSRC, a
// step over 5 s, a repeated timestamp) the step is the time since the last frame instead, and the
// clock is held above the highest timestamp sent, so frames after it never land on or behind
// frames the browser already has.
type timeline struct {
	next       uint32
	max        uint32
	holdingMax bool
	lastSource uint32
	lastSSRC   uint32
	lastAt     time.Time
	started    bool
}

func newTimeline() timeline { return timeline{next: firstOutgoingTimestamp} }

// frame returns the outgoing timestamp for a source frame arriving now.
func (t *timeline) frame(source, ssrc uint32, afterSequenceBreak bool, now time.Time) uint32 {
	if t.started {
		step := int32(source - t.lastSource)
		discontinuity := afterSequenceBreak || ssrc != t.lastSSRC || step > maxSourceStep || step < -maxSourceStep
		t.holdingMax = t.holdingMax || discontinuity
		next := t.next + uint32(step)
		if discontinuity || step == 0 || (t.holdingMax && int32(next-t.max) <= 0) {
			base := t.next
			if t.holdingMax {
				base = t.max
			}
			elapsed := uint32(float64(clockRate) * now.Sub(t.lastAt).Seconds())
			next = base + max(elapsed, 1)
		} else {
			t.holdingMax = false
		}
		t.next = next
	}
	if !t.started || int32(t.next-t.max) > 0 {
		t.max = t.next
	}
	t.lastSource, t.lastSSRC, t.lastAt, t.started = source, ssrc, now, true
	return t.next
}

// sequencer numbers outgoing packets in one continuous sequence. Pion sends the sequence numbers
// it is given, so withheld units and source restarts would otherwise show browsers gaps and
// jumps.
type sequencer struct {
	next    uint16
	started bool
}

const rtpHeaderSize = 12

var errShortPacket = errors.New("an RTP packet shorter than its fixed header")

// stamp writes the next sequence number and timestamp into raw's fixed RTP header, in place.
func (s *sequencer) stamp(raw []byte, timestamp uint32) error {
	if len(raw) < rtpHeaderSize {
		return errShortPacket
	}
	if !s.started {
		s.next, s.started = binary.BigEndian.Uint16(raw[2:4]), true
	}
	binary.BigEndian.PutUint16(raw[2:4], s.next)
	binary.BigEndian.PutUint32(raw[4:8], timestamp)
	s.next++
	return nil
}
