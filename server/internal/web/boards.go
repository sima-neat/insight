package web

import (
	"context"
	"net/http"
	"time"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/board"
)

// checkTimeout bounds a board check: a connection (8 s at most) and the identity's command.
const checkTimeout = 30 * time.Second

// boards is the answer of the boards' routes: the known boards and the selected one.
func (h *handlers) boards() api.BoardList {
	list := api.BoardList{Boards: []api.BoardTarget{}}
	for _, target := range h.deps.Boards.Targets() {
		entry := api.BoardTarget{Id: target.ID(), Label: target.Label(),
			Mode: api.BoardTargetMode(target.Mode), Source: api.BoardTargetSource(target.Source)}
		if target.Mode == board.ModeSSH {
			entry.Host, entry.Port, entry.User = &target.Host, &target.Port, &target.User
		}
		list.Boards = append(list.Boards, entry)
	}
	b, err := h.deps.Boards.Selected()
	if err != nil {
		return list
	}
	target, status := b.Target(), b.Status()
	selected := &api.SelectedBoard{Id: target.ID(), Label: target.Label(),
		Status: api.BoardStatus{State: api.BoardStatusState(status.State)}}
	if !status.CheckedAt.IsZero() {
		selected.Status.CheckedAt = &status.CheckedAt
	}
	if failure := status.Err; failure != nil {
		body := apierr.New(failure.Code, failure.Message, failure.Hint)
		selected.Status.Error, selected.Status.HostKey = &body.Error, failure.HostKey
		selected.Status.Command = optional(failure.Command)
	}
	if id := status.Identity; id != nil {
		selected.Identity = &api.BoardIdentity{Hostname: id.Hostname, Machine: id.Machine, Build: id.Build, HostKey: id.HostKey}
	}
	if target.Mode == board.ModeSSH {
		ssh := target.SSHCommand()
		selected.Ssh = &ssh
	}
	list.Selected = selected
	return list
}

// board is the selected board when id names it, or answers that it does not.
func (h *handlers) board(w http.ResponseWriter, id api.BoardID) (*board.Board, bool) {
	b, err := h.deps.Boards.Board(id)
	if err != nil {
		apierr.WriteError(w, err)
		return nil, false
	}
	return b, true
}

func (h *handlers) ListBoards(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.boards())
}

func (h *handlers) SelectBoard(w http.ResponseWriter, r *http.Request) {
	var body api.BoardSelection
	if !decodeJSON(w, r, &body) {
		return
	}
	if _, err := h.deps.Boards.Select(board.Target{Mode: board.ModeSSH, Host: body.Host, Port: value(body.Port), User: value(body.User)}); err != nil {
		apierr.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.boards())
}

func (h *handlers) ForgetBoard(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	var known *board.Target
	for _, target := range h.deps.Boards.Targets() {
		if target.ID() == id {
			known = &target
		}
	}
	switch {
	case known == nil:
		apierr.Write(w, http.StatusNotFound, "not_found", "Insight knows no board "+id+".", "Read the boards again.")
		return
	case known.Source != board.SourceManual:
		apierr.Write(w, http.StatusConflict, "not_entered", "Only the board entered by hand can be forgotten.",
			"This board is the one Insight runs on, or the DevKit the SDK is paired with.")
		return
	}
	if err := h.deps.Boards.Forget(); err != nil {
		apierr.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.boards())
}

func (h *handlers) CheckBoard(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	b, ok := h.board(w, id)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	defer cancel()
	if _, err := b.Identity(ctx); err != nil {
		apierr.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.boards())
}

func (h *handlers) TrustBoardHostKey(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	var body api.TrustHostKeyRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if _, err := h.deps.Boards.TrustHostKey(id, body.Fingerprint); err != nil {
		apierr.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.boards())
}
