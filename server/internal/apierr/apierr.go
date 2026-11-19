// Package apierr writes the API's one error shape (api.Error).
package apierr

import (
	"encoding/json"
	"errors"
	"fmt"
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

// Error is a refused or failed operation as the API answers it, for a package whose errors
// carry nothing beside the shape.
type Error struct {
	Status  int
	Code    string
	Message string // a sentence the UI may show as it is
	Hint    string // what to do about it, or ""
	Err     error  // the cause, if any; not answered
}

// Errorf makes an Error with a formatted message.
func Errorf(status int, code, hint, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Hint: hint, Message: fmt.Sprintf(format, args...)}
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s (%v)", e.Code, e.Message, e.Err)
	}
	return e.Code + ": " + e.Message
}

func (e *Error) Unwrap() error { return e.Err }

// WriteError answers with err: an *Error as it says, anything else as a 500 whose message is
// err's.
func WriteError(w http.ResponseWriter, err error) {
	var e *Error
	if !errors.As(err, &e) {
		e = &Error{Status: http.StatusInternalServerError, Code: "internal_error", Message: err.Error()}
	}
	Write(w, e.Status, e.Code, e.Message, e.Hint)
}

// WriteJSON answers status with body as JSON, not to be cached, as every error is sent.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body) // the status is sent; a failed write has no one to tell
}
