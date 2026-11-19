package slots

import (
	"net/http"
	"os/exec"

	"insight/internal/apierr"
	"insight/internal/media"
	"insight/internal/mediamtx"
)

// RelayCommand makes the producer of a slot's relayed MJPEG stream, for relay.Options.Start:
// ffmpeg reading source (the slot's RTSP URL) and writing mpjpeg to its stdout. It is false for
// a key that is not a slot's, such as the media library's file previews.
//
//   - A preview ("slot-preview/srcN") decodes whatever the slot carries and encodes it as MJPEG
//     at most 640 pixels wide, at the source's own rate.
//   - A slot's HTTP MJPEG output ("slot-mjpeg/srcN") copies the slot's MJPEG pictures as they
//     are: every reader gets the same live stream and nothing is decoded.
func RelayCommand(ffmpegPath, key, source string) (*exec.Cmd, bool) {
	args, ok := relayArgs(key, source)
	if !ok {
		return nil, false
	}
	return exec.Command(ffmpegPath, args...), true
}

// Preview answers req with slot n's live stream as MJPEG at most 640 pixels wide, one relay
// however many browsers watch it; 409 while the slot is not live.
func (m *Manager) Preview(w http.ResponseWriter, req *http.Request, n int) {
	if err := m.checkLive(n, false); err != nil {
		apierr.WriteError(w, err)
		return
	}
	m.opts.Relays.Serve(w, req, previewKey(n), m.opts.RTSPBase+"/"+pathName(n)+"?"+mediamtx.PreviewReaderQuery)
}

// ServeHTTPMJPEG answers req with slot n's HTTP MJPEG output (/stream/http/srcN.mjpg): the
// slot's MJPEG stream as it is, the same pictures for every reader; 409 while the slot carries
// no MJPEG stream.
func (m *Manager) ServeHTTPMJPEG(w http.ResponseWriter, req *http.Request, n int) {
	if err := m.checkLive(n, true); err != nil {
		apierr.WriteError(w, err)
		return
	}
	m.opts.Relays.Serve(w, req, mjpegKey(n), m.opts.RTSPBase+"/"+pathName(n))
}

// checkLive refuses a relay of slot n while MediaMTX has no stream on it, or, with mjpeg, no
// MJPEG stream.
func (m *Manager) checkLive(n int, mjpeg bool) error {
	if err := checkSlot(n); err != nil {
		return err
	}
	m.mu.Lock()
	path, ok := m.snap.Paths[pathName(n)]
	m.mu.Unlock()
	switch {
	case !ok || !path.Ready:
		return newError(http.StatusConflict, CodeNotLive, "src%d is not live.", n)
	case mjpeg && path.Codec != media.CodecMJPEG:
		return withHint(newError(http.StatusConflict, CodeNotMJPEG, "src%d does not carry MJPEG, so it has no HTTP MJPEG output.", n),
			"Read it over RTSP.")
	}
	return nil
}
