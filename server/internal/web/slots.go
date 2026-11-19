package web

import (
	"net/http"
	"strconv"
	"strings"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/slots"
)

// The slots' routes answer with the slots package's own types, which the API document
// describes (contract_test.go holds the two together).

// slotList is the answer of GET /api/slots.
type slotList struct {
	Count int          `json:"count"`
	Slots []slots.Slot `json:"slots"`
}

func (h *handlers) ListSlots(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, slotList{Count: slots.Count, Slots: h.deps.Slots.List(r.Host)})
}

func (h *handlers) AssignSlot(w http.ResponseWriter, r *http.Request, n api.SlotNumber) {
	var body api.SlotAssignment
	if !decodeJSON(w, r, &body) {
		return
	}
	var err error
	switch body.Kind {
	case api.SlotAssignmentKindFile:
		err = h.deps.Slots.AssignFile(n, value(body.File), value(body.Fps))
	case api.SlotAssignmentKindPull:
		err = h.deps.Slots.AssignPull(r.Context(), n, value(body.Url), value(body.Username), value(body.Password))
	case api.SlotAssignmentKindWebcam:
		_, err = h.deps.Slots.AssignWebcam(n, r.Host) // the answer's urls.whip says the same
	default:
		apierr.Write(w, http.StatusBadRequest, "invalid_request", "kind is file, pull or webcam.", "")
		return
	}
	h.answerSlot(w, r, n, err)
}

func (h *handlers) ClearSlot(w http.ResponseWriter, r *http.Request, n api.SlotNumber) {
	h.answerSlot(w, r, n, h.deps.Slots.Clear(n))
}

func (h *handlers) StartSlot(w http.ResponseWriter, r *http.Request, n api.SlotNumber) {
	h.answerSlot(w, r, n, h.deps.Slots.Start(n))
}

func (h *handlers) StopSlot(w http.ResponseWriter, r *http.Request, n api.SlotNumber) {
	h.answerSlot(w, r, n, h.deps.Slots.Stop(n))
}

func (h *handlers) TakeOverSlot(w http.ResponseWriter, r *http.Request, n api.SlotNumber) {
	h.answerSlot(w, r, n, h.deps.Slots.TakeOver(r.Context(), n))
}

// answerSlot answers an operation on slot n: its error, or the slot as it stands after it.
func (h *handlers) answerSlot(w http.ResponseWriter, r *http.Request, n int, err error) {
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	slot, err := h.deps.Slots.Slot(n, r.Host)
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, slot)
}

func (h *handlers) PreviewSlot(w http.ResponseWriter, r *http.Request, n api.SlotNumber) {
	h.deps.Slots.Preview(w, r, n)
}

// StreamHTTPMJPEG serves the Frozen GET /stream/http/srcN.mjpg.
func (h *handlers) StreamHTTPMJPEG(w http.ResponseWriter, r *http.Request) {
	digits, ok := strings.CutPrefix(r.PathValue("file"), "src")
	digits, isMJPEG := strings.CutSuffix(digits, ".mjpg")
	n, err := strconv.Atoi(digits)
	if !ok || !isMJPEG || err != nil || strings.TrimLeft(digits, "0123456789") != "" {
		apierr.Write(w, http.StatusNotFound, "not_found", "There is no such stream.",
			"A source's HTTP MJPEG output is /stream/http/srcN.mjpg.")
		return
	}
	h.deps.Slots.ServeHTTPMJPEG(w, r, n)
}

func (h *handlers) StartSlots(w http.ResponseWriter, r *http.Request) {
	var body api.SlotStartRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	result, err := h.deps.Slots.StartFirst(body.Count)
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *handlers) StopSlots(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.deps.Slots.StopAll())
}

func (h *handlers) ResetSlots(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.deps.Slots.Reset())
}

func (h *handlers) AutoAssignSlots(w http.ResponseWriter, r *http.Request) {
	files, err := h.deps.Library.StreamableFiles()
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.deps.Slots.AutoAssign(files))
}

func (h *handlers) GetRenditionUsage(w http.ResponseWriter, r *http.Request) {
	usage, err := h.deps.Slots.RenditionUsage()
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, usage)
}

func (h *handlers) ClearRenditions(w http.ResponseWriter, r *http.Request) {
	cleared, err := h.deps.Slots.ClearRenditions()
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cleared)
}

// value is what an optional field holds, its zero value when it is absent.
func value[T any](field *T) T {
	if field == nil {
		var zero T
		return zero
	}
	return *field
}
