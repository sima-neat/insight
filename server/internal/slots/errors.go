package slots

import (
	"fmt"
	"net/http"

	"insight/internal/apierr"
)

// The codes of the errors (apierr.Error) the operations return.
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

func newError(status int, code, format string, args ...any) *apierr.Error {
	return &apierr.Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

// withHint is e with a hint of what to do about it.
func withHint(e *apierr.Error, hint string) *apierr.Error {
	e.Hint = hint
	return e
}

func noSuchSlot(n int) *apierr.Error {
	return newError(http.StatusNotFound, CodeNoSuchSlot, "There is no source %d; sources run from 1 to %d.", n, Count)
}

func slotBusy(n int, protocol, address string) *apierr.Error {
	holder := protocol
	if address != "" {
		holder += " " + address
	}
	return withHint(newError(http.StatusConflict, CodeSlotBusy,
		"src%d is in use by an external publisher (%s).", n, holder), "Use Take over to disconnect it.")
}
