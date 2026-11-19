package board

import (
	"net/http"

	"insight/internal/apierr"
)

// The codes of a board's failures (apierr.Error's Code), stable words the UI may branch on. They
// are the old backend's where they still apply.
const (
	// CodeInvalidRequest: a target, a fingerprint or a path that cannot be right.
	CodeInvalidRequest = "invalid_request"
	// CodeNotFound: an id that names no selected board.
	CodeNotFound = "not_found"
	// CodeNoTarget: no board is selected and none is found in the environment.
	CodeNoTarget = "no_target"
	// CodeBoardChanged: the board was replaced (another selected, its host key trusted) while
	// the request ran.
	CodeBoardChanged = "board_changed"
	// CodeHostKeyChanged: the board presented another host key than the one Insight trusts; the
	// error's HostKey says both.
	CodeHostKeyChanged = "host_key_changed"
	// CodeUnreachable: no SSH connection to the board, or it was lost.
	CodeUnreachable = "unreachable"
	// CodeAuthFailed: the board refused every key, or this machine's account has none; the
	// error's Command authorizes one.
	CodeAuthFailed = "auth_failed"
	// CodeCommandFailed: a command's output is too large, or its answer unreadable.
	CodeCommandFailed = "command_failed"
	// CodeTimeout: the request's deadline passed before the board answered.
	CodeTimeout = "timeout"
	// CodeSentinelMissing: Sentinel's socket does not exist, or nothing answers on it.
	CodeSentinelMissing = "sentinel_missing"
	// CodeSentinelDenied: the SSH user may not open Sentinel's socket.
	CodeSentinelDenied = "sentinel_denied"
	// CodeSentinelFailed: any other failure to reach Sentinel.
	CodeSentinelFailed = "sentinel_failed"
)

var httpStatus = map[string]int{
	CodeInvalidRequest: http.StatusBadRequest,
	CodeNotFound:       http.StatusNotFound,
	CodeNoTarget:       http.StatusConflict,
	CodeBoardChanged:   http.StatusConflict,
	CodeHostKeyChanged: http.StatusConflict,
	CodeTimeout:        http.StatusGatewayTimeout,
}

// boardError is a board's failure as the API answers it: its code's status (502 for a failure to
// reach the board or its Sentinel), a sentence, a recovery hint and the cause.
func boardError(code, message, hint string, cause error) *apierr.Error {
	status, ok := httpStatus[code]
	if !ok {
		status = http.StatusBadGateway
	}
	return &apierr.Error{Status: status, Code: code, Message: message, Hint: hint, Err: cause}
}

func boardChanged() *apierr.Error {
	return boardError(CodeBoardChanged, "The board was replaced while this request was running.",
		"Read the boards again and retry on the selected one.", nil)
}
