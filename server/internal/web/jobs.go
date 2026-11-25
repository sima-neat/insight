package web

import (
	"net/http"

	"insight/api"
)

func (h *handlers) FollowJob(w http.ResponseWriter, r *http.Request, id api.JobID) {
	h.deps.Jobs.ServeEvents(w, r, id)
}
