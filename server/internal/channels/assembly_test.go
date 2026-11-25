package channels

import (
	"testing"
	"time"

	"github.com/pion/rtp"
)

type testPacket struct {
	packet *rtp.Packet
	raw    []byte
}

func packetOf(t *testing.T, payloadType uint8, sequence uint16, timestamp uint32, marker bool, payload []byte) testPacket {
	t.Helper()
	packet := &rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: payloadType, SequenceNumber: sequence, Timestamp: timestamp, SSRC: 99, Marker: marker},
		Payload: payload,
	}
	raw, err := packet.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return testPacket{packet, raw}
}

func h265(t *testing.T, sequence uint16, timestamp uint32, marker bool, payload []byte) testPacket {
	return packetOf(t, payloadTypeH265, sequence, timestamp, marker, payload)
}

func h264(t *testing.T, sequence uint16, timestamp uint32, marker bool, payload []byte) testPacket {
	return packetOf(t, payloadTypeH264, sequence, timestamp, marker, payload)
}

var (
	h265IRAP  = []byte{0x26, 0x01} // type 19, IDR_W_RADL
	h265Delta = []byte{0x02, 0x01} // type 1
	h264IDR   = []byte{0x65, 0x88}
	h264Slice = []byte{0x41, 0x88}
)

func accepts(t *testing.T, a *assembler, p testPacket) bool {
	t.Helper()
	_, ready, _ := a.accept(p.packet, p.raw)
	return ready
}

// fragments sends one unit of FU fragments, each a full datagram, until it holds more than
// maxUnitBytes, then its marker. first and rest are the payload's first bytes for the fragment
// with the unit's start and for the ones after it; it says how often a packet was reported as
// making the unit too large, and the sequence number after the unit.
func fragments(t *testing.T, a *assembler, payloadType uint8, sequence uint16, timestamp uint32, first, rest, end []byte) (reported int, next uint16) {
	t.Helper()
	fragment := make([]byte, 1400)
	copy(fragment, first)
	for sent := 0; sent <= maxUnitBytes; sequence++ {
		p := packetOf(t, payloadType, sequence, timestamp, false, fragment)
		_, ready, oversized := a.accept(p.packet, p.raw)
		if ready {
			t.Fatal("ready before the marker")
		}
		if oversized {
			reported++
		}
		if a.size > maxUnitBytes {
			t.Fatalf("the unit holds %d bytes, over the cap of %d", a.size, maxUnitBytes)
		}
		sent += len(p.raw)
		copy(fragment, rest)
	}
	if accepts(t, a, packetOf(t, payloadType, sequence, timestamp, true, end)) {
		t.Fatal("a unit over the cap was passed on")
	}
	return reported, sequence + 1
}

func TestAUnitOverTheCapIsDroppedAndTheNextPasses(t *testing.T) {
	a := newAssembler()
	// FU-A of an IDR: its start (S bit 0x80), the middle, its end (E bit 0x40).
	reported, next := fragments(t, a, payloadTypeH264, 10, 9000, []byte{0x7c, 0x85}, []byte{0x7c, 0x05}, []byte{0x7c, 0x45})
	if reported != 1 {
		t.Fatalf("reported %d times, want once", reported)
	}
	if len(a.packets) != 0 || a.size != 0 {
		t.Fatalf("%d packets, %d bytes kept after the unit", len(a.packets), a.size)
	}
	if !accepts(t, a, h264(t, next, 12000, true, h264IDR)) {
		t.Fatal("the unit after it was withheld")
	}
}

func TestAnH265UnitOverTheCapClosesTheGate(t *testing.T) {
	a := newAssembler()
	if !accepts(t, a, h265(t, 9, 6000, true, h265IRAP)) {
		t.Fatal("the first random-access unit was withheld")
	}
	// FU (type 49) of an IDR_W_RADL (19): its start (0x80|19), the middle, its end (0x40|19).
	reported, next := fragments(t, a, payloadTypeH265, 10, 9000, []byte{0x62, 0x01, 0x93}, []byte{0x62, 0x01, 0x13}, []byte{0x62, 0x01, 0x53})
	if reported != 1 {
		t.Fatalf("reported %d times, want once", reported)
	}
	if accepts(t, a, h265(t, next, 12000, true, h265Delta)) {
		t.Fatal("a delta unit passed the gate after the dropped one")
	}
	if !accepts(t, a, h265(t, next+1, 15000, true, h265IRAP)) {
		t.Fatal("the next random-access unit was withheld")
	}
}

func TestASequenceGapInsideAUnitWithholdsIt(t *testing.T) {
	a := newAssembler()
	if accepts(t, a, h265(t, 10, 9000, false, []byte{0x26, 0x01, 0x80})) {
		t.Fatal("ready before the marker")
	}
	if accepts(t, a, h265(t, 12, 9000, true, []byte{0x26, 0x01, 0x00})) {
		t.Fatal("a unit with a sequence gap was passed on")
	}
}

func TestAFragmentWithoutItsStartIsWithheld(t *testing.T) {
	if accepts(t, newAssembler(), h265(t, 10, 9000, true, []byte{0x62, 0x01, 0x13})) {
		t.Fatal("an H.265 continuation without its start")
	}
	// FU-A: indicator type 28, then the FU header whose 0x80 is the S bit.
	if accepts(t, newAssembler(), h264(t, 10, 9000, true, []byte{0x7c, 0x05, 0x88})) {
		t.Fatal("an H.264 FU-A continuation without its start")
	}
}

func TestAFragmentedH264UnitIsPassedOn(t *testing.T) {
	a := newAssembler()
	if accepts(t, a, h264(t, 10, 9000, false, []byte{0x7c, 0x85, 0x88})) {
		t.Fatal("ready before the marker")
	}
	if !accepts(t, a, h264(t, 11, 9000, true, []byte{0x7c, 0x45, 0x84})) {
		t.Fatal("a whole fragmented unit was withheld")
	}
}

// The surviving packet carries a whole NAL unit, so it begins legitimately; only the sequence gap
// shows the unit lost its first packet.
func TestAUnitThatLostItsFirstPacketIsWithheld(t *testing.T) {
	a := newAssembler()
	if !accepts(t, a, h264(t, 10, 9000, true, h264IDR)) {
		t.Fatal("a whole unit was withheld")
	}
	if accepts(t, a, h264(t, 13, 18000, true, h264Slice)) {
		t.Fatal("a unit after a loss was passed on")
	}
}

func TestTheH265GateWithholdsADamagedRandomAccessUnit(t *testing.T) {
	a := newAssembler()
	if !accepts(t, a, h265(t, 10, 9000, true, h265IRAP)) {
		t.Fatal("the first IRAP was withheld")
	}
	if accepts(t, a, h265(t, 13, 18000, true, h265IRAP)) {
		t.Fatal("an IRAP after a gap was passed on")
	}
	if !accepts(t, a, h265(t, 14, 27000, true, h265IRAP)) {
		t.Fatal("the next whole IRAP did not reopen the gate")
	}
}

func TestTheH265GateWaitsForARandomAccessPicture(t *testing.T) {
	a := newAssembler()
	if accepts(t, a, h265(t, 10, 9000, true, h265Delta)) {
		t.Fatal("a delta picture before any IRAP")
	}
	if !accepts(t, a, h265(t, 11, 18000, true, h265IRAP)) {
		t.Fatal("the IRAP")
	}
	if !accepts(t, a, h265(t, 12, 27000, true, h265Delta)) {
		t.Fatal("a delta picture after the IRAP")
	}
}

func TestLossBetweenUnitsClosesTheH265Gate(t *testing.T) {
	a := newAssembler()
	accepts(t, a, h265(t, 10, 9000, true, h265IRAP))
	if accepts(t, a, h265(t, 12, 18000, true, h265Delta)) {
		t.Fatal("a delta picture after a loss")
	}
}

func TestAnAbandonedUnitClosesTheH265Gate(t *testing.T) {
	a := newAssembler()
	accepts(t, a, h265(t, 10, 9000, false, h265Delta))
	if accepts(t, a, h265(t, 11, 18000, true, h265Delta)) {
		t.Fatal("a delta picture after an abandoned one")
	}
}

func TestAnUnsupportedPayloadTypeLeavesTheStateAlone(t *testing.T) {
	a := newAssembler()
	accepts(t, a, h265(t, 10, 9000, true, h265IRAP))
	if accepts(t, a, packetOf(t, 72, 0, 1, true, []byte{0xc8, 0x00})) {
		t.Fatal("payload type 72 was passed on")
	}
	if !accepts(t, a, h265(t, 11, 18000, true, h265Delta)) {
		t.Fatal("the unsupported packet disturbed the sequence")
	}
}

// A restarted sender comes with an unrelated SSRC and sequence; its first whole unit passes, after
// a finished unit and after one it interrupted.
func TestARestartedSourcesFirstUnitIsPassedOn(t *testing.T) {
	for name, kind := range map[string]struct {
		payloadType uint8
		payload     []byte
	}{"h264": {payloadTypeH264, h264IDR}, "h265": {payloadTypeH265, h265IRAP}} {
		restarted := func(t *testing.T, timestamp uint32) testPacket {
			p := packetOf(t, kind.payloadType, 500, timestamp, true, kind.payload)
			p.packet.SSRC = 4242
			raw, err := p.packet.Marshal()
			if err != nil {
				t.Fatal(err)
			}
			return testPacket{p.packet, raw}
		}
		t.Run(name+" after a finished unit", func(t *testing.T) {
			a := newAssembler()
			accepts(t, a, packetOf(t, kind.payloadType, 10, 9000, true, kind.payload))
			if !accepts(t, a, restarted(t, 18000)) {
				t.Fatal("withheld")
			}
		})
		t.Run(name+" interrupting a unit", func(t *testing.T) {
			a := newAssembler()
			accepts(t, a, packetOf(t, kind.payloadType, 10, 9000, true, kind.payload))
			accepts(t, a, packetOf(t, kind.payloadType, 11, 18000, false, kind.payload))
			if !accepts(t, a, restarted(t, 27000)) {
				t.Fatal("withheld")
			}
		})
	}
}

func TestTimelineAdvancesBySourceSteps(t *testing.T) {
	line := newTimeline()
	start := time.Unix(100, 0)
	// Decode order I P B B P B B at 30 fps: B-frames step back. Starting near the wrap covers it.
	base := uint32(0xffffffff - 4000)
	for i, step := range []uint32{0, 9000, 3000, 6000, 18000, 12000, 15000} {
		got := line.frame(base+step, 0x1234, false, start.Add(time.Duration(i)*33*time.Millisecond))
		if want := firstOutgoingTimestamp + step; got != want {
			t.Fatalf("frame %d: %d, want %d", i, got, want)
		}
	}
}

func TestTimelineFallsBackToArrivalTime(t *testing.T) {
	const ssrc, source = uint32(0x1234), uint32(1_000_000)
	cases := []struct {
		name       string
		source     uint32
		ssrc       uint32
		afterBreak bool
		arrival    time.Duration
		wantStep   uint32
	}{
		{"a step in range", source + 3000, ssrc, false, 40 * time.Millisecond, 3000},
		{"a new SSRC", source + 3000, ssrc + 1, false, 40 * time.Millisecond, 3600},
		{"a repeated timestamp", source, ssrc, false, 40 * time.Millisecond, 3600},
		{"a repeated timestamp at once", source, ssrc, false, 0, 1},
		{"a jump forward", source + uint32(maxSourceStep) + 1, ssrc, false, 40 * time.Millisecond, 3600},
		{"a jump back", source - uint32(maxSourceStep) - 1, ssrc, false, 40 * time.Millisecond, 3600},
		{"after a sequence break", source + 3000, ssrc, true, 40 * time.Millisecond, 3600},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			line := newTimeline()
			start := time.Unix(100, 0)
			first := line.frame(source, ssrc, false, start)
			if got := line.frame(c.source, c.ssrc, c.afterBreak, start.Add(c.arrival)) - first; got != c.wantStep {
				t.Fatalf("step %d, want %d", got, c.wantStep)
			}
		})
	}
}

// After a fallback the clock is re-anchored, and later backward steps stay above what was sent.
func TestTimelineHoldsAboveWhatWasSentAfterADiscontinuity(t *testing.T) {
	const ssrc = 0x1234
	type frame struct {
		source     uint32
		ssrc       uint32
		afterBreak bool
	}
	cases := map[string]struct{ before, after []frame }{
		"a break after an anchor":  {[]frame{{9000, ssrc, false}, {18000, ssrc, false}}, []frame{{27000, ssrc, true}, {21000, ssrc, false}, {24000, ssrc, false}}},
		"a break after a B-frame":  {[]frame{{9000, ssrc, false}, {18000, ssrc, false}, {12000, ssrc, false}}, []frame{{27000, ssrc, true}, {21000, ssrc, false}, {24000, ssrc, false}}},
		"a new SSRC with B-frames": {[]frame{{9000, ssrc, false}, {18000, ssrc, false}}, []frame{{500000, ssrc + 1, false}, {494000, ssrc + 1, false}, {497000, ssrc + 1, false}}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			line := newTimeline()
			now := time.Unix(100, 0) // one arrival for all: a burst
			var highest uint32
			for i, f := range c.before {
				if got := line.frame(f.source, f.ssrc, f.afterBreak, now); i == 0 || int32(got-highest) > 0 {
					highest = got
				}
			}
			for _, f := range c.after {
				if got := line.frame(f.source, f.ssrc, f.afterBreak, now); int32(got-highest) <= 0 {
					t.Fatalf("source %d went out as %d, not after %d", f.source, got, highest)
				}
			}
		})
	}
}

func TestSequencerStampsInPlaceAndKeepsTheSequenceContinuous(t *testing.T) {
	var s sequencer
	first := h265(t, 7, 1234, true, h265IRAP)
	afterGap := h265(t, 4000, 5678, true, h265Delta)
	if err := s.stamp(first.raw, 9000); err != nil {
		t.Fatal(err)
	}
	if err := s.stamp(afterGap.raw, 18000); err != nil {
		t.Fatal(err)
	}
	var a, b rtp.Packet
	if err := a.Unmarshal(first.raw); err != nil {
		t.Fatal(err)
	}
	if err := b.Unmarshal(afterGap.raw); err != nil {
		t.Fatal(err)
	}
	if a.SequenceNumber != 7 || b.SequenceNumber != 8 || a.Timestamp != 9000 || b.Timestamp != 18000 {
		t.Fatalf("got %d@%d and %d@%d", a.SequenceNumber, a.Timestamp, b.SequenceNumber, b.Timestamp)
	}
	if a.SSRC != 99 || !a.Marker || a.PayloadType != payloadTypeH265 || string(a.Payload) != string(h265IRAP) {
		t.Fatalf("the rest of the packet changed: %+v", a)
	}
	if err := s.stamp([]byte{1, 2, 3}, 1); err == nil {
		t.Fatal("a short packet was stamped")
	}
}

func TestNALs(t *testing.T) {
	cases := []struct {
		name    string
		codec   Codec
		payload []byte
		want    []nal
	}{
		{"h264 single", CodecH264, []byte{0x65, 0x88}, []nal{{5, true}}},
		{"h264 STAP-A", CodecH264, []byte{0x18, 0x00, 0x02, 0x67, 0x42, 0x00, 0x02, 0x68, 0xce}, []nal{{7, true}, {8, true}}},
		{"h264 FU-A start", CodecH264, []byte{0x7c, 0x85}, []nal{{5, true}}},
		{"h264 FU-A middle", CodecH264, []byte{0x7c, 0x05}, []nal{{5, false}}},
		{"h265 single", CodecH265, []byte{0x26, 0x01}, []nal{{19, true}}},
		{"h265 AP", CodecH265, []byte{0x60, 0x01, 0x00, 0x02, 0x40, 0x01, 0x00, 0x02, 0x42, 0x01}, []nal{{32, true}, {33, true}}},
		{"h265 FU start", CodecH265, []byte{0x62, 0x01, 0x93}, []nal{{19, true}}},
		{"empty", CodecH264, nil, nil},
	}
	for _, c := range cases {
		got := nalsOf(c.codec, c.payload)
		if len(got) != len(c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: %v, want %v", c.name, got, c.want)
			}
		}
	}
}
