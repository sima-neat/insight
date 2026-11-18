package library

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"insight/internal/jobs"
	"insight/internal/media"
)

func TestEncodeReasons(t *testing.T) {
	with := func(change func(*media.Info)) media.Info {
		info := h264()
		change(&info)
		return info
	}
	for name, test := range map[string]struct {
		info media.Info
		want []string
	}{
		"H.264 High":        {h264(), nil},
		"Constrained":       {with(func(i *media.Info) { i.Profile = "Constrained Baseline" }), nil},
		"JPEG range":        {with(func(i *media.Info) { i.PixelFormat = "yuvj420p" }), nil},
		"no profile named":  {with(func(i *media.Info) { i.Profile = "" }), nil},
		"H.265 Main":        {with(func(i *media.Info) { i.Codec, i.Profile = media.CodecH265, "Main" }), nil},
		"MJPEG":             {with(func(i *media.Info) { i.Codec, i.PixelFormat, i.HasBFrames = media.CodecMJPEG, "yuvj422p", true }), nil},
		"B-frames":          {bframes(), []string{"B-frames"}},
		"High 10":           {with(func(i *media.Info) { i.Profile, i.PixelFormat = "High 10", "yuv420p10le" }), []string{"profile High 10", "pixel format yuv420p10le"}},
		"High 4:2:2":        {with(func(i *media.Info) { i.Profile, i.PixelFormat = "High 4:2:2", "yuv422p" }), []string{"profile High 4:2:2", "pixel format yuv422p"}},
		"H.265 Main 10":     {with(func(i *media.Info) { i.Codec, i.Profile, i.PixelFormat = media.CodecH265, "Main 10", "yuv420p10le" }), []string{"profile Main 10", "pixel format yuv420p10le"}},
		"VP9":               {media.Info{Kind: media.KindVideo, Codec: "vp9", CodecName: "vp9"}, []string{"codec vp9"}},
		"AV1 with B-frames": {media.Info{Kind: media.KindVideo, Codec: "av1", CodecName: "av1", HasBFrames: true}, []string{"codec av1"}},
	} {
		if got := encodeReasons(test.info); !slices.Equal(got, test.want) {
			t.Errorf("%s: %q, want %q", name, got, test.want)
		}
	}
}

func TestPlanEncode(t *testing.T) {
	f := newFixture(t, nil)
	dir := t.TempDir()
	f.probes.set("good.mp4", h264())
	f.probes.set("sparse.mp4", h264())
	f.probes.gaps["sparse.mp4"] = 10 * time.Second
	f.probes.gaps["good.mp4"] = 2 * time.Second
	f.probes.set("hevc.mkv", media.Info{Kind: media.KindVideo, Codec: media.CodecH265, Profile: "Main 10",
		PixelFormat: "yuv420p10le", Width: 3840, Height: 2160, FPS: 60, Duration: time.Minute})
	f.probes.set("photo.jpg", media.Info{Kind: media.KindImage, Codec: media.CodecMJPEG})
	f.probes.set("broken.mp4", media.Info{Problem: "Invalid data found"})

	for name, want := range map[string]bool{"good.mp4": false, "photo.jpg": false, "broken.mp4": false,
		"notes.txt": false, "sparse.mp4": true, "hevc.mkv": true} {
		plan, encode := f.lib.planEncode(t.Context(), filepath.Join(dir, name))
		if encode != want {
			t.Errorf("%s: re-encode %v, want %v (%+v)", name, encode, want, plan)
		}
	}
	plan, _ := f.lib.planEncode(t.Context(), filepath.Join(dir, "sparse.mp4"))
	if !slices.Equal(plan.reasons, []string{"keyframes 10 s apart"}) || plan.codec != media.CodecH264 ||
		plan.gop != 30 || plan.bitrate != "12M" {
		t.Fatalf("sparse.mp4: %+v", plan)
	}
	plan, _ = f.lib.planEncode(t.Context(), filepath.Join(dir, "hevc.mkv"))
	if plan.codec != media.CodecH265 || plan.gop != 60 || plan.bitrate != "35M" || plan.duration != time.Minute {
		t.Fatalf("hevc.mkv: %+v", plan)
	}
}

func TestBitrateGOPAndName(t *testing.T) {
	for _, test := range []struct {
		w, h int
		fps  float64
		want string
	}{
		{3840, 2160, 30, "35M"}, {1920, 1080, 120, "18M"}, {1920, 1080, 30, "12M"},
		{1080, 1920, 30, "12M"}, {1280, 720, 60, "8M"}, {1280, 720, 15, "2M"}, {1280, 720, 30, "5M"},
		{1280, 720, 0, "5M"}, {854, 480, 30, "3M"}, {568, 320, 30, "1M"}, {0, 0, 0, "1M"},
	} {
		if got := bitrateFor(test.w, test.h, test.fps); got != test.want {
			t.Errorf("bitrateFor(%d, %d, %v) = %s, want %s", test.w, test.h, test.fps, got, test.want)
		}
	}
	for fps, want := range map[float64]int{0: 30, 29.97: 30, 25: 25, 0.2: 1, 1000: 240} {
		if got := gopFor(fps); got != want {
			t.Errorf("gopFor(%v) = %d, want %d", fps, got, want)
		}
	}
	for name, want := range map[string]string{"a.mp4": "a.mp4", "a.MOV": "a.MOV", "a.mkv": "a.mkv",
		"a.webm": "a.mp4", "a.avi": "a.mp4", "a": "a.mp4", "a.b.flv": "a.b.mp4"} {
		if got := encodedName(name); got != want {
			t.Errorf("encodedName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestEncodeArgs(t *testing.T) {
	h264Args := strings.Join(encodeArgs("/in.mov", "/out.mp4", encodePlan{codec: media.CodecH264, gop: 25, bitrate: "5M"}), " ")
	for _, want := range []string{"-i /in.mov -map 0:v:0 -an", "-c:v libx264", "-profile:v baseline",
		"-g 25 -keyint_min 25 -sc_threshold 0 -bf 0", "-b:v 5M -maxrate 5M -bufsize 5M",
		"-movflags +faststart", "-progress pipe:1 -nostats /out.mp4"} {
		if !strings.Contains(h264Args, want) {
			t.Errorf("the H.264 arguments lack %q: %s", want, h264Args)
		}
	}
	h265Args := strings.Join(encodeArgs("/in.mkv", "/out.mkv", encodePlan{codec: media.CodecH265, gop: 30, bitrate: "12M"}), " ")
	for _, want := range []string{"-c:v libx265", "-profile:v main", "keyint=30:min-keyint=30:scenecut=0:bframes=0"} {
		if !strings.Contains(h265Args, want) {
			t.Errorf("the H.265 arguments lack %q: %s", want, h265Args)
		}
	}
	if strings.Contains(h265Args, "faststart") {
		t.Errorf("an MKV is given MP4's faststart: %s", h265Args)
	}
}

func TestLongestKeyframeGap(t *testing.T) {
	for name, test := range map[string]struct {
		json string
		want time.Duration
	}{
		"every second":     {`{"packets":[{"pts_time":"0.0","flags":"K__"},{"pts_time":"0.5","flags":"___"},{"pts_time":"1.0","flags":"K__"},{"pts_time":"1.5","flags":"___"}]}`, time.Second},
		"one at the start": {`{"packets":[{"pts_time":"0.0","flags":"K_"},{"pts_time":"6.0","flags":"__"},{"pts_time":"11.9","flags":"__"}]}`, 11900 * time.Millisecond},
		"reordered":        {`{"packets":[{"pts_time":"0.1","flags":"K_"},{"pts_time":"0.3","flags":"__"},{"pts_time":"0.2","flags":"__"},{"pts_time":"5.1","flags":"K_"}]}`, 5 * time.Second},
		"no times":         {`{"packets":[{"pts_time":"N/A","flags":"K_"}]}`, 0},
		"none":             {`{}`, 0},
	} {
		got, err := longestKeyframeGap([]byte(test.json))
		if err != nil || got.Round(time.Millisecond) != test.want {
			t.Errorf("%s: %v, %v; want %v", name, got, err, test.want)
		}
	}
	if _, err := longestKeyframeGap([]byte("not json")); err == nil {
		t.Error("text that is not JSON was read")
	}
}

// tools returns ffmpeg and ffprobe, or skips the test without them.
func tools(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	ffmpeg, err1 := exec.LookPath("ffmpeg")
	ffprobe, err2 := exec.LookPath("ffprobe")
	if err1 != nil || err2 != nil {
		t.Skip("no ffmpeg or ffprobe")
	}
	return ffmpeg, ffprobe
}

// makeVideo encodes a test pattern into dir/name with ffmpeg and the encoder arguments.
func makeVideo(t *testing.T, ffmpeg, dir, name string, seconds int, encoder ...string) string {
	t.Helper()
	out := filepath.Join(dir, name)
	args := append([]string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
		"-i", "testsrc=size=320x240:rate=25", "-t", strconv.Itoa(seconds)}, encoder...)
	cmd := exec.Command(ffmpeg, append(args, out)...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("ffmpeg could not make the test video (%v): %s", err, output)
	}
	return out
}

func TestFFprobeKeyframes(t *testing.T) {
	ffmpeg, ffprobe := tools(t)
	dir := t.TempDir()
	dense := makeVideo(t, ffmpeg, dir, "dense.mp4", 4, "-c:v", "libx264", "-g", "25")
	sparse := makeVideo(t, ffmpeg, dir, "sparse.mp4", 14, "-c:v", "libx264", "-g", "1000", "-sc_threshold", "0")
	probe := FFprobeKeyframes(ffprobe)
	if gap, err := probe(t.Context(), dense); err != nil || gap > 1100*time.Millisecond {
		t.Fatalf("keyframes every second: %v, %v", gap, err)
	}
	if gap, err := probe(t.Context(), sparse); err != nil || gap < 10*time.Second {
		t.Fatalf("one keyframe in 14 s: %v, %v", gap, err)
	}
	if _, err := FFprobeKeyframes("")(t.Context(), dense); err == nil {
		t.Fatal("no ffprobe gave no error")
	}
}

// TestUploadReencodesWithFFmpeg runs the whole path for real: a file with B-frames comes out of
// a job as H.264 Constrained Baseline without them.
func TestUploadReencodesWithFFmpeg(t *testing.T) {
	ffmpeg, ffprobe := tools(t)
	if out, _ := exec.Command(ffmpeg, "-hide_banner", "-encoders").Output(); !strings.Contains(string(out), "libx264") {
		t.Skip("ffmpeg has no libx264")
	}
	src := makeVideo(t, ffmpeg, t.TempDir(), "bframes.mp4", 2, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-bf", "2")
	content, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	f := newFixture(t, func(o *Options) {
		o.FFmpeg, o.FFprobe, o.Probe, o.Keyframes = ffmpeg, ffprobe, media.FFprobe(ffprobe), FFprobeKeyframes(ffprobe)
	})
	result, err := f.upload(t, "bframes.mp4", content, "")
	if err != nil || result.Job == nil {
		t.Fatalf("not re-encoded: %+v, %v", result, err)
	}
	s := saved(t, result, nil)
	info, err := media.ProbeFile(context.Background(), ffprobe, filepath.Join(f.root, s.Path))
	if err != nil {
		t.Fatal(err)
	}
	if info.HasBFrames || info.Codec != media.CodecH264 || info.Profile != "Constrained Baseline" || info.Width != 320 {
		t.Fatalf("the re-encoded file: %+v", info)
	}
	if snapshot := result.Job.Snapshot(); snapshot.State != jobs.Done || snapshot.Title != "Prepare bframes.mp4 for streaming" {
		t.Fatalf("the job: %+v", snapshot)
	}
}
