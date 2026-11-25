package web

import (
	"net/http"
	"strings"

	"insight/api"
	"insight/internal/sentinel"
)

// The Sentinel routes answer with Sentinel's own bodies (the sentinel package's allowlist).

func (h *handlers) GetSentinelHealth(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	if b, ok := h.board(w, id); ok {
		body, err := sentinel.ReadHealth(r.Context(), b)
		respond(w, http.StatusOK, body, err)
	}
}

func (h *handlers) GetSentinelCache(w http.ResponseWriter, r *http.Request, id api.BoardID, params api.GetSentinelCacheParams) {
	if b, ok := h.board(w, id); ok {
		body, err := sentinel.ReadCache(r.Context(), b, value(params.After))
		respond(w, http.StatusOK, body, err)
	}
}

func (h *handlers) GetSentinelActiveTrace(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	if b, ok := h.board(w, id); ok {
		body, err := sentinel.ActiveTrace(r.Context(), b)
		respond(w, http.StatusOK, body, err)
	}
}

func (h *handlers) StartSentinelTrace(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	var request api.TraceRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if b, ok := h.board(w, id); ok {
		body, err := sentinel.StartTrace(r.Context(), b,
			sentinel.TraceRequest{Name: request.Name, Note: value(request.Note), Tags: value(request.Tags)})
		respond(w, http.StatusOK, body, err)
	}
}

func (h *handlers) StopSentinelTrace(w http.ResponseWriter, r *http.Request, id api.BoardID, params api.StopSentinelTraceParams) {
	if b, ok := h.board(w, id); ok {
		body, err := sentinel.StopTrace(r.Context(), b, value(params.Trace))
		respond(w, http.StatusOK, body, err)
	}
}

func (h *handlers) ListSentinelRuns(w http.ResponseWriter, r *http.Request, id api.BoardID) {
	if b, ok := h.board(w, id); ok {
		body, err := sentinel.Runs(r.Context(), b)
		respond(w, http.StatusOK, body, err)
	}
}

func (h *handlers) GetSentinelRun(w http.ResponseWriter, r *http.Request, id api.BoardID, run string) {
	if b, ok := h.board(w, id); ok {
		body, err := sentinel.Run(r.Context(), b, run)
		respond(w, http.StatusOK, body, err)
	}
}

func (h *handlers) DeleteSentinelRun(w http.ResponseWriter, r *http.Request, id api.BoardID, run string) {
	if b, ok := h.board(w, id); ok {
		body, err := sentinel.DeleteRun(r.Context(), b, run)
		respond(w, http.StatusOK, body, err)
	}
}

func (h *handlers) CompareSentinelRuns(w http.ResponseWriter, r *http.Request, id api.BoardID, params api.CompareSentinelRunsParams) {
	var runs []string
	for run := range strings.SplitSeq(params.Runs, ",") {
		if run = strings.TrimSpace(run); run != "" {
			runs = append(runs, run)
		}
	}
	if b, ok := h.board(w, id); ok {
		body, err := sentinel.Compare(r.Context(), b, runs)
		respond(w, http.StatusOK, body, err)
	}
}
