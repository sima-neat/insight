package channels

import (
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestAFrameOverTheCapIsCountedAndReported(t *testing.T) {
	c := newChannel(0)
	from := netip.MustParseAddrPort("192.0.2.7:5004")
	now := time.Now()
	fragment := make([]byte, 1400)
	fragment[0], fragment[1] = 0x7c, 0x85 // FU-A, the start of an IDR
	sequence := uint16(1)
	for sent := 0; sent <= maxUnitBytes; sequence++ {
		p := h264(t, sequence, 9000, false, fragment)
		c.video(p.raw, from, now)
		sent += len(p.raw)
		fragment[1] = 0x05
	}
	end := h264(t, sequence, 9000, true, []byte{0x7c, 0x45})
	c.video(end.raw, from, now)

	state := c.state(now)
	if state.Video.Oversized != 1 {
		t.Fatalf("oversized frames: %d, want 1", state.Video.Oversized)
	}
	if len(state.Errors) != 1 || !strings.Contains(state.Errors[0], "over 16 MiB") {
		t.Fatalf("errors: %q", state.Errors)
	}
	if c.assembler.size != 0 {
		t.Fatalf("%d bytes kept after the frame", c.assembler.size)
	}
}
