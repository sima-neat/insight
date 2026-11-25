package channels

import "github.com/pion/rtp"

// maxUnitBytes caps the bytes of the RTP packets one access unit may collect, counted as they
// arrived (each datagram whole, its RTP header included), since its packets are held until its
// marker and a sender decides how many come before it. It bounds that count, not the memory
// that holds it (a slice per packet beside it). 16 MiB is above the uncompressed size
// of the largest picture H.264 level 5.2 and H.265 level 5.x allow (4096 × 2304 and 8,912,896
// luma samples in 4:2:0, about 14 MB), which an encoded picture of those levels never needs.
const maxUnitBytes = 16 << 20

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
// does not begin the picture (see startsPicture: an FU fragment without its S bit, a JPEG fragment
// at an offset other than 0). Either withholds the unit: a damaged picture would corrupt every
// picture decoded from it, and the outgoing sequence is renumbered (see sequencer), so the browser
// could not see the gap itself. A unit left unfinished, when a packet of another unit arrives
// before its marker, is withheld too.
//
// For H.264 and H.265 a loss before a unit's first packet (the unit before lost its end, or whole
// packets fell between them) damages the unit as well, since a lost picture may be referenced by
// the next. A JPEG frame references nothing, so only a gap inside it or a missing start damages
// it: a frame that starts at offset 0 and has no gap inside it is whole, whatever was lost before.
//
// A unit that grows over maxUnitBytes is dropped as a damaged one is: its packets are let go at
// once and the rest of it, up to its marker, is not kept.
//
// Each unit withheld for a loss, or left unfinished, is counted once as incomplete; one dropped
// for its size is counted as oversized instead, and a whole one the H.265 gate holds is not
// counted.
//
// For H.265 a loss also closes a gate that withholds every unit until the next random-access
// picture (an IRAP), since the units in between reference what was lost. H.264's decoders in
// browsers conceal such losses well enough that this does not gate them.
type assembler struct {
	packets      [][]byte
	size         int // the bytes of packets
	ssrc         uint32
	timestamp    uint32
	codec        Codec
	active       bool // a unit is being collected
	complete     bool // its first packet began the picture
	damaged      bool // a sequence gap fell inside it (H.264 and H.265: or between it and the unit before)
	oversized    bool // it grew over maxUnitBytes
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

// acceptResult is what one packet did. unit is the unit it completed, if ready, a whole one.
// oversized is true for the packet that took its unit over maxUnitBytes, once a unit. incomplete
// is how many units it ended without passing them on because a packet was lost or never came (a
// unit its sender left unfinished).
type acceptResult struct {
	unit             accessUnit
	ready, oversized bool
	incomplete       int
}

// accept takes one packet (parsed, and its raw bytes).
func (a *assembler) accept(packet *rtp.Packet, raw []byte) (result acceptResult) {
	codec := codecOf(packet.PayloadType)
	if codec == CodecNone {
		return result
	}
	starts := startsPicture(codec, packet.Payload)
	randomAccess := false
	if codec == CodecH265 {
		for _, unit := range h265NALs(packet.Payload) {
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
		// A unit left unfinished lost its end, or its sender stopped. Only the same source's next
		// unit is damaged by it: a new sender's first unit owes nothing to the old one's.
		if a.active && !a.oversized {
			result.incomplete++
		}
		abandoned := a.active && sameSource
		a.packets, a.size = a.packets[:0], 0
		a.ssrc, a.timestamp, a.codec = packet.SSRC, packet.Timestamp, codec
		// A JPEG frame references nothing, so a loss before it does not damage it.
		a.complete, a.damaged, a.randomAccess, a.active = starts, codec != CodecJPEG && (abandoned || gap), randomAccess, true
		a.oversized = false
	} else if gap {
		a.complete, a.damaged = false, true
	}
	switch {
	case a.oversized:
	case a.size+len(raw) > maxUnitBytes:
		a.packets, a.size, a.oversized, a.damaged, result.oversized = nil, 0, true, true, true
	default:
		a.packets, a.size = append(a.packets, raw), a.size+len(raw)
	}
	a.randomAccess = a.randomAccess || randomAccess
	if !packet.Marker {
		return result
	}

	unit := accessUnit{packets: a.packets, ssrc: a.ssrc, timestamp: a.timestamp}
	whole := a.complete && !a.damaged
	a.packets, a.size, a.active = nil, 0, false
	if a.codec == CodecH265 && !whole {
		a.waitingForRandomAccess = true
	}
	if !whole {
		if !a.oversized {
			result.incomplete++
		}
		return result
	}
	if a.randomAccess {
		a.waitingForRandomAccess = false
	}
	if a.codec == CodecH265 && a.waitingForRandomAccess {
		return result
	}
	unit.afterSequenceBreak = a.sequenceBreak
	a.sequenceBreak = false
	result.unit, result.ready = unit, true
	return result
}
