package sentinel

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"insight/internal/apierr"
	"insight/internal/board"
)

// Health is Sentinel's health answer, with when its service started: Stats says since when the
// daemon records.
type Health struct {
	Health Body `json:"health"`
	// StartedAt is when the service started, on Insight's clock; nil when systemd does not say.
	StartedAt *time.Time `json:"started_at"`
}

// ReadHealth reads Sentinel's health and its service's start.
func ReadHealth(ctx context.Context, b *board.Board) (Health, error) {
	body, err := Call(ctx, b, http.MethodGet, "/v1/health", nil)
	if err != nil {
		return Health{}, err
	}
	health := Health{Health: body}
	// The start is a fact beside the health: a board without systemd has none.
	if d, err := readDaemon(ctx, b); err == nil && !d.started.IsZero() {
		health.StartedAt = &d.started
	}
	return health, nil
}

// ActiveTrace is the trace being recorded and its summary so far, or nulls (/v1/traces/active).
func ActiveTrace(ctx context.Context, b *board.Board) (Body, error) {
	return Call(ctx, b, http.MethodGet, "/v1/traces/active", nil)
}

// Runs are the runs Sentinel holds (/v1/runs).
func Runs(ctx context.Context, b *board.Board) (Body, error) {
	return Call(ctx, b, http.MethodGet, "/v1/runs", nil)
}

// Run is one run by its id or name, its samples included (/v1/runs/{run}).
func Run(ctx context.Context, b *board.Board, run string) (Body, error) {
	return Call(ctx, b, http.MethodGet, "/v1/runs/"+url.PathEscape(run), nil)
}

// MaxCompared is how many runs one comparison takes.
const MaxCompared = 8

// Compare compares runs (ids or names), the first as the baseline, with every run's samples
// (/v1/compare).
func Compare(ctx context.Context, b *board.Board, runs []string) (Body, error) {
	if len(runs) < 2 || len(runs) > MaxCompared {
		return nil, apierr.Errorf(http.StatusBadRequest, CodeInvalidRequest,
			"Pass runs=<baseline>,<other>; the first run is the baseline.",
			"Comparing takes 2 to %d runs.", MaxCompared)
	}
	escaped := make([]string, len(runs))
	for i, run := range runs {
		if run == "" {
			return nil, apierr.Errorf(http.StatusBadRequest, CodeInvalidRequest, "Name each run by its id or name.",
				"A run to compare has no name.")
		}
		escaped[i] = url.QueryEscape(run)
	}
	return Call(ctx, b, http.MethodGet, "/v1/compare?runs="+strings.Join(escaped, ",")+"&raw=1", nil)
}

// ReadCache is Sentinel's cache (/v1/cache): its metric definitions, newest sample and recent
// samples, the Live view's whole source. A caller that holds the samples up to the one stamped
// after gets only the newer ones, with "full": false; otherwise all of them, with "full": true,
// to replace what it holds.
func ReadCache(ctx context.Context, b *board.Board, after string) (Body, error) {
	body, err := Call(ctx, b, http.MethodGet, "/v1/cache", nil)
	if err != nil {
		return nil, err
	}
	var samples []json.RawMessage
	if json.Unmarshal(body["samples"], &samples) != nil {
		samples = nil
	}
	samples, full := Window(samples, after)
	if body["samples"], err = json.Marshal(samples); err != nil {
		return nil, err
	}
	body["full"] = json.RawMessage(strconv.FormatBool(full))
	return body, nil
}

// Window is what a caller holding the samples up to the one stamped after gets of samples,
// oldest first: those after it (full false), or, when it holds none of the history, all of it
// (full true).
//
// Sentinel's cache is one history per run of the daemon, so an after it still holds is a
// window it continues: a restarted daemon holds none of the old one's stamps. A clock that
// stepped back starts the history again at the step, since what came before is not one trend
// with what comes after.
func Window(samples []json.RawMessage, after string) ([]json.RawMessage, bool) {
	start := 0
	var previous time.Time
	for i, sample := range samples {
		var stamped struct{ Timestamp string }
		if json.Unmarshal(sample, &stamped) != nil {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, stamped.Timestamp)
		if err != nil {
			continue
		}
		if !previous.IsZero() && !at.After(previous) {
			start = i
		}
		previous = at
	}
	history := samples[start:]
	if after == "" {
		return history, true
	}
	for i := len(history) - 1; i >= 0; i-- {
		var stamped struct{ Timestamp string }
		if json.Unmarshal(history[i], &stamped) == nil && stamped.Timestamp == after {
			return history[i+1:], false
		}
	}
	return history, true
}
