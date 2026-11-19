package media

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
	"strconv"
	"strings"
	"time"
)

// Kind is what a file holds, as far as the library cares.
type Kind string

const (
	KindVideo Kind = "video"
	KindImage Kind = "image"
	// KindUnknown is a file with no video stream (audio, text), or one ffprobe could not read.
	KindUnknown Kind = "unknown"
)

// The codecs the slots stream. Info.Codec is one of them or ffprobe's own name for another.
const (
	CodecH264  = "h264"
	CodecH265  = "h265"
	CodecMJPEG = "mjpeg"
)

// Info is what one ffprobe run says about a library file's first video stream.
type Info struct {
	Kind Kind
	// Codec is CodecH264, CodecH265, CodecMJPEG or ffprobe's name of another codec ("vp9").
	Codec string
	// CodecName is the codec as the UI shows it: "H.264", "H.265", "MJPEG", else ffprobe's name.
	CodecName string
	// Profile is ffprobe's name of the codec profile ("High", "Constrained Baseline"), or "".
	Profile string
	// PixelFormat is ffprobe's name of the pixel format ("yuv420p", "rgb24"); for a picture it
	// takes the place of Pillow's mode the old backend showed.
	PixelFormat   string
	Width, Height int
	// FPS is the stream's frame rate: the average when ffprobe knows it, else the base rate. 0 for
	// a picture and when neither is known.
	FPS float64
	// FrameRate is the rate FPS was read from, as ffprobe writes it ("30000/1001").
	FrameRate string
	// Duration is the stream's duration, else the container's; 0 for a picture or when unknown.
	Duration time.Duration
	// Size is the file's size in bytes.
	Size int64
	// HasBFrames says whether the stream reorders frames (B-frames), which delays every frame
	// of a low-latency stream.
	HasBFrames bool
	// Problem says why ffprobe could not read the file; set only by Cache for a failed probe,
	// whose Kind is KindUnknown.
	Problem string
}

// Streamable says whether a slot can stream the file: its codec is H.264, H.265 or MJPEG.
func (i Info) Streamable() bool {
	if i.Kind == KindUnknown {
		return false
	}
	switch i.Codec {
	case CodecH264, CodecH265, CodecMJPEG:
		return true
	}
	return false
}

// probeTimeout bounds one ffprobe run. Probes run in the background, so a generous bound costs
// no request anything; a short one (the old backend had 10 s) timed out on a busy board.
const probeTimeout = 30 * time.Second

// ProbeFile runs ffprobe once on the regular file at abs and reads its first video stream. A
// file without one is KindUnknown with no error; a file ffprobe cannot read is an error.
func ProbeFile(ctx context.Context, ffprobePath, abs string) (Info, error) {
	name := filepath.Base(abs)
	if ffprobePath == "" {
		return Info{}, errors.New("ffprobe is not installed")
	}
	if !filepath.IsAbs(abs) {
		return Info{}, fmt.Errorf("probing %s: not an absolute path", abs)
	}
	stat, err := os.Stat(abs)
	if err != nil {
		return Info{}, fmt.Errorf("probing %s: %w", name, err)
	}
	if !stat.Mode().IsRegular() {
		return Info{}, fmt.Errorf("probing %s: not a regular file", name)
	}

	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	// abs starts with "/", so ffprobe takes it for a file, never for an option or a protocol.
	cmd := exec.CommandContext(ctx, ffprobePath,
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=codec_name,profile,pix_fmt,has_b_frames,width,height,avg_frame_rate,r_frame_rate,duration",
		"-show_entries", "format=format_name,duration",
		"-of", "json",
		abs,
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return Info{}, fmt.Errorf("ffprobe gave no answer for %s within %s", name, probeTimeout)
		}
		if ctx.Err() != nil {
			return Info{}, ctx.Err()
		}
		detail := lastLine(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return Info{}, fmt.Errorf("ffprobe could not read %s: %s", name, detail)
	}
	info, err := parseProbe(stdout.Bytes())
	if err != nil {
		return Info{}, fmt.Errorf("probing %s: %w", name, err)
	}
	info.Size = stat.Size()
	return info, nil
}

// probeOutput is the part of ffprobe's JSON that ProbeFile asks for.
type probeOutput struct {
	Streams []struct {
		CodecName    string `json:"codec_name"`
		Profile      string `json:"profile"`
		PixFmt       string `json:"pix_fmt"`
		HasBFrames   int    `json:"has_b_frames"`
		Width        int    `json:"width"`
		Height       int    `json:"height"`
		AvgFrameRate string `json:"avg_frame_rate"`
		RFrameRate   string `json:"r_frame_rate"`
		Duration     string `json:"duration"`
	} `json:"streams"`
	Format struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
	} `json:"format"`
}

func parseProbe(out []byte) (Info, error) {
	var probe probeOutput
	if err := json.Unmarshal(out, &probe); err != nil {
		return Info{}, fmt.Errorf("ffprobe wrote no JSON: %w", err)
	}
	if len(probe.Streams) == 0 {
		return Info{Kind: KindUnknown}, nil
	}
	stream := probe.Streams[0]
	info := Info{
		Kind:        KindVideo,
		Codec:       CodecOf(stream.CodecName),
		Profile:     stream.Profile,
		PixelFormat: stream.PixFmt,
		Width:       stream.Width,
		Height:      stream.Height,
	}
	info.CodecName = CodecName(info.Codec)
	if pictureFormat(probe.Format.FormatName) {
		// ffprobe gives a picture a made-up rate of 25/1; it has no rate, length or B-frames.
		info.Kind = KindImage
		return info, nil
	}
	info.FrameRate, info.FPS = FrameRate(stream.AvgFrameRate, stream.RFrameRate)
	info.Duration = seconds(stream.Duration)
	if info.Duration == 0 {
		info.Duration = seconds(probe.Format.Duration)
	}
	info.HasBFrames = stream.HasBFrames > 0
	return info, nil
}

// CodecOf names a stream's codec, as ffprobe calls it, by the library's names for the ones the
// slots stream (CodecH264, CodecH265, CodecMJPEG); another keeps ffprobe's name.
func CodecOf(ffprobeName string) string {
	switch ffprobeName {
	case "h264":
		return CodecH264
	case "hevc":
		return CodecH265
	case "mjpeg":
		return CodecMJPEG
	}
	return ffprobeName
}

// CodecName is a codec as people read it: "H.264", "H.265", "MJPEG", else as it is.
func CodecName(codec string) string {
	switch codec {
	case CodecH264:
		return "H.264"
	case CodecH265:
		return "H.265"
	case CodecMJPEG:
		return "MJPEG"
	}
	return codec
}

// pictureFormat says whether ffprobe read the file with a single-picture demuxer: jpeg_pipe,
// png_pipe and the other *_pipe ones, or image2. A Motion JPEG file is "mjpeg", a video.
func pictureFormat(formatName string) bool {
	return formatName == "image2" || strings.HasSuffix(formatName, "_pipe")
}

// FrameRate picks ffprobe's average rate (avg_frame_rate) when it is known and the base rate
// (r_frame_rate) otherwise, and returns the picked text with its value; "", 0 when neither is
// known.
func FrameRate(avg, base string) (string, float64) {
	for _, text := range []string{avg, base} {
		if fps := rational(text); fps > 0 {
			return text, fps
		}
	}
	return "", 0
}

// rational reads ffprobe's "num/den" (or a plain number); 0 for "0/0", "N/A" and other text.
func rational(text string) float64 {
	num, den, found := strings.Cut(text, "/")
	n, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0
	}
	if found {
		d, err := strconv.ParseFloat(den, 64)
		if err != nil || d == 0 {
			return 0
		}
		n /= d
	}
	return finite(n)
}

// finite is a positive, finite value, else 0 (ParseFloat reads "inf" and "nan" too).
func finite(v float64) float64 {
	if !(v > 0) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

// seconds reads ffprobe's duration in seconds; 0 for "N/A", "", negative values and values
// beyond what a time.Duration holds.
func seconds(text string) time.Duration {
	s, err := strconv.ParseFloat(text, 64)
	s = finite(s)
	if err != nil || s >= math.MaxInt64/float64(time.Second) {
		return 0
	}
	return time.Duration(s * float64(time.Second))
}

func lastLine(text string) string {
	text = strings.TrimSpace(text)
	if i := strings.LastIndexByte(text, '\n'); i >= 0 {
		text = text[i+1:]
	}
	const limit = 300
	if len(text) > limit {
		text = text[:limit]
	}
	return text
}
