package library

import (
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"insight/internal/apierr"
	"insight/internal/media"
)

// File answers with the library file at rel for the browser to play or show, with range
// requests (http.ServeContent). Only video and pictures are served as what they are; anything
// else is a download, and nothing served may run script in Insight's origin.
func (l *Library) File(w http.ResponseWriter, r *http.Request, rel string) {
	abs, err := l.existingFile(rel)
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		apierr.WriteError(w, notFound("There is no file %s in the media library.", rel))
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	header := w.Header()
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Security-Policy", "sandbox")
	if contentType, ok := playable(abs); ok {
		header.Set("Content-Type", contentType)
	} else {
		header.Set("Content-Type", "application/octet-stream")
		header.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": info.Name()}))
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

// playable is the type of a file the browser may play or show, by its extension: video and
// pictures, but no SVG, which can hold script.
func playable(name string) (string, bool) {
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	base, _, _ := strings.Cut(contentType, ";")
	switch {
	case base == "image/svg+xml":
		return "", false
	case strings.HasPrefix(base, "video/"), strings.HasPrefix(base, "image/"):
		return contentType, true
	}
	return "", false
}

// PreviewKeyPrefix starts the relay key of a file preview, the rest being its library path.
// The relays' Start hands such a key's source to PreviewCommand.
const PreviewKeyPrefix = "file:"

// Preview answers with the library file at rel as a moving MJPEG picture, looped at its own
// rate, from the shared relay: one ffmpeg per file however many watch it.
func (l *Library) Preview(w http.ResponseWriter, r *http.Request, rel string) {
	abs, err := l.existingFile(rel)
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	if l.ffmpeg == "" {
		apierr.WriteError(w, &apierr.Error{Status: http.StatusServiceUnavailable, Code: CodeFFmpegMissing,
			Message: "Previews need FFmpeg, which is not installed."})
		return
	}
	if l.relays == nil {
		apierr.WriteError(w, errors.New("the library has no relays for previews"))
		return
	}
	l.relays.Serve(w, r, PreviewKeyPrefix+l.libraryPath(abs), abs)
}

// PreviewCommand makes the producer of a file preview for the relays: source is the absolute
// path Preview passed. The old backend's arguments: the first video stream at real time, looped,
// as MJPEG (copied when the file is MJPEG already, as its probe says).
func (l *Library) PreviewCommand(source string) (*exec.Cmd, error) {
	if l.ffmpeg == "" {
		return nil, errors.New("FFmpeg is not installed")
	}
	below, err := filepath.Rel(l.root, source)
	if err != nil || !filepath.IsAbs(source) || below == "." || !filepath.IsLocal(below) {
		return nil, fmt.Errorf("%s is not a file in the media library", source)
	}
	info, ok := l.cache.Get(source)
	return exec.Command(l.ffmpeg, previewArgs(source, ok && info.Codec == media.CodecMJPEG)...), nil
}

func previewArgs(abs string, copyMJPEG bool) []string {
	args := append([]string{
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-fflags", "+genpts+igndts", "-re", "-stream_loop", "-1",
	}, media.FileInput(abs)...)
	args = append(args, "-map", "0:v:0", "-an")
	if copyMJPEG {
		args = append(args, "-c:v", "copy")
	} else {
		args = append(args, "-c:v", "mjpeg", "-q:v", "5")
	}
	return append(args, "-f", "mpjpeg", "-boundary_tag", "frame", "pipe:1")
}
