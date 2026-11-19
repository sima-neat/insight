package media

import (
	"strings"
	"testing"
)

// The catalog's renditions (media-assets/build_media_assets.py) and the bitrate it gives each.
func TestVideoBitrateIsTheCatalogs(t *testing.T) {
	for _, test := range []struct {
		width, height int
		fps           float64
		want          int64
	}{
		{3840, 2160, 30, 35_000_000}, {1920, 1080, 120, 18_000_000}, {1920, 1080, 30, 12_000_000},
		{1280, 720, 60, 8_000_000}, {1280, 720, 30, 5_000_000}, {1280, 720, 20, 2_000_000},
		{1280, 720, 10, 2_000_000}, {854, 480, 30, 3_000_000}, {568, 320, 30, 1_000_000},
		// Beyond the catalog: a portrait video as its landscape twin, a rate unknown.
		{1080, 1920, 30, 12_000_000}, {720, 1280, 30, 5_000_000}, {1280, 720, 0, 5_000_000}, {0, 0, 0, 1_000_000},
	} {
		if got := VideoBitrate(test.width, test.height, test.fps); got != test.want {
			t.Errorf("VideoBitrate(%d, %d, %v) = %d, want %d", test.width, test.height, test.fps, got, test.want)
		}
	}
}

func TestTheKeyframeIntervalIsOneSecond(t *testing.T) {
	for fps, want := range map[float64]int{0: 30, 29.97: 30, 25: 25, 0.2: 1, 1000: 240} {
		if got := (Encode{FPS: fps}).gop(); got != want {
			t.Errorf("FPS %v: a keyframe every %d frames, want %d", fps, got, want)
		}
	}
}

func TestEncodeArgs(t *testing.T) {
	rendition := strings.Join(Encode{Codec: CodecH264, Width: 1280, Height: 720, FPS: 15, Resample: true}.
		Args("/m/a.mp4", "/m/.renditions/.x.tmp", "mp4"), " ")
	for _, want := range []string{"-i file:/m/a.mp4 -map 0:v:0 -an", "-vf setpts=PTS-STARTPTS,fps=15 -fps_mode cfr",
		"-c:v libx264 -preset medium -profile:v baseline -refs 1 -sc_threshold 0",
		"-pix_fmt yuv420p -g 15 -keyint_min 15 -bf 0 -flags +cgop -b:v 2000000 -maxrate 2000000 -bufsize 2000000",
		"repeat-headers=1:force-cfr=1:open-gop=0", "-tag:v avc1",
		"h264_metadata=aud=remove,dump_extra=freq=keyframe,h264_metadata=aud=insert:tick_rate=30/1",
		"-movflags +faststart", "-progress pipe:1 -nostats -f mp4 file:/m/.renditions/.x.tmp"} {
		if !strings.Contains(rendition, want) {
			t.Errorf("the rendition's arguments lack %q: %s", want, rendition)
		}
	}
	if strings.Contains(rendition, "-level") {
		t.Errorf("a level is set; the encoder picks it: %s", rendition)
	}
	upload := strings.Join(Encode{Codec: CodecH265, Width: 1920, Height: 1080, FPS: 29.97}.
		Args("/in.mkv", "/out.mkv", "matroska"), " ")
	for _, want := range []string{"-vf setpts=PTS-STARTPTS -c:v libx265 -preset medium -profile:v main",
		"keyint=30:min-keyint=30:scenecut=0:bframes=0:ref=1", "-b:v 12000000", "-tag:v hvc1",
		"hevc_metadata=aud=remove,hevc_metadata=aud=insert -avoid", "-f matroska file:/out.mkv"} {
		if !strings.Contains(upload, want) {
			t.Errorf("the upload's arguments lack %q: %s", want, upload)
		}
	}
	if strings.Contains(upload, "faststart") || strings.Contains(upload, "fps_mode") || strings.Contains(upload, "tick_rate") {
		t.Errorf("an upload keeps its own rate and an MKV has no faststart: %s", upload)
	}
}
