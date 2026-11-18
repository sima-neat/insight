package slots

import (
	"errors"
	"fmt"
	"net/http"

	"insight/internal/apierr"
)

// Error is a refused or failed slot operation, with what the API answers for it: an HTTP
// status, a stable snake_case code the UI may branch on, a sentence it may show as it is, and
// an optional hint.
type Error struct {
	Status  int
	Code    string
	Message string
	Hint    string
}

func (e *Error) Error() string { return e.Message }

// The codes of the errors the operations return.
const (
	CodeNoSuchSlot       = "no_such_slot"
	CodeInvalidPath      = "invalid_path"
	CodeFileNotFound     = "file_not_found"
	CodeNotStreamable    = "not_streamable"
	CodeInvalidFPS       = "invalid_fps"
	CodeFPSNotSupported  = "fps_not_supported"
	CodeSlotBusy         = "slot_busy"
	CodeNotExternal      = "not_external"
	CodeNothingAssigned  = "nothing_assigned"
	CodeInvalidCount     = "invalid_count"
	CodeInvalidPullURL   = "invalid_pull_url"
	CodePullAuthFailed   = "pull_auth_failed"
	CodePullUnreachable  = "pull_unreachable"
	CodePullCredentials  = "pull_needs_credentials"
	CodeNotLive          = "slot_not_live"
	CodeNotMJPEG         = "not_mjpeg"
	CodeMediaMTXDown     = "mediamtx_unavailable"
	CodeMediaMTXFailed   = "mediamtx_failed"
	CodeShuttingDown     = "shutting_down"
	CodeRenditionsFailed = "renditions_failed"
)

func newError(status int, code, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

func (e *Error) withHint(hint string) *Error {
	e.Hint = hint
	return e
}

func noSuchSlot(n int) *Error {
	return newError(http.StatusNotFound, CodeNoSuchSlot, "There is no source %d; sources run from 1 to %d.", n, Count)
}

func slotBusy(n int, protocol, address string) *Error {
	holder := protocol
	if address != "" {
		holder += " " + address
	}
	return newError(http.StatusConflict, CodeSlotBusy,
		"src%d is in use by an external publisher (%s).", n, holder).withHint("Use Take over to disconnect it.")
}

// WriteError answers err in the API's error shape: an *Error as it says, anything else as an
// internal error.
func WriteError(w http.ResponseWriter, err error) {
	var e *Error
	if errors.As(err, &e) {
		apierr.Write(w, e.Status, e.Code, e.Message, e.Hint)
		return
	}
	apierr.Write(w, http.StatusInternalServerError, "internal_error", err.Error(), "")
}
