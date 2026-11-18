package board

import (
	"fmt"
	"net/http"
)

// Code is a board failure's stable word, which the UI may branch on. The codes are the old
// backend's (neat_insight/board/errors.py, sentinel/client.py) where they still apply.
type Code string

const (
	// CodeInvalidRequest: a target, a fingerprint or a path that cannot be right.
	CodeInvalidRequest Code = "invalid_request"
	// CodeNotFound: an id that names no selected board.
	CodeNotFound Code = "not_found"
	// CodeNoTarget: no board is selected and none is found in the environment.
	CodeNoTarget Code = "no_target"
	// CodeBoardChanged: the board was replaced (another selected, its host key trusted) while
	// the request ran. It replaces the old backend's stale_snapshot.
	CodeBoardChanged Code = "board_changed"
	// CodeHostKeyChanged: the board presented another host key than the one Insight trusts.
	CodeHostKeyChanged Code = "host_key_changed"
	// CodeUnreachable: no SSH connection to the board, or it was lost.
	CodeUnreachable Code = "unreachable"
	// CodeAuthFailed: the board refused every key, or this machine's account has none.
	CodeAuthFailed Code = "auth_failed"
	// CodeCommandFailed: a command's output is too large, or its answer unreadable.
	CodeCommandFailed Code = "command_failed"
	// CodeTimeout: the request's deadline passed before the board answered.
	CodeTimeout Code = "timeout"
	// CodeSentinelMissing: Sentinel's socket does not exist, or nothing answers on it.
	CodeSentinelMissing Code = "sentinel_missing"
	// CodeSentinelDenied: the SSH user may not open Sentinel's socket.
	CodeSentinelDenied Code = "sentinel_denied"
	// CodeSentinelFailed: any other failure to reach Sentinel.
	CodeSentinelFailed Code = "sentinel_failed"
)

var httpStatus = map[Code]int{
	CodeInvalidRequest:  http.StatusBadRequest,
	CodeNotFound:        http.StatusNotFound,
	CodeNoTarget:        http.StatusConflict,
	CodeBoardChanged:    http.StatusConflict,
	CodeHostKeyChanged:  http.StatusConflict,
	CodeUnreachable:     http.StatusBadGateway,
	CodeAuthFailed:      http.StatusBadGateway,
	CodeCommandFailed:   http.StatusBadGateway,
	CodeTimeout:         http.StatusGatewayTimeout,
	CodeSentinelMissing: http.StatusBadGateway,
	CodeSentinelDenied:  http.StatusBadGateway,
	CodeSentinelFailed:  http.StatusBadGateway,
}

// Error is a board failure as the UI shows it: a code, a sentence and a recovery hint.
type Error struct {
	Code    Code
	Message string
	Hint    string
	// HostKey is set for CodeHostKeyChanged: the key the board presented and the one trusted.
	HostKey *HostKeyChange
	// Command is set for CodeAuthFailed: the shell command that authorizes a key on the board.
	Command string
	// Err is the cause, if any.
	Err error
}

// HostKeyChange is what a CodeHostKeyChanged error carries for the user to confirm.
type HostKeyChange struct {
	// Host is the board's name in known_hosts: "host", or "[host]:port" off port 22.
	Host string
	// Expected is the trusted key's SHA256 fingerprint, Presented the new one's, which
	// TrustHostKey takes.
	Expected, Presented string
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s (%v)", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.Err }

// Status is the HTTP status the API answers this error with.
func (e *Error) Status() int {
	if status, ok := httpStatus[e.Code]; ok {
		return status
	}
	return http.StatusBadGateway
}

func boardChanged() *Error {
	return &Error{
		Code:    CodeBoardChanged,
		Message: "The board was replaced while this request was running.",
		Hint:    "Read the boards again and retry on the selected one.",
	}
}
