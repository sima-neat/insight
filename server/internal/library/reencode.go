package library

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/supervisor"
)

// An upload is re-encoded only when the board would stream it badly; one it streams well is
// saved as it came, whatever its container. These are the rules, in one place. They are what
// the published catalog's files are made to (media-assets/build_media_assets.py), relaxed where
// a board's decoder takes more than that: which H.264 profiles the board decodes in hardware
// is an assumption, not measured. The re-encode itself is the catalog's (media.Encode).
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
	// encode is H.265 for an H.265 upload, H.264 for any other, at its own size and rate.
	encode media.Encode
	// reasons say why, for the result ("B-frames", "codec VP9").
	reasons  []string
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
	codec := media.CodecH264
	if info.Codec == media.CodecH265 {
		codec = media.CodecH265
	}
	return encodePlan{
		encode:   media.Encode{Codec: codec, Width: info.Width, Height: info.Height, FPS: info.FPS},
		reasons:  reasons,
		duration: info.Duration,
	}, true
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

// muxers are the containers that can carry the re-encoded stream, with ffmpeg's muxer for each;
// an upload in another container (WebM, AVI) is re-encoded into MP4 and named so.
var muxers = map[string]string{".mp4": "mp4", ".m4v": "mp4", ".mov": "mov", ".mkv": "matroska"}

// encodedName is the name a re-encoded upload is saved under.
func encodedName(name string) string {
	ext := filepath.Ext(name)
	if _, kept := muxers[strings.ToLower(ext)]; kept {
		return name
	}
	return strings.TrimSuffix(name, ext) + ".mp4"
}

// encode re-encodes in into out by plan, under the supervisor, handing ffmpeg's progress to
// moved. When ctx ends, ffmpeg is stopped and ctx's error returned.
func (l *Library) encode(ctx context.Context, in, out string, plan encodePlan, moved func(*jobs.FFmpegProgress)) error {
	if l.ffmpeg == "" {
		return errors.New("FFmpeg is not installed")
	}
	sum := sha256.Sum256([]byte(out))
	spec := supervisor.Spec{
		Name: fmt.Sprintf("reencode-%x", sum[:8]), Path: l.ffmpeg,
		Args: plan.encode.Args(in, out, muxers[strings.ToLower(filepath.Ext(out))]),
	}
	if err := jobs.RunFFmpeg(ctx, l.start, spec, plan.duration, moved); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("FFmpeg could not re-encode %s: %v", filepath.Base(in), err)
	}
	return nil
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
