package jobs

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"insight/internal/apierr"
)

// heartbeatEvery is how often a quiet event stream sends a comment, so that a job queued for
// minutes does not look like a dead connection to whatever lies between it and the browser.
const heartbeatEvery = 15 * time.Second

// WriteNotFound answers that a job ID names no job, active or kept: 404 job_not_found in the
// API's error shape.
func WriteNotFound(w http.ResponseWriter) {
	apierr.Write(w, http.StatusNotFound, "job_not_found", "There is no such job.",
		fmt.Sprintf("Finished jobs are kept for %d minutes.", int(keepFinished/time.Minute)))
}

// ServeEvents streams the job as Server-Sent Events (text/event-stream): one "data:" line of the
// snapshot's JSON at once and after each change, the last one the final state, after which the
// stream ends. It stops early when the client goes away. An unknown job answers 404 in the API's
// error shape.
//
// A browser's EventSource reconnects when a stream ends, and would be sent the final state again:
// the client closes it on a final state.
func (r *Runner) ServeEvents(w http.ResponseWriter, req *http.Request, id string) {
	events, unsubscribe, ok := r.Subscribe(id)
	if !ok {
		WriteNotFound(w)
		return
	}
	defer unsubscribe()
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flush := http.NewResponseController(w).Flush
	heartbeat := time.NewTicker(heartbeatEvery)
	defer heartbeat.Stop()
	for {
		select {
		case snapshot, open := <-events:
			if !open {
				return
			}
			data, err := json.Marshal(snapshot)
			if err != nil {
				slog.Warn("a job's snapshot is not JSON", "job", id, "error", err)
				return
			}
			// JSON escapes line breaks, so the event is one data line.
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil || flush() != nil {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil || flush() != nil {
				return
			}
		case <-req.Context().Done():
			return
		}
	}
}
