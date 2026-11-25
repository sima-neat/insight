package web

import (
	"net/http"

	"insight/api"
)

func (h *handlers) GetSystem(w http.ResponseWriter, r *http.Request, params api.GetSystemParams) {
	writeJSON(w, http.StatusOK, h.deps.System.Info(r.Context(), r.Host, value(params.Refresh)))
}

func (h *handlers) GetSystemHost(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.deps.Host.Read())
}
