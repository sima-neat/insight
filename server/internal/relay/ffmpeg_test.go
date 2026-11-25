package relay

import (
	"bytes"
	"image/jpeg"
	"os/exec"
	"testing"
	"time"
)

// TestFFmpegFeedsReaders runs a real ffmpeg, as the slot and file previews will, writing
// mpjpeg from a test pattern.
func TestFFmpegFeedsReaders(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("no ffmpeg")
	}
	start := func(string, string) (*exec.Cmd, error) {
		return exec.Command(ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-re",
			"-f", "lavfi", "-i", "testsrc=size=160x120:rate=25", "-an", "-c:v", "mjpeg", "-q:v", "7",
			"-f", "mpjpeg", "-boundary_tag", "frame", "pipe:1"), nil
	}
	relays, _ := newRelays(t, Options{MaxRelays: 4, IdleStop: time.Second, StallTimeout: 10 * time.Second, Start: start}, "")
	srv := serve(t, relays)

	a, b := open(t, srv, "pattern"), open(t, srv, "pattern")
	for _, r := range []*reader{a, b, a, b, a, b} {
		picture, err := r.next()
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := jpeg.Decode(bytes.NewReader(picture))
		if err != nil {
			t.Fatal(err)
		}
		if size := decoded.Bounds().Size(); size.X != 160 || size.Y != 120 {
			t.Fatalf("a picture of %v", size)
		}
	}
	pid := producerPID(t, relays, "pattern")
	relays.Close()
	if alive(pid) || liveStreams(relays) != 0 {
		t.Errorf("ffmpeg still runs after Close")
	}
}
