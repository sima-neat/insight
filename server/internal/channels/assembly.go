package channels

import "github.com/pion/rtp"

// An accessUnit is one picture's RTP packets, complete and in order, ready to be sent on.
type accessUnit struct {
	packets   [][]byte // the raw packets, which the forwarder may rewrite in place
	ssrc      uint32
	timestamp uint32
	// afterSequenceBreak is set when the source's sequence broke since the previous unit sent:
	// loss and a restart with the same SSRC look alike here, and only a restart can rewind the
	// source's clock, so its timestamp step is not trusted.
	afterSequenceBreak bool
}

// assembler collects a channel's packets into access units and passes on only whole ones.
//
// RTP marks a unit's end (the marker bit), never its start, so a unit whose first packet was lost
// still ends normally. Two things show the loss: a sequence gap, and a first packet whose payload
// does not begin a NAL unit (an FU fragment without its S bit). Either withholds the unit: a
// damaged picture would corrupt every picture decoded from it, and the outgoing sequence is
// renumbered (see sequencer), so the browser could not see the gap itself.
//
// For H.265 a loss also closes a gate that withholds every unit until the next random-access
// picture (an IRAP), since the units in between reference what was lost. H.264's decoders in
// browsers conceal such losses well enough that vf never gated them, nor does this.
type assembler struct {
	packets      [][]byte
	ssrc         uint32
	timestamp    uint32
	codec        Codec
	active       bool // a unit is being collected
	complete     bool // its first packet began a NAL unit
	damaged      bool // a sequence gap fell inside it, or between it and the unit before
	randomAccess bool

	nextSequence  uint16
	sequenceSSRC  uint32
	haveSequence  bool
	sequenceBreak bool // a gap since the last unit passed on

	waitingForRandomAccess bool // the H.265 gate is closed
}

func newAssembler() *assembler { return &assembler{waitingForRandomAccess: true} }

// rearm closes the H.265 gate again, so the next viewer starts at a random-access picture.
func (a *assembler) rearm() { a.waitingForRandomAccess = true }

// accept takes one packet (parsed, and its raw bytes) and returns the unit it completes, if a
// whole one.
func (a *assembler) accept(packet *rtp.Packet, raw []byte) (accessUnit, bool) {
	codec := codecOf(packet.PayloadType)
	if codec == CodecNone {
		return accessUnit{}, false
	}
	units := nalsOf(codec, packet.Payload)
	starts := len(units) > 0 && units[0].Start
	randomAccess := false
	if codec == CodecH265 {
		for _, unit := range units {
			randomAccess = randomAccess || isRandomAccess(codec, unit)
		}
	}

	// A new SSRC is a new sender: it has no sequence to compare with, and what it interrupts
	// belonged to the old one.
	sameSource := a.haveSequence && packet.SSRC == a.sequenceSSRC
	gap := sameSource && packet.SequenceNumber != a.nextSequence
	a.sequenceBreak = a.sequenceBreak || gap
	a.nextSequence, a.sequenceSSRC, a.haveSequence = packet.SequenceNumber+1, packet.SSRC, true

	if !a.active || packet.SSRC != a.ssrc || packet.Timestamp != a.timestamp {
		// A unit left unfinished by the same source lost its end.
		abandoned := a.active && sameSource
		a.packets = a.packets[:0]
		a.ssrc, a.timestamp, a.codec = packet.SSRC, packet.Timestamp, codec
		a.complete, a.damaged, a.randomAccess, a.active = starts, abandoned || gap, randomAccess, true
	} else if gap {
		a.complete, a.damaged = false, true
	}
	a.packets = append(a.packets, raw)
	a.randomAccess = a.randomAccess || randomAccess
	if !packet.Marker {
		return accessUnit{}, false
	}

	unit := accessUnit{packets: a.packets, ssrc: a.ssrc, timestamp: a.timestamp}
	whole := a.complete && !a.damaged
	a.packets, a.active = nil, false
	if a.codec == CodecH265 && !whole {
		a.waitingForRandomAccess = true
	}
	if !whole {
		return accessUnit{}, false
	}
	if a.randomAccess {
		a.waitingForRandomAccess = false
	}
	if a.codec == CodecH265 && a.waitingForRandomAccess {
		return accessUnit{}, false
	}
	unit.afterSequenceBreak = a.sequenceBreak
	a.sequenceBreak = false
	return unit, true
}
