package sentinel

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"insight/internal/apierr"
	"insight/internal/board"
)

// The limits of a trace's name, note and tags. A name holds no comma: runs are compared by a
// comma-separated list of names or ids, in which one named "before,after" would read as two.
const (
	MaxName    = 80 // UTF-8 bytes
	MaxNote    = 512
	MaxTags    = 16
	MaxTagSize = 80
)

// TraceRequest is a trace to start.
type TraceRequest struct {
	Name string   `json:"name"`
	Note string   `json:"note,omitempty"`
	Tags []string `json:"tags,omitempty"`
}

// StartTrace starts recording a named trace (/v1/traces), after checking the request.
func StartTrace(ctx context.Context, b *board.Board, request TraceRequest) (Body, error) {
	request.Name = strings.TrimSpace(request.Name)
	if err := request.check(); err != nil {
		return nil, err
	}
	return Call(ctx, b, http.MethodPost, "/v1/traces", request)
}

func (r TraceRequest) check() error {
	invalid := func(hint, format string, args ...any) error {
		return apierr.Errorf(http.StatusBadRequest, CodeInvalidRequest, hint, format, args...)
	}
	switch {
	case r.Name == "":
		return invalid("Send a name no other run uses.", "A trace needs a name.")
	case !utf8.ValidString(r.Name):
		return invalid("Remove the characters that are not text.", "A trace's name must be text.")
	case len(r.Name) > MaxName:
		return invalid("Shorten the name.", "A trace's name can be at most %d bytes of UTF-8.", MaxName)
	case strings.ContainsFunc(r.Name, unicode.IsControl):
		return invalid("Remove line breaks and control characters.", "A trace's name cannot hold control characters.")
	case strings.Contains(r.Name, ","):
		return invalid("Runs are compared by a comma-separated list of names; use another separator, such as -.",
			"A trace's name cannot hold a comma.")
	case utf8.RuneCountInString(r.Note) > MaxNote:
		return invalid("Shorten the note, or leave it out.", "A trace's note can be at most %d characters.", MaxNote)
	case len(r.Tags) > MaxTags:
		return invalid("Send fewer tags.", "A trace can have at most %d tags.", MaxTags)
	}
	for _, tag := range r.Tags {
		if tag == "" || utf8.RuneCountInString(tag) > MaxTagSize {
			return invalid(`Send tags such as ["compiler-v2"].`, "Each tag must be 1 to %d characters.", MaxTagSize)
		}
	}
	return nil
}

// StopTrace stops and saves the active trace (/v1/traces/stop), or only the trace named id
// when id is not "" (/v1/traces/{id}/stop): another active trace is then a conflict.
func StopTrace(ctx context.Context, b *board.Board, id string) (Body, error) {
	path := "/v1/traces/stop"
	if id != "" {
		path = "/v1/traces/" + url.PathEscape(id) + "/stop"
	}
	return Call(ctx, b, http.MethodPost, path, nil)
}

// runID is the form of Sentinel's run ids, its start in UTC, then its name made safe:
// "20260924T175231.958Z-baseline". The id of a run to delete must have it, since it is passed
// to a command on the board; a run whose id does not is deleted on the board by hand.
var runID = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}\.[0-9]{3}Z-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// ValidRunID says whether id has the form of Sentinel's run ids.
func ValidRunID(id string) bool { return runID.MatchString(id) }

// deleteScript runs Sentinel's own CLI, which deletes a run (its API cannot). The id arrives as
// "$1", never in the script's text. A non-login PATH may lack the CLI's folder.
const deleteScript = `cli=$(command -v simaai-sentinel 2>/dev/null) || cli=/usr/local/bin/simaai-sentinel
[ -x "$cli" ] || { echo 'simaai-sentinel: not found' >&2; exit 127; }
exec "$cli" runs delete "$1"`

// deleteTimeout bounds the CLI's run.
const deleteTimeout = 30 * time.Second

// RunRef is a run as a delete names it.
type RunRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Deleted is the answer of a delete: the run that went and Sentinel's runs afterwards.
type Deleted struct {
	Deleted RunRef `json:"deleted"`
	Runs    Body   `json:"runs"`
}

// listedRun is what a delete reads of a run in Sentinel's list.
type listedRun struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	EndedAt *string `json:"ended_at"`
	State   string  `json:"state"`
}

// DeleteRun deletes one finished run by its id with Sentinel's CLI on the board, as the board's
// user: runs are files in /var/lib/simaai-sentinel/runs, which that user may write. The id must
// have the form of Sentinel's ids and be one of its runs; the CLI's output, not its exit status
// (it exits 0 on an error), says whether it failed, and the runs are read again to confirm.
func DeleteRun(ctx context.Context, b *board.Board, id string) (Deleted, error) {
	if !ValidRunID(id) {
		return Deleted{}, apierr.Errorf(http.StatusBadRequest, CodeInvalidRequest,
			"Use the id Sentinel reports for the run, such as 20260924T175231.958Z-baseline.",
			"%q is not the id of a run.", id)
	}
	listing, err := Runs(ctx, b)
	if err != nil {
		return Deleted{}, err
	}
	run, found := findRun(listing, id)
	if !found {
		return Deleted{}, apierr.Errorf(http.StatusNotFound, CodeNotFound,
			"List the runs again; it may have been deleted already.", "Sentinel has no run %s.", id)
	}
	if run.EndedAt == nil || run.State == "recording" || run.State == "active" || run.State == "running" {
		return Deleted{}, apierr.Errorf(http.StatusConflict, CodeTraceConflict, "Stop the trace first, then delete the run.",
			"Run %s is still recording.", id)
	}
	ctx, cancel := context.WithTimeout(ctx, deleteTimeout)
	defer cancel()
	result, err := b.Run(ctx, []string{"sh", "-c", deleteScript, "sh", id}, nil)
	if err != nil {
		return Deleted{}, err
	}
	if err := deleteFailure(id, result); err != nil {
		return Deleted{}, err
	}
	if listing, err = Runs(ctx, b); err != nil {
		return Deleted{}, err
	}
	if _, still := findRun(listing, id); still {
		return Deleted{}, apierr.Errorf(http.StatusBadGateway, CodeFailed,
			"Check the run on the board with `simaai-sentinel runs list`.",
			"`simaai-sentinel runs delete` reported no error, but Sentinel still lists run %s.", id)
	}
	return Deleted{Deleted: RunRef{ID: run.ID, Name: run.Name}, Runs: listing}, nil
}

func findRun(listing Body, id string) (listedRun, bool) {
	var runs []listedRun
	if json.Unmarshal(listing["runs"], &runs) != nil {
		return listedRun{}, false
	}
	for _, run := range runs {
		if run.ID == id {
			return run, true
		}
	}
	return listedRun{}, false
}

var errorLine = regexp.MustCompile(`(?im)^\s*error:\s*(.+)$`)

// deleteFailure is what the CLI's run says went wrong, nil when nothing did.
func deleteFailure(id string, result board.Result) error {
	output := strings.TrimSpace(string(result.Stdout) + "\n" + string(result.Stderr))
	lowered := strings.ToLower(output)
	message := ""
	if match := errorLine.FindStringSubmatch(output); match != nil {
		message = strings.TrimSpace(match[1])
	}
	or := func(fallback string) string {
		if message != "" {
			return message
		}
		return fallback
	}
	switch {
	case result.Exit == 127 || strings.Contains(lowered, "simaai-sentinel: not found"):
		return apierr.Errorf(http.StatusBadGateway, CodeToolMissing,
			"Reinstall Sentinel with `"+installCommand+"`, or delete the run in a shell on the board.",
			"`simaai-sentinel` is not on the board, so run %s cannot be deleted from here.", id)
	case strings.Contains(lowered, "cannot delete active run"):
		return apierr.Errorf(http.StatusConflict, CodeTraceConflict, "Stop the trace first, then delete the run.",
			"%s", or(fmt.Sprintf("Run %s is still recording.", id)))
	case strings.Contains(lowered, "unknown completed run"):
		return apierr.Errorf(http.StatusNotFound, CodeNotFound, "List the runs again.",
			"%s", or(fmt.Sprintf("Sentinel has no finished run %s.", id)))
	case strings.Contains(lowered, "permission denied") || strings.Contains(lowered, "operation not permitted"):
		return apierr.Errorf(http.StatusBadGateway, CodeDenied,
			"Runs are files in /var/lib/simaai-sentinel/runs; the board's user needs to be allowed to write there.",
			"The board's user may not delete run %s.", id)
	case result.Exit != 0 || message != "":
		return apierr.Errorf(http.StatusBadGateway, CodeFailed,
			"Run `simaai-sentinel runs delete` in a shell on the board to see more.",
			"%s", or(fmt.Sprintf("`simaai-sentinel runs delete` failed on the board (exit %d).", result.Exit)))
	}
	return nil
}
