// Package apierr writes the API's one error shape (api.Error).
package apierr

import (
	"encoding/json"
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

// WriteJSON answers status with body as JSON, not to be cached, as every error is sent.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body) // the status is sent; a failed write has no one to tell
}
