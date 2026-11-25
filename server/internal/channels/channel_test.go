package channels

import (
	"bytes"
	"encoding/binary"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
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

// jpegFrameAt is packets, one JPEG frame, restamped to RTP time timestamp and sequence numbers
// from sequence on.
func jpegFrameAt(t *testing.T, packets [][]byte, sequence uint16, timestamp uint32) [][]byte {
	t.Helper()
	frame := make([][]byte, len(packets))
	for i, raw := range packets {
		var packet rtp.Packet
		if err := packet.Unmarshal(raw); err != nil {
			t.Fatal(err)
		}
		packet.SequenceNumber, packet.Timestamp = sequence+uint16(i), timestamp
		restamped, err := packet.Marshal()
		if err != nil {
			t.Fatal(err)
		}
		frame[i] = restamped
	}
	return frame
}

// sendJPEGFrames hands c count frames of packets, one after another, 3600 ticks apart from RTP
// time 9000.
func sendJPEGFrames(t *testing.T, c *Channel, packets [][]byte, count int) {
	t.Helper()
	from := netip.MustParseAddrPort("192.0.2.7:5004")
	for i := range count {
		for _, raw := range jpegFrameAt(t, packets, uint16(i*len(packets)), uint32(9000+i*3600)) {
			c.video(raw, from, time.Now())
		}
	}
}

// jpegChannelWatchedBy is a channel whose JPEG generation has these viewers' jpeg channels open.
func jpegChannelWatchedBy(t *testing.T, viewers ...*fakeViewer) *Channel {
	t.Helper()
	c := newChannel(0)
	m, err := c.publish(CodecJPEG)
	if err != nil {
		t.Fatal(err)
	}
	for _, viewer := range viewers {
		m.frameViewers.add(viewer)
	}
	return c
}

func TestNoRebuildRunsWithoutAJPEGViewer(t *testing.T) {
	c := newChannel(0)
	sendJPEGFrames(t, c, withJPEGQ(t, fixtureI420, 0), 10)

	state := c.state(time.Now())
	if state.Video.Unusable != 0 || len(state.Errors) != 0 {
		t.Fatalf("unusable frames %d, errors %q, with nobody watching", state.Video.Unusable, state.Errors)
	}
}

func TestAnUnusableFrameIsCountedAndItsReasonNamedOnce(t *testing.T) {
	viewer := &fakeViewer{}
	c := jpegChannelWatchedBy(t, viewer)
	sendJPEGFrames(t, c, withJPEGQ(t, fixtureI420, 0), 10)

	state := c.state(time.Now())
	if state.Video.Unusable != 10 {
		t.Fatalf("unusable frames: %d, want 10", state.Video.Unusable)
	}
	if len(state.Errors) != 1 || !strings.Contains(state.Errors[0], "quantization") {
		t.Fatalf("errors: %q, want one naming the quantization", state.Errors)
	}
	if len(viewer.sent) != 0 {
		t.Fatalf("the viewer got %d messages of unusable frames", len(viewer.sent))
	}
}

func TestASkippedFrameIsCountedPerViewer(t *testing.T) {
	first, second := &fakeViewer{buffered: 600 << 10}, &fakeViewer{buffered: 600 << 10}
	c := jpegChannelWatchedBy(t, first, second)
	sendJPEGFrames(t, c, fixtureI420, 1)

	state := c.state(time.Now())
	if state.Video.Skipped != 2 || state.Video.Unusable != 0 {
		t.Fatalf("skipped %d, unusable %d, want 2 and 0", state.Video.Skipped, state.Video.Unusable)
	}
	if len(first.sent)+len(second.sent) != 0 {
		t.Fatal("a full viewer got part of the frame")
	}
	c.corr.mu.Lock()
	defer c.corr.mu.Unlock()
	if len(c.corr.frames) != 0 {
		t.Fatal("a frame no viewer took released its metadata")
	}
}

func TestAJPEGFrameReachesItsViewerAndReleasesItsMetadata(t *testing.T) {
	viewer := &fakeViewer{}
	c := jpegChannelWatchedBy(t, viewer)
	sendJPEGFrames(t, c, fixtureI420, 1)

	image, err := jpegImage(jpegFrameAt(t, fixtureI420, 0, 9000))
	if err != nil {
		t.Fatal(err)
	}
	if len(viewer.sent) != 1 || !bytes.Equal(viewer.sent[0][jpegChunkHeaderBytes:], image) {
		t.Fatalf("the viewer got %d messages, want the frame in one", len(viewer.sent))
	}
	c.corr.mu.Lock()
	defer c.corr.mu.Unlock()
	if len(c.corr.frames) != 1 || c.corr.frames[0].source != 9000 ||
		c.corr.frames[0].outgoing != binary.BigEndian.Uint32(viewer.sent[0]) {
		t.Fatalf("the frames kept for metadata, %+v, do not name the frame sent", c.corr.frames)
	}
}

func TestAViewerWhoseSendFailsLeavesTheSet(t *testing.T) {
	failing, other := &fakeViewer{failAt: 1}, &fakeViewer{}
	c := jpegChannelWatchedBy(t, failing, other)
	sendJPEGFrames(t, c, fixtureI420, 2)

	if failing.closed != 1 || len(failing.sent) != 0 {
		t.Fatalf("the failing viewer: closed %d times, %d messages", failing.closed, len(failing.sent))
	}
	if len(other.sent) != 2 {
		t.Fatalf("the other viewer got %d messages, want both frames", len(other.sent))
	}
	if left := c.media.Load().frameViewers.list(); len(left) != 1 || left[0] != frameChannel(other) {
		t.Fatalf("jpeg channels left: %v, want only the other viewer's", left)
	}
	if errors := c.state(time.Now()).Errors; len(errors) != 1 || !strings.Contains(errors[0], "sending a JPEG frame") {
		t.Fatalf("errors: %q, want the failed send once", errors)
	}
}
