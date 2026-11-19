// Package apierr writes the API's one error shape (api.Error), and is its one error type.
package apierr

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"insight/api"
)

// Write answers status with {"error": {"code", "message", "hint"?}}. code is a stable
// snake_case word the UI may branch on; message a sentence it may show as it is.
func Write(w http.ResponseWriter, status int, code, message, hint string) {
	WriteJSON(w, status, New(code, message, hint))
}

// New makes the error shape, for an answer that carries more beside it: a struct that embeds
// it keeps "error" at the top level, next to its own fields.
func New(code, message, hint string) api.Error {
	var body api.Error
	body.Error.Code, body.Error.Message = code, message
	if hint != "" {
		body.Error.Hint = &hint
	}
	return body
}

// Error is a refused or failed operation as the API answers it. Some refusals carry more than
// the shape, which the answer puts beside "error".
type Error struct {
	Status  int
	Code    string
	Message string // a sentence the UI may show as it is
	Hint    string // what to do about it, or ""
	// HostKey is set with host_key_changed: the key Insight trusts and the one the board presented.
	HostKey *api.HostKeyChange
	// Command is set with auth_failed: the shell command that authorizes Insight's key on the board.
	Command string
	// Conflict is set with name_taken: what an upload's name clashes with.
	Conflict *api.MediaConflict
	// Slots are set with in_use: the slots that use the files.
	Slots []int
	Err   error // the cause, if any; logged, not answered
}

// Errorf makes an Error with a formatted message.
func Errorf(status int, code, hint, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Hint: hint, Message: fmt.Sprintf(format, args...)}
}

// Error is the message, the sentence the UI shows, with the cause after it when there is one.
func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s (%v)", e.Message, e.Err)
	}
	return e.Message
}

func (e *Error) Unwrap() error { return e.Err }

// body is the error shape with what an Error carries beside it.
type body struct {
	api.Error
	HostKey  *api.HostKeyChange `json:"host_key,omitempty"`
	Command  string             `json:"command,omitempty"`
	Conflict *api.MediaConflict `json:"conflict,omitempty"`
	Slots    []int              `json:"slots,omitempty"`
}

// WriteError answers with err: an *Error as it says, anything else as a 500 internal_error whose
// message is err's.
func WriteError(w http.ResponseWriter, err error) {
	var e *Error
	if !errors.As(err, &e) {
		slog.Warn("an operation failed", "error", err)
		e = &Error{Status: http.StatusInternalServerError, Code: "internal_error", Message: err.Error()}
	}
	WriteJSON(w, e.Status, body{Error: New(e.Code, e.Message, e.Hint),
		HostKey: e.HostKey, Command: e.Command, Conflict: e.Conflict, Slots: e.Slots})
}

// WriteJSON answers status with body as JSON, not to be cached, as every error is sent.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body) // the status is sent; a failed write has no one to tell
}
