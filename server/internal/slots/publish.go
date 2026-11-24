package slots

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"insight/internal/media"
)

// publishArgs are ffmpeg's arguments for streaming the file at abs, whose codec is codec, into
// target (an RTSP URL of MediaMTX's): in a loop, in real time, video only. H.264 and H.265 are
// copied; MJPEG is encoded again with the JPEG settings RTP can carry (RFC 2435: the default
// Huffman tables, a quantization matrix per component), one live encoder per such slot.
func publishArgs(abs, codec, target string) []string {
	args := append([]string{
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-fflags", "+genpts+igndts",
		"-re", "-stream_loop", "-1",
	}, media.FileInput(abs)...)
	args = append(args, "-map", "0:v:0", "-an")
	if codec == media.CodecMJPEG {
		args = append(args, "-c:v", "mjpeg", "-q:v", "5", "-huffman", "default", "-force_duplicated_matrix", "1")
	} else {
		args = append(args, "-c:v", "copy")
	}
	return append(args, "-f", "rtsp", "-rtsp_transport", "tcp", target)
}

// The relay keys of a slot's MJPEG streams; RelayCommand makes their producers.
const (
	previewKeyPrefix = "slot-preview/"
	mjpegKeyPrefix   = "slot-mjpeg/"
)

func previewKey(n int) string { return previewKeyPrefix + pathName(n) }
func mjpegKey(n int) string   { return mjpegKeyPrefix + pathName(n) }

// relayArgs are ffmpeg's arguments for the producer of the relay stream key reads from source;
// false for a key that is not a slot's.
func relayArgs(key, source string) (args []string, ok bool) {
	// The SDP carries the codec's parameters, so probing the stream only delays the first
	// picture; without it the rate is unknown, hence passthrough timing (ffmpeg would
	// otherwise take H.264 for twice its rate and repeat every picture).
	input := append([]string{
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-analyzeduration", "0", "-probesize", "32",
	}, media.RTSPInput(source)...)
	input = append(input, "-fps_mode", "passthrough", "-an")
	output := []string{"-f", "mpjpeg", "-boundary_tag", "frame", "pipe:1"}
	switch {
	case strings.HasPrefix(key, previewKeyPrefix):
		args = append(input, "-vf", `scale=min(640\,iw):-2`, "-c:v", "mjpeg", "-q:v", "7")
	case strings.HasPrefix(key, mjpegKeyPrefix):
		args = append(input, "-c:v", "copy")
	default:
		return nil, false
	}
	return append(args, output...), true
}

// preloadEnv returns Insight's environment with the TCP_NODELAY shim preloaded, which
// ffmpeg's RTSP muxer needs to send each picture at once instead of waiting for Nagle's
// algorithm. Without a shim (a platform without one, a source checkout), or with one whose path
// LD_PRELOAD cannot take (a space or colon separates its entries, a "$" starts one of the
// loader's own variables), it returns nil, the inherited environment.
func preloadEnv(shim string) []string {
	if shim == "" {
		return nil
	}
	if _, err := os.Stat(shim); err != nil {
		slog.Warn("the TCP_NODELAY shim is missing; RTSP publishers run with Nagle's algorithm", "shim", shim)
		return nil
	}
	path, err := filepath.Abs(shim)
	if err == nil && strings.ContainsAny(path, " \t\n:$") {
		err = errors.New("LD_PRELOAD cannot name a path with a space, a colon or a $")
	}
	if err != nil {
		slog.Warn("the TCP_NODELAY shim cannot be preloaded; RTSP publishers run with Nagle's algorithm",
			"shim", shim, "error", err)
		return nil
	}
	env := make([]string, 0, len(os.Environ())+1)
	preload := path
	for _, entry := range os.Environ() {
		if existing, ok := strings.CutPrefix(entry, "LD_PRELOAD="); ok {
			if existing != "" {
				preload += ":" + existing
			}
			continue
		}
		env = append(env, entry)
	}
	return append(env, "LD_PRELOAD="+preload)
}

// pathName is slot n's MediaMTX path, srcN.
func pathName(n int) string { return fmt.Sprintf("src%d", n) }

// camName is the path a browser publishes slot n's webcam to, camN; MediaMTX's normalizer
// re-encodes it onto srcN.
func camName(n int) string { return fmt.Sprintf("cam%d", n) }
