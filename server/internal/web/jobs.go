package web

import (
	"net/http"

	"insight/api"
	"insight/internal/jobs"
)

// jobList is the answer of GET /api/jobs.
type jobList struct {
	Jobs []jobs.Snapshot `json:"jobs"`
}

func (h *handlers) ListJobs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, jobList{Jobs: h.deps.Jobs.List()})
}

func (h *handlers) GetJob(w http.ResponseWriter, r *http.Request, id api.JobID) {
	job, ok := h.deps.Jobs.Get(id)
	writeJob(w, job, ok)
}

func (h *handlers) CancelJob(w http.ResponseWriter, r *http.Request, id api.JobID) {
	job, ok := h.deps.Jobs.Cancel(id)
	writeJob(w, job, ok)
}

// writeJob answers with the job, or, when ok is false, that there is none.
func writeJob(w http.ResponseWriter, job jobs.Snapshot, ok bool) {
	if !ok {
		jobs.WriteNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (h *handlers) FollowJob(w http.ResponseWriter, r *http.Request, id api.JobID) {
	h.deps.Jobs.ServeEvents(w, r, id)
}
