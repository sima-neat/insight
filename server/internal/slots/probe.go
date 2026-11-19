package slots

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"insight/internal/media"
)

// StreamInfo is what a probe of a live stream says about its first video track.
type StreamInfo struct {
	Codec         string // media.CodecOf ffprobe's name
	Width, Height int
	FPS           float64 // 0 when unknown
}

// StreamProber probes the stream at a URL (a camera, or one of MediaMTX's paths). A failure
// is a *ProbeError.
type StreamProber func(ctx context.Context, url string) (StreamInfo, error)

// ProbeError is a stream that could not be probed: refused credentials, or no answer.
type ProbeError struct {
	// Auth is true when the server refused the credentials (or asked for some).
	Auth bool
	// Detail says why, without the URL; "" when the tool said nothing useful.
	Detail string
}

func (e *ProbeError) Error() string {
	if e.Auth {
		return "the camera refused the credentials"
	}
	if e.Detail == "" {
		return "the stream did not answer"
	}
	return e.Detail
}

// streamProbeTimeout bounds one probe. MediaMTX, and cameras like it, answer a wrong password
// only after a pause of two seconds.
const streamProbeTimeout = 10 * time.Second

// FFprobeStream is the StreamProber that runs the ffprobe at ffprobePath: RTSP over TCP, a
// socket timeout of 5 s, as little probing as gives the size and rate.
func FFprobeStream(ffprobePath string) StreamProber {
	return func(ctx context.Context, url string) (StreamInfo, error) {
		if ffprobePath == "" {
			return StreamInfo{}, &ProbeError{Detail: "ffprobe is not installed"}
		}
		ctx, cancel := context.WithTimeout(ctx, streamProbeTimeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, ffprobePath,
			"-v", "error",
			"-rtsp_transport", "tcp",
			"-timeout", "5000000",
			"-analyzeduration", "2000000",
			"-select_streams", "v:0",
			"-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate",
			"-of", "json",
			"-i", url,
		)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		cmd.WaitDelay = time.Second
		err := cmd.Run()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return StreamInfo{}, &ProbeError{Detail: fmt.Sprintf("Timed out after %s", streamProbeTimeout)}
		}
		if ctx.Err() != nil {
			return StreamInfo{}, ctx.Err()
		}
		if err != nil {
			return StreamInfo{}, classifyProbeFailure(stderr.String(), url)
		}
		return parseStreamProbe(stdout.Bytes())
	}
}

var (
	authFailure = regexp.MustCompile(`\b(401|403)\b|authorization failed|Unauthorized|Forbidden`)
	// ffmpeg's log prefix ("[rtsp @ 0x55d1c0]") and a URL with a colon after it start lines.
	logPrefix = regexp.MustCompile(`^\[[^\]]*\]\s*`)
)

// classifyProbeFailure reads ffprobe's errors: a 401 or 403 is refused credentials, anything
// else no answer, said by its last line without the URL.
func classifyProbeFailure(stderr, url string) *ProbeError {
	if authFailure.MatchString(stderr) {
		return &ProbeError{Auth: true}
	}
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	detail := strings.TrimSpace(lines[len(lines)-1])
	detail = logPrefix.ReplaceAllString(detail, "")
	detail = strings.TrimPrefix(detail, url+": ")
	if strings.Contains(detail, "://") {
		// A line that still holds a URL may hold its password: say only what follows it.
		if i := strings.LastIndex(detail, ": "); i >= 0 {
			detail = detail[i+2:]
		} else {
			detail = ""
		}
	}
	if len(detail) > 200 {
		detail = detail[:200]
	}
	return &ProbeError{Detail: detail}
}

func parseStreamProbe(out []byte) (StreamInfo, error) {
	var probe struct {
		Streams []struct {
			CodecName    string `json:"codec_name"`
			Width        int    `json:"width"`
			Height       int    `json:"height"`
			AvgFrameRate string `json:"avg_frame_rate"`
			RFrameRate   string `json:"r_frame_rate"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return StreamInfo{}, &ProbeError{Detail: "ffprobe wrote no JSON"}
	}
	if len(probe.Streams) == 0 {
		return StreamInfo{}, &ProbeError{Detail: "The stream has no video track"}
	}
	s := probe.Streams[0]
	_, fps := media.FrameRate(s.AvgFrameRate, s.RFrameRate)
	return StreamInfo{Codec: media.CodecOf(s.CodecName), Width: s.Width, Height: s.Height, FPS: fps}, nil
}
