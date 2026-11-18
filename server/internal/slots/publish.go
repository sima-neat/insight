package slots

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"insight/internal/media"
)

// publishArgs are ffmpeg's arguments for streaming the file at abs, whose codec is codec, into
// target (an RTSP URL of MediaMTX's): in a loop, in real time, video only. H.264 and H.265 are
// copied; MJPEG is encoded again with the JPEG settings RTP can carry (RFC 2435: the default
// Huffman tables, a quantization matrix per component), one live encoder per such slot.
func publishArgs(abs, codec, target string) []string {
	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-fflags", "+genpts+igndts",
		"-re", "-stream_loop", "-1",
		// "file:" so that no part of a library file's name is read as a protocol.
		"-i", "file:" + abs,
		"-map", "0:v:0", "-an",
	}
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
	input := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp",
		"-analyzeduration", "0", "-probesize", "32",
		"-i", source, "-fps_mode", "passthrough", "-an",
	}
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
// algorithm. Without a shim (a platform without one, a source checkout) it returns nil, the
// inherited environment.
func preloadEnv(shim string, aliases *shimAliases) []string {
	if shim == "" {
		return nil
	}
	if _, err := os.Stat(shim); err != nil {
		slog.Warn("the TCP_NODELAY shim is missing; RTSP publishers run with Nagle's algorithm", "shim", shim)
		return nil
	}
	path, err := aliases.loaderSafe(shim)
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

// shimAliases makes a loader-safe name for a shim whose path LD_PRELOAD cannot take as it is
// (a space or colon separates entries, and a "$" starts one of the loader's own variables): a
// link to it in a private folder, made once and removed by remove.
type shimAliases struct {
	mu  sync.Mutex
	dir string // the folder this made, "" before
}

func loaderUnsafe(path string) bool { return strings.ContainsAny(path, " \t\n:$") }

func (a *shimAliases) loaderSafe(shim string) (string, error) {
	shim, err := filepath.Abs(shim)
	if err != nil {
		return "", err
	}
	if !loaderUnsafe(shim) {
		return shim, nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.dir == "" {
		root := os.TempDir()
		if loaderUnsafe(root) {
			root = "/tmp"
		}
		dir, err := os.MkdirTemp(root, "neat-insight-preload-")
		if err != nil {
			return "", err
		}
		if err := os.Symlink(shim, filepath.Join(dir, "ffmpeg_nodelay.so")); err != nil {
			_ = os.Remove(dir) // the empty folder this call made
			return "", err
		}
		a.dir = dir
	}
	return filepath.Join(a.dir, "ffmpeg_nodelay.so"), nil
}

// remove deletes the link and the folder loaderSafe made, if it made them.
func (a *shimAliases) remove() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.dir == "" {
		return
	}
	_ = os.Remove(filepath.Join(a.dir, "ffmpeg_nodelay.so"))
	_ = os.Remove(a.dir)
	a.dir = ""
}

// pathName is slot n's MediaMTX path, srcN.
func pathName(n int) string { return fmt.Sprintf("src%d", n) }

// camName is the path a browser publishes slot n's webcam to, camN; MediaMTX's normalizer
// re-encodes it onto srcN.
func camName(n int) string { return fmt.Sprintf("cam%d", n) }
