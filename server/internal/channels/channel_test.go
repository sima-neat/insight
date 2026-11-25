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
	if state.Video.Incomplete != 0 {
		t.Fatalf("incomplete frames: %d, want 0: an oversized one keeps its own count", state.Video.Incomplete)
	}
	if c.assembler.size != 0 {
		t.Fatalf("%d bytes kept after the frame", c.assembler.size)
	}
}

func TestLostFramesAreCountedForEveryCodec(t *testing.T) {
	c := newChannel(0)
	from := netip.MustParseAddrPort("192.0.2.7:5004")
	now := time.Now()
	c.video(h264(t, 1, 9000, true, []byte{0x7c, 0x45, 0x88}).raw, from, now) // an FU-A end without its start
	c.video(jpegPacket(t, 2, 12000, true, 1000).raw, from, now)              // a JPEG unit without fragment 0

	if got := c.state(now).Video.Incomplete; got != 2 {
		t.Fatalf("incomplete frames: %d, want 2", got)
	}
}

func TestJPEGPacketsAreNoLongerUnsupported(t *testing.T) {
	c := newChannel(0)
	now := time.Now()
	c.video(jpegPacket(t, 1, 9000, true, 0).raw, netip.MustParseAddrPort("192.0.2.7:5004"), now)

	video := c.state(now).Video
	if video.Unsupported != 0 || video.Codec != "JPEG" || video.PayloadType != 26 {
		t.Fatalf("unsupported %d, codec %q, payload type %d", video.Unsupported, video.Codec, video.PayloadType)
	}
}

func TestAJPEGGenerationIsWatchedWhileAJPEGChannelIsOpen(t *testing.T) {
	m, err := newMedia(CodecJPEG)
	if err != nil {
		t.Fatal(err)
	}
	if m.track != nil {
		t.Fatal("a JPEG generation has a track")
	}
	if m.watched() {
		t.Fatal("watched with no jpeg channel")
	}
	viewer := &fakeViewer{}
	m.frameViewers.add(viewer)
	if !m.watched() {
		t.Fatal("not watched with a jpeg channel open")
	}
	m.frameViewers.remove(viewer)
	if m.watched() {
		t.Fatal("watched once the jpeg channel left")
	}
}
