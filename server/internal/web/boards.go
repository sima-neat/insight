package web

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/board"
)

// checkTimeout bounds a board check: a connection (8 s at most) and the identity's command.
const checkTimeout = 30 * time.Second

// boardList is the answer of the boards' routes.
type boardList struct {
	Boards   []boardTarget  `json:"boards"`
	Selected *selectedBoard `json:"selected"`
}

type boardTarget struct {
	ID string `json:"id"`
	board.Target
	Label string `json:"label"`
}

type selectedBoard struct {
	ID       string         `json:"id"`
	Label    string         `json:"label"`
	Status   boardStatus    `json:"status"`
	Identity *boardIdentity `json:"identity"`
	SSH      string         `json:"ssh,omitempty"`
}

type boardStatus struct {
	State     board.ConnectionState `json:"state"`
	CheckedAt *time.Time            `json:"checked_at,omitempty"`
	Error     *api.ErrorDetail      `json:"error,omitempty"`
	HostKey   *hostKeyChange        `json:"host_key,omitempty"`
	Command   string                `json:"command,omitempty"`
}

type boardIdentity struct {
	Hostname string `json:"hostname"`
	Machine  string `json:"machine"`
	Build    string `json:"build"`
	HostKey  string `json:"host_key"`
}

type hostKeyChange struct {
	Host      string `json:"host"`
	Expected  string `json:"expected"`
	Presented string `json:"presented"`
}

func hostKeyOf(e *board.Error) *hostKeyChange {
	if e.HostKey == nil {
		return nil
	}
	return &hostKeyChange{Host: e.HostKey.Host, Expected: e.HostKey.Expected, Presented: e.HostKey.Presented}
}

// boardErrorBody is the error shape with what a board's failure adds.
type boardErrorBody struct {
	api.Error
	HostKey *hostKeyChange `json:"host_key,omitempty"`
	Command string         `json:"command,omitempty"`
}

// writeError answers with err: an *apierr.Error as it says, a board's failure with what it
// adds, anything else as a 500.
func writeError(w http.ResponseWriter, err error) {
	var refusal *apierr.Error
	var failure *board.Error
	if !errors.As(err, &refusal) && errors.As(err, &failure) {
		apierr.WriteJSON(w, failure.Status(), boardErrorBody{
			Error:   apierr.New(string(failure.Code), failure.Message, failure.Hint),
			HostKey: hostKeyOf(failure), Command: failure.Command,
		})
		return
	}
	apierr.WriteError(w, err)
}

func (h *handlers) boards() boardList {
	list := boardList{Boards: []boardTarget{}}
	for _, target := range h.deps.Boards.Targets() {
		list.Boards = append(list.Boards, boardTarget{ID: target.ID(), Target: target, Label: target.Label()})
	}
	b, err := h.deps.Boards.Selected()
	if err != nil {
		return list
	}
	target, status := b.Target(), b.Status()
	selected := &selectedBoard{ID: target.ID(), Label: target.Label(), Status: boardStatus{State: status.State}}
	if !status.CheckedAt.IsZero() {
		selected.Status.CheckedAt = &status.CheckedAt
	}
	if status.Err != nil {
		body := apierr.New(string(status.Err.Code), status.Err.Message, status.Err.Hint)
		selected.Status.Error, selected.Status.HostKey, selected.Status.Command = &body.Error, hostKeyOf(status.Err), status.Err.Command
	}
	if id := status.Identity; id != nil {
		selected.Identity = &boardIdentity{Hostname: id.Hostname, Machine: id.Machine, Build: id.Build, HostKey: id.HostKey}
	}
	if target.Mode == board.ModeSSH {
		selected.SSH = "ssh " + target.User + "@" + target.Host
		if target.Port != board.DefaultPort {
			selected.SSH = "ssh -p " + strconv.Itoa(target.Port) + " " + target.User + "@" + target.Host
		}
	}
	list.Selected = selected
	return list
}

// board is the selected board when id names it, or answers that it does not.
func (h *handlers) board(w http.ResponseWriter, id api.BoardID) (*board.Board, bool) {
	b, err := h.deps.Boards.Board(id)
	if err != nil {
		writeError(w, err)
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
		writeError(w, err)
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
		writeError(w, err)
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
		writeError(w, err)
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
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.boards())
}
