package media

import (
	"slices"
	"testing"
)

func TestFileInputOpensOnlyFiles(t *testing.T) {
	want := []string{"-protocol_whitelist", "file", "-i", "file:/m/a b.m3u8"}
	if got := FileInput("/m/a b.m3u8"); !slices.Equal(got, want) {
		t.Fatalf("FileInput = %q, want %q", got, want)
	}
}

func TestRTSPInputOpensOnlyRTSPOverTCP(t *testing.T) {
	want := []string{"-protocol_whitelist", "tcp,tls", "-rtsp_transport", "tcp", "-i", "rtsp://127.0.0.1:8554/src1"}
	if got := RTSPInput("rtsp://127.0.0.1:8554/src1"); !slices.Equal(got, want) {
		t.Fatalf("RTSPInput = %q, want %q", got, want)
	}
}

func TestProbeFileArgsReadTheFileOnly(t *testing.T) {
	args := probeFileArgs("/m/clip.mp4")
	i := slices.Index(args, "-protocol_whitelist")
	if i < 0 || args[i+1] != "file" || !slices.Contains(args, "file:/m/clip.mp4") {
		t.Fatalf("probe arguments %q", args)
	}
}
