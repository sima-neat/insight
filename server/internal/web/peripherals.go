package web

import (
	"net/http"

	"insight/api"
	"insight/internal/peripherals"
)

// The Peripherals routes answer with the peripherals package's own types.

func (h *handlers) GetPeripherals(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	body, err := h.deps.Peripherals.Peripherals(b)
	respond(w, http.StatusOK, body, err)
}

func (h *handlers) RefreshPeripherals(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	body, err := h.deps.Peripherals.Refresh(r.Context(), b)
	respond(w, http.StatusOK, body, err)
}

func (h *handlers) GetCameraPreview(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	body, err := h.deps.Peripherals.Preview(b)
	respond(w, http.StatusOK, body, err)
}

func (h *handlers) StartCameraPreview(w http.ResponseWriter, r *http.Request, id api.BoardID, camera api.CameraID) {
	var request api.PreviewMode
	if !decodeJSON(w, r, &request) {
		return
	}
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	mode := peripherals.Mode{Format: request.Format, Width: request.Width, Height: request.Height, FPS: request.Fps}
	body, err := h.deps.Peripherals.StartPreview(r.Context(), b, camera, mode)
	respond(w, http.StatusOK, body, err)
}

func (h *handlers) StreamCameraPreview(w http.ResponseWriter, r *http.Request, id api.BoardID, camera api.CameraID, params api.StreamCameraPreviewParams) {
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	h.deps.Peripherals.ServePreview(w, r, b, camera, value(params.Preview))
}

func (h *handlers) StopCameraPreview(w http.ResponseWriter, r *http.Request, id api.BoardID, camera api.CameraID, params api.StopCameraPreviewParams) {
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	body, err := h.deps.Peripherals.StopPreview(b, camera, value(params.Preview))
	respond(w, http.StatusOK, body, err)
}

func (h *handlers) GetMicrophoneTest(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	body, err := h.deps.Peripherals.MicTest(b)
	respond(w, http.StatusOK, body, err)
}

func (h *handlers) StartMicrophoneTest(w http.ResponseWriter, r *http.Request, id api.BoardID, microphone api.MicrophoneID) {
	// The body is optional; one that is sent must be JSON.
	var request api.MicTestRequest
	if r.ContentLength != 0 || r.Header.Get("Content-Type") != "" {
		if !decodeJSON(w, r, &request) {
			return
		}
	}
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	body, err := h.deps.Peripherals.StartMicTest(b, microphone, value(request.Seconds))
	respond(w, http.StatusAccepted, body, err)
}

func (h *handlers) StopMicrophoneTest(w http.ResponseWriter, r *http.Request, id api.BoardID, microphone api.MicrophoneID, params api.StopMicrophoneTestParams) {
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	body, err := h.deps.Peripherals.StopMicTest(b, microphone, value(params.Test))
	respond(w, http.StatusOK, body, err)
}

func (h *handlers) GetMicrophoneTestAudio(w http.ResponseWriter, r *http.Request, id api.BoardID, microphone api.MicrophoneID, params api.GetMicrophoneTestAudioParams) {
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	h.deps.Peripherals.ServeMicTestWAV(w, r, b, microphone, value(params.Test))
}

// respond answers with an operation's result: its error, or body with status.
func respond(w http.ResponseWriter, status int, body any, err error) {
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, status, body)
}
