package library

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/procgroup"
)

// An upload is re-encoded only when the board would stream it badly; one it streams well is
// saved as it came, whatever its container. These are the rules, in one place. They are what
// the published catalog's files are made to (media-assets/build_media_assets.py), relaxed where
// a board's decoder takes more than that: which H.264 profiles the board decodes in hardware
// is an assumption, not measured.
var (
	// keptProfiles are the profiles kept per codec; "" (ffprobe names none) is kept too.
	keptProfiles = map[string][]string{
		media.CodecH264: {"Constrained Baseline", "Baseline", "Main", "High"},
		media.CodecH265: {"Main"},
	}
	// keptPixelFormats are the 8-bit 4:2:0 formats; others (10-bit, 4:2:2) are re-encoded.
	keptPixelFormats = []string{"yuv420p", "yuvj420p"}
)

// maxKeyframeGap is the longest time between two keyframes that is kept: a reader that joins a
// stream waits up to this long for its first picture. The re-encode puts one every second.
const maxKeyframeGap = 4 * time.Second

// encodePlan is how an upload is re-encoded.
type encodePlan struct {
	// codec is media.CodecH265 for an H.265 upload, media.CodecH264 for any other.
	codec string
	// reasons say why, for the result ("B-frames", "codec VP9").
	reasons  []string
	gop      int    // frames between keyframes: one second's worth
	bitrate  string // ffmpeg's notation, "12M"
	duration time.Duration
}

// planEncode says whether the upload at abs, a file outside the library still, is re-encoded,
// and how. A file ffprobe cannot read, a picture, or one without video is kept as it is.
func (l *Library) planEncode(ctx context.Context, abs string) (encodePlan, bool) {
	info, err := l.probe(ctx, abs)
	if err != nil || info.Kind != media.KindVideo {
		return encodePlan{}, false
	}
	reasons := encodeReasons(info)
	if len(reasons) == 0 && (info.Codec == media.CodecH264 || info.Codec == media.CodecH265) {
		// Only worth measuring for a file kept otherwise; a failure keeps it.
		if gap, err := l.keyframes(ctx, abs); err == nil && gap > maxKeyframeGap {
			reasons = append(reasons, fmt.Sprintf("keyframes %.0f s apart", gap.Seconds()))
		}
	}
	if len(reasons) == 0 {
		return encodePlan{}, false
	}
	plan := encodePlan{
		codec:    media.CodecH264,
		reasons:  reasons,
		gop:      gopFor(info.FPS),
		bitrate:  bitrateFor(info.Width, info.Height, info.FPS),
		duration: info.Duration,
	}
	if info.Codec == media.CodecH265 {
		plan.codec = media.CodecH265
	}
	return plan, true
}

// encodeReasons are what in the probe makes a video stream badly; none for one kept. MJPEG is
// kept: the slots re-encode it for RTP as they stream it.
func encodeReasons(info media.Info) []string {
	switch info.Codec {
	case media.CodecMJPEG:
		return nil
	case media.CodecH264, media.CodecH265:
	default:
		return []string{"codec " + info.CodecName}
	}
	var reasons []string
	if info.HasBFrames {
		reasons = append(reasons, "B-frames")
	}
	if info.Profile != "" && !slices.Contains(keptProfiles[info.Codec], info.Profile) {
		reasons = append(reasons, "profile "+info.Profile)
	}
	if info.PixelFormat != "" && !slices.Contains(keptPixelFormats, info.PixelFormat) {
		reasons = append(reasons, "pixel format "+info.PixelFormat)
	}
	return reasons
}

// gopFor is one second of frames at fps, 30 when the rate is unknown.
func gopFor(fps float64) int {
	if fps <= 0 {
		return 30
	}
	return min(240, max(1, int(math.Round(fps))))
}

// bitrateFor scales the bitrate to the picture, as the catalog's files are made: by the shorter
// side, so that a portrait video counts as its landscape twin, and the frame rate.
func bitrateFor(width, height int, fps float64) string {
	side := min(width, height)
	switch {
	case side >= 2160:
		return "35M"
	case side >= 1080 && fps >= 100:
		return "18M"
	case side >= 1080:
		return "12M"
	case side >= 720 && fps >= 60:
		return "8M"
	case side >= 720 && fps > 0 && fps <= 20:
		return "2M"
	case side >= 720:
		return "5M"
	case side >= 480:
		return "3M"
	}
	return "1M"
}

// keptContainers can carry the re-encoded stream; an upload in another container (WebM, AVI)
// is re-encoded into MP4 and named so.
var keptContainers = map[string]bool{".mp4": true, ".m4v": true, ".mov": true, ".mkv": true}

// encodedName is the name a re-encoded upload is saved under.
func encodedName(name string) string {
	ext := filepath.Ext(name)
	if keptContainers[strings.ToLower(ext)] {
		return name
	}
	return strings.TrimSuffix(name, ext) + ".mp4"
}

// encodeArgs are ffmpeg's arguments to re-encode in into out by plan: the first video stream
// only (as the old backend's optimizer did, no audio), at its own size and rate, with a keyframe
// every second and no B-frames.
func encodeArgs(in, out string, plan encodePlan) []string {
	gop := strconv.Itoa(plan.gop)
	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-i", in, "-map", "0:v:0", "-an",
	}
	rate := []string{"-b:v", plan.bitrate, "-maxrate", plan.bitrate, "-bufsize", plan.bitrate}
	if plan.codec == media.CodecH265 {
		args = append(args, "-c:v", "libx265", "-preset", "veryfast", "-profile:v", "main",
			"-pix_fmt", "yuv420p")
		args = append(args, rate...)
		args = append(args, "-x265-params",
			"keyint="+gop+":min-keyint="+gop+":scenecut=0:bframes=0:repeat-headers=1:aud=1:log-level=error",
			"-tag:v", "hvc1")
	} else {
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "baseline",
			"-pix_fmt", "yuv420p", "-g", gop, "-keyint_min", gop, "-sc_threshold", "0", "-bf", "0")
		args = append(args, rate...)
		args = append(args, "-x264-params", "repeat-headers=1:aud=1")
	}
	switch strings.ToLower(filepath.Ext(out)) {
	case ".mp4", ".m4v", ".mov":
		args = append(args, "-movflags", "+faststart")
	}
	return append(args, "-progress", "pipe:1", "-nostats", out)
}

// encode re-encodes in into out by plan, handing ffmpeg's progress to moved. When ctx ends,
// ffmpeg is killed and ctx's error returned.
func (l *Library) encode(ctx context.Context, in, out string, plan encodePlan, moved func(*jobs.FFmpegProgress)) error {
	if l.ffmpeg == "" {
		return errors.New("FFmpeg is not installed")
	}
	cmd := exec.Command(l.ffmpeg, encodeArgs(in, out, plan)...)
	procgroup.Own(cmd)
	output, w, err := os.Pipe()
	if err != nil {
		return err
	}
	defer output.Close()
	cmd.Stdout, cmd.Stderr = w, w
	err = cmd.Start()
	w.Close() // ffmpeg holds its own copy
	if err != nil {
		return fmt.Errorf("starting FFmpeg: %w", err)
	}
	pid := cmd.Process.Pid
	stop := context.AfterFunc(ctx, func() { _ = procgroup.Signal(pid, syscall.SIGKILL) })
	// Read until ffmpeg's output ends, then stop the kill before reaping it: until it is
	// reaped, its pid cannot name another process.
	followed, readErr := jobs.FollowFFmpegWith(output, plan.duration, moved)
	stop()
	waitErr := cmd.Wait()
	switch {
	case ctx.Err() != nil:
		return ctx.Err()
	case waitErr != nil:
		detail := waitErr.Error()
		if lines := followed.Diagnostics(); len(lines) > 0 {
			detail = lines[len(lines)-1]
		}
		return fmt.Errorf("FFmpeg could not re-encode %s: %s", filepath.Base(in), detail)
	}
	return readErr
}

// KeyframeProber measures the longest time between two keyframes in the first seconds of the
// video at abs.
type KeyframeProber func(ctx context.Context, abs string) (time.Duration, error)

// keyframeScan is how much of the start of a video FFprobeKeyframes reads: enough to see a
// keyframe gap well beyond maxKeyframeGap, little enough that it reads packet headers for a
// fraction of a second.
const keyframeScan = 12 * time.Second

// FFprobeKeyframes is the KeyframeProber that reads the packets' times and flags with the
// ffprobe at ffprobePath, without decoding.
func FFprobeKeyframes(ffprobePath string) KeyframeProber {
	return func(ctx context.Context, abs string) (time.Duration, error) {
		if ffprobePath == "" {
			return 0, errors.New("ffprobe is not installed")
		}
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		// abs starts with "/", so ffprobe takes it for a file, never an option or a protocol.
		cmd := exec.CommandContext(ctx, ffprobePath, "-v", "error", "-select_streams", "v:0",
			"-read_intervals", fmt.Sprintf("%%+%d", int(keyframeScan.Seconds())),
			"-show_entries", "packet=pts_time,flags", "-of", "json", abs)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		if err := cmd.Run(); err != nil {
			return 0, fmt.Errorf("ffprobe could not read the packets of %s: %v %s", filepath.Base(abs), err, stderr.String())
		}
		return longestKeyframeGap(stdout.Bytes())
	}
}

// longestKeyframeGap reads ffprobe's packets and returns the longest time between two keyframes,
// or from the last keyframe to the last packet read.
func longestKeyframeGap(out []byte) (time.Duration, error) {
	var probe struct {
		Packets []struct {
			PTSTime string `json:"pts_time"`
			Flags   string `json:"flags"`
		} `json:"packets"`
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return 0, fmt.Errorf("ffprobe wrote no JSON: %w", err)
	}
	var keyframes []float64
	last := math.Inf(-1)
	for _, packet := range probe.Packets {
		t, err := strconv.ParseFloat(packet.PTSTime, 64)
		if err != nil || math.IsNaN(t) || math.IsInf(t, 0) {
			continue
		}
		last = max(last, t)
		if strings.Contains(packet.Flags, "K") {
			keyframes = append(keyframes, t)
		}
	}
	if len(keyframes) == 0 {
		return 0, nil
	}
	slices.Sort(keyframes)
	gap := last - keyframes[len(keyframes)-1]
	for i := 1; i < len(keyframes); i++ {
		gap = max(gap, keyframes[i]-keyframes[i-1])
	}
	return time.Duration(gap * float64(time.Second)), nil
}
