package media

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestParseProbe(t *testing.T) {
	tests := []struct {
		name string
		json string
		want Info
	}{
		{
			name: "an H.264 video with B-frames",
			json: `{"streams":[{"codec_name":"h264","profile":"High","pix_fmt":"yuv420p","has_b_frames":2,
				"width":1280,"height":720,"avg_frame_rate":"30000/1001","r_frame_rate":"30/1","duration":"12.5"}],
				"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"12.6"}}`,
			want: Info{Kind: KindVideo, Codec: CodecH264, CodecName: "H.264", Profile: "High",
				PixelFormat: "yuv420p", Width: 1280, Height: 720, FPS: 30000.0 / 1001,
				FrameRate: "30000/1001", Duration: 12500 * time.Millisecond, HasBFrames: true},
		},
		{
			name: "an H.265 video takes the container's duration and the base rate",
			json: `{"streams":[{"codec_name":"hevc","profile":"Main","width":64,"height":48,
				"avg_frame_rate":"0/0","r_frame_rate":"25/1","duration":"N/A"}],
				"format":{"format_name":"matroska,webm","duration":"2.000000"}}`,
			want: Info{Kind: KindVideo, Codec: CodecH265, CodecName: "H.265", Profile: "Main",
				Width: 64, Height: 48, FPS: 25, FrameRate: "25/1", Duration: 2 * time.Second},
		},
		{
			name: "a Motion JPEG file is a video",
			json: `{"streams":[{"codec_name":"mjpeg","profile":"Baseline","pix_fmt":"yuvj422p","width":640,
				"height":480,"avg_frame_rate":"15/1","r_frame_rate":"15/1"}],"format":{"format_name":"mjpeg"}}`,
			want: Info{Kind: KindVideo, Codec: CodecMJPEG, CodecName: "MJPEG", Profile: "Baseline",
				PixelFormat: "yuvj422p", Width: 640, Height: 480, FPS: 15, FrameRate: "15/1"},
		},
		{
			name: "a JPEG picture has no rate",
			json: `{"streams":[{"codec_name":"mjpeg","profile":"Baseline","pix_fmt":"yuvj444p","width":64,
				"height":48,"avg_frame_rate":"25/1","r_frame_rate":"25/1"}],"format":{"format_name":"jpeg_pipe"}}`,
			want: Info{Kind: KindImage, Codec: CodecMJPEG, CodecName: "MJPEG", Profile: "Baseline",
				PixelFormat: "yuvj444p", Width: 64, Height: 48},
		},
		{
			name: "a PNG picture",
			json: `{"streams":[{"codec_name":"png","pix_fmt":"rgb24","width":64,"height":48,
				"avg_frame_rate":"25/1","r_frame_rate":"25/1"}],"format":{"format_name":"png_pipe"}}`,
			want: Info{Kind: KindImage, Codec: "png", CodecName: "png", PixelFormat: "rgb24",
				Width: 64, Height: 48},
		},
		{
			name: "another codec keeps ffprobe's name",
			json: `{"streams":[{"codec_name":"vp9","width":64,"height":48,"avg_frame_rate":"25/1"}],
				"format":{"format_name":"matroska,webm","duration":"1.0"}}`,
			want: Info{Kind: KindVideo, Codec: "vp9", CodecName: "vp9", Width: 64, Height: 48,
				FPS: 25, FrameRate: "25/1", Duration: time.Second},
		},
		{
			name: "rates and durations that are not numbers count as unknown",
			json: `{"streams":[{"codec_name":"h264","avg_frame_rate":"nan","r_frame_rate":"inf/1",
				"duration":"-1"}],"format":{"format_name":"mpegts","duration":"1e300"}}`,
			want: Info{Kind: KindVideo, Codec: CodecH264, CodecName: "H.264"},
		},
		{
			name: "a file without a video stream",
			json: `{"programs":[],"streams":[],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"1.0"}}`,
			want: Info{Kind: KindUnknown},
		},
		{
			name: "ffprobe's answer for a file it cannot read",
			json: `{}`,
			want: Info{Kind: KindUnknown},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseProbe([]byte(test.json))
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("parseProbe =\n%+v\nwant\n%+v", got, test.want)
			}
		})
	}
	if _, err := parseProbe([]byte("not json")); err == nil {
		t.Fatal("text that is no JSON gave no error")
	}
}

func TestStreamable(t *testing.T) {
	tests := []struct {
		info Info
		want bool
	}{
		{Info{Kind: KindVideo, Codec: CodecH264}, true},
		{Info{Kind: KindVideo, Codec: CodecH265}, true},
		{Info{Kind: KindVideo, Codec: CodecMJPEG}, true},
		{Info{Kind: KindImage, Codec: CodecMJPEG}, true},
		{Info{Kind: KindImage, Codec: "png"}, false},
		{Info{Kind: KindVideo, Codec: "vp9"}, false},
		{Info{Kind: KindUnknown, Codec: CodecH264}, false},
	}
	for _, test := range tests {
		if got := test.info.Streamable(); got != test.want {
			t.Errorf("%+v.Streamable() = %v, want %v", test.info, got, test.want)
		}
	}
}

func TestProbeFileRefuses(t *testing.T) {
	dir := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(dir, "pipe.mp4"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for name, call := range map[string]func() error{
		"without ffprobe": func() error { _, err := ProbeFile(ctx, "", filepath.Join(dir, "a.mp4")); return err },
		"a relative path": func() error { _, err := ProbeFile(ctx, "/bin/true", "a.mp4"); return err },
		"a missing file":  func() error { _, err := ProbeFile(ctx, "/bin/true", filepath.Join(dir, "a.mp4")); return err },
		"a folder":        func() error { _, err := ProbeFile(ctx, "/bin/true", dir); return err },
		"a pipe (it would block)": func() error {
			_, err := ProbeFile(ctx, "/bin/true", filepath.Join(dir, "pipe.mp4"))
			return err
		},
	} {
		if call() == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

// tools finds ffprobe and ffmpeg, or skips the test.
func tools(t *testing.T) (ffprobe, ffmpeg string) {
	t.Helper()
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is not on PATH")
	}
	ffmpeg, err = exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not on PATH")
	}
	return ffprobe, ffmpeg
}

// encode makes a clip from ffmpeg's test pattern in dir, or skips when this ffmpeg cannot
// (a build without libx264, say).
func encode(t *testing.T, ffmpeg, dir, name string, args ...string) string {
	t.Helper()
	out := filepath.Join(dir, name)
	full := append([]string{"-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=25"}, args...)
	full = append(full, out)
	if msg, err := exec.Command(ffmpeg, full...).CombinedOutput(); err != nil {
		t.Skipf("this ffmpeg cannot make %s: %v %s", name, err, msg)
	}
	return out
}

func TestProbeFileWithFFprobe(t *testing.T) {
	ffprobe, ffmpeg := tools(t)
	dir := t.TempDir()
	tests := []struct {
		name string
		args []string
		want Info // Size is checked against the file
	}{
		{"h264.mp4", []string{"-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bf", "2"},
			Info{Kind: KindVideo, Codec: CodecH264, CodecName: "H.264", HasBFrames: true}},
		{"h265.mp4", []string{"-t", "1", "-c:v", "libx265", "-x265-params", "log-level=error"},
			Info{Kind: KindVideo, Codec: CodecH265, CodecName: "H.265"}},
		{"motion.mjpeg", []string{"-t", "1", "-c:v", "mjpeg", "-f", "mjpeg"},
			Info{Kind: KindVideo, Codec: CodecMJPEG, CodecName: "MJPEG"}},
		{"mpeg4.avi", []string{"-t", "1", "-c:v", "mpeg4"},
			Info{Kind: KindVideo, Codec: "mpeg4", CodecName: "mpeg4"}},
		{"picture.jpg", []string{"-frames:v", "1"},
			Info{Kind: KindImage, Codec: CodecMJPEG, CodecName: "MJPEG"}},
		{"picture.png", []string{"-frames:v", "1"},
			Info{Kind: KindImage, Codec: "png", CodecName: "png"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := encode(t, ffmpeg, dir, test.name, test.args...)
			got, err := ProbeFile(context.Background(), ffprobe, path)
			if err != nil {
				t.Fatal(err)
			}
			if got.Kind != test.want.Kind || got.Codec != test.want.Codec || got.CodecName != test.want.CodecName {
				t.Fatalf("kind and codec = %s %s %q, want %s %s %q", got.Kind, got.Codec, got.CodecName,
					test.want.Kind, test.want.Codec, test.want.CodecName)
			}
			if got.Width != 64 || got.Height != 48 {
				t.Errorf("size = %dx%d, want 64x48", got.Width, got.Height)
			}
			stat, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if got.Size != stat.Size() {
				t.Errorf("Size = %d, want %d", got.Size, stat.Size())
			}
			if test.want.HasBFrames && !got.HasBFrames {
				t.Errorf("the B-frames were not seen")
			}
			if got.Kind == KindImage {
				if got.FPS != 0 || got.Duration != 0 {
					t.Errorf("a picture has FPS %v and duration %v", got.FPS, got.Duration)
				}
				return
			}
			if got.FPS != 25 || got.FrameRate != "25/1" {
				t.Errorf("rate = %v (%q), want 25 (25/1)", got.FPS, got.FrameRate)
			}
			// A raw Motion JPEG file has no container that knows its length.
			if test.name != "motion.mjpeg" && (got.Duration < 900*time.Millisecond || got.Duration > 1100*time.Millisecond) {
				t.Errorf("duration = %v, want about 1 s", got.Duration)
			}
		})
	}
}

func TestProbeFileOfAnAudioFile(t *testing.T) {
	ffprobe, ffmpeg := tools(t)
	path := filepath.Join(t.TempDir(), "tone.m4a")
	if msg, err := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "sine", "-t", "1", path).CombinedOutput(); err != nil {
		t.Skipf("this ffmpeg cannot make an audio file: %v %s", err, msg)
	}
	got, err := ProbeFile(context.Background(), ffprobe, path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != KindUnknown || got.Streamable() {
		t.Fatalf("an audio file probed as %+v", got)
	}
}

func TestProbeFileOfAFileThatIsNoMedia(t *testing.T) {
	ffprobe, _ := tools(t)
	path := writeFile(t, t.TempDir(), "notes.mp4", "not a video\n")
	_, err := ProbeFile(context.Background(), ffprobe, path)
	if err == nil || !strings.Contains(err.Error(), "notes.mp4") {
		t.Fatalf("error = %v, want one naming the file", err)
	}
}

func TestProbeFileStopsWithItsContext(t *testing.T) {
	ffprobe, ffmpeg := tools(t)
	path := encode(t, ffmpeg, t.TempDir(), "clip.avi", "-t", "1", "-c:v", "mpeg4")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ProbeFile(ctx, ffprobe, path); err == nil {
		t.Fatal("a cancelled probe gave no error")
	}
}
