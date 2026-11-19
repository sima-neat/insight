// Package sentinel is Insight's way to SiMa Sentinel, the telemetry and peripheral daemon on a
// board: an allowlist of its API's requests, answered as Sentinel answers them (its schema
// marker dropped), with its failures in the API's error shape. Sentinel's API is the one its
// public clients use; Insight keeps no copy of what it holds.
//
// Stats reads its health, metric definitions, samples and cache, records traces and lists,
// reads, compares and deletes runs. The Live view's incremental history comes from Sentinel's
// own cache (ReadCache). Peripherals asks for the peripheral catalog through Call.
package sentinel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"insight/internal/apierr"
	"insight/internal/board"
)

// Schema is the Sentinel API schema Insight understands.
const Schema = 1

// MaxAnswer is how much of one answer Insight reads: a run carries every sample it recorded.
const MaxAnswer = 12 << 20

// Timeout bounds one request. Sentinel answers from its cache, so a slow answer means a wedged
// daemon or board.
const Timeout = 20 * time.Second

// Body is one of Sentinel's answers, a JSON object, without its schema marker.
type Body map[string]json.RawMessage

// The codes of Sentinel's failures, beside the board's (board.Code).
const (
	CodeInvalidRequest = "invalid_request"    // 400: Sentinel refused the request
	CodeNotFound       = "not_found"          // 404: no such run
	CodeTraceConflict  = "trace_conflict"     // 409: a trace is active, a name is taken, a run still records
	CodeTooLarge       = "request_too_large"  // 413: Sentinel refused the request's size
	CodeBusy           = "sentinel_busy"      // 429: too many requests wait on Sentinel
	CodeTimeout        = "timeout"            // 504: Sentinel did not finish in time
	CodeStopped        = "sentinel_stopped"   // 502: installed, but not running
	CodeOutdated       = "sentinel_outdated"  // 502: Sentinel has no such route: older than Insight
	CodeSchema         = "sentinel_schema"    // 502: another API schema
	CodeAnswerTooLarge = "response_too_large" // 502: an answer over MaxAnswer
	CodeFailed         = "sentinel_failed"    // 502: anything else
	CodeToolMissing    = "tool_missing"       // 502: a program Insight runs is not on the board
	CodeDenied         = "sentinel_denied"    // 502: the board user may not do it
	statusHint         = "Check `systemctl status simaai-sentinel` and `journalctl -u simaai-sentinel` on the board."
	installCommand     = "sima-cli neat install sentinel"
)

// Call sends one request to b's Sentinel, body as JSON (nil for none), and gives its answer:
// a 2xx JSON object of Schema. A refusal or failure is an *apierr.Error, or the board's
// *board.Error when the board or Sentinel's socket cannot be reached.
func Call(ctx context.Context, b *board.Board, method, path string, body any) (Body, error) {
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	var sent io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		sent = bytes.NewReader(encoded)
	}
	response, err := b.Sentinel(ctx, method, path, sent)
	if err != nil {
		return nil, diagnose(ctx, b, err)
	}
	defer response.Body.Close()
	text, err := io.ReadAll(io.LimitReader(response.Body, MaxAnswer+1))
	if err != nil {
		return nil, &apierr.Error{Status: http.StatusBadGateway, Code: CodeFailed, Err: err,
			Message: fmt.Sprintf("Sentinel's answer on %s could not be read.", b.Target().Label()), Hint: statusHint}
	}
	if len(text) > MaxAnswer {
		return nil, &apierr.Error{Status: http.StatusBadGateway, Code: CodeAnswerTooLarge,
			Message: fmt.Sprintf("Sentinel's answer on %s is larger than the %d MiB Insight reads, so it was not read.",
				b.Target().Label(), MaxAnswer>>20),
			Hint: "A saved run carries every sample it recorded; open or compare shorter runs, or record shorter traces."}
	}
	var parsed Body
	if json.Unmarshal(text, &parsed) != nil || parsed == nil {
		parsed = nil
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, refused(response.StatusCode, path, parsed, text)
	}
	if parsed == nil {
		return nil, &apierr.Error{Status: http.StatusBadGateway, Code: CodeFailed,
			Message: "Sentinel answered with something that is not a JSON object.", Hint: statusHint}
	}
	// Health, metrics, the cache and runs say their schema; the peripheral catalog says none (it
	// has a revision), so an answer is checked when it carries one.
	var schema int
	if raw, ok := parsed["schema"]; ok && (json.Unmarshal(raw, &schema) != nil || schema != Schema) {
		return nil, &apierr.Error{Status: http.StatusBadGateway, Code: CodeSchema,
			Message: fmt.Sprintf("Sentinel on the board speaks API schema %s and Insight understands schema %d.",
				strings.TrimSpace(string(parsed["schema"])), Schema),
			Hint: "Update Insight and Sentinel to matching versions: `" + installCommand + "` on the board."}
	}
	delete(parsed, "schema")
	return parsed, nil
}

// refused is what Sentinel's refusal with status means, with its own message when it gave one.
func refused(status int, path string, parsed Body, text []byte) *apierr.Error {
	message := ""
	for _, key := range []string{"error", "reason"} {
		if json.Unmarshal(parsed[key], &message) == nil && message != "" {
			break
		}
	}
	if message == "" && parsed == nil {
		message = strings.TrimSpace(string(text))
	}
	if len(message) > 500 {
		message = message[:500]
	}
	e := &apierr.Error{Status: http.StatusBadGateway, Code: CodeFailed, Message: message,
		Hint: statusHint + " Its log says more."}
	switch status {
	case http.StatusBadRequest:
		e.Status, e.Code, e.Hint = http.StatusBadRequest, CodeInvalidRequest, "Correct the request and try again."
	case http.StatusNotFound:
		if lookup(path) {
			e.Status, e.Code, e.Hint = http.StatusNotFound, CodeNotFound, "List the runs and use a name or id Sentinel reports."
		} else {
			// Sentinel answers a route it does not have with 404.
			e.Code, e.Message = CodeOutdated, fmt.Sprintf("Sentinel on the board does not provide %s.", strings.SplitN(path, "?", 2)[0])
			e.Hint = "Update Sentinel on the board with `" + installCommand + "`."
		}
	case http.StatusConflict:
		e.Status, e.Code, e.Hint = http.StatusConflict, CodeTraceConflict,
			"Only one trace records at a time, and each run needs a name of its own. Stop the active trace, or use another name."
	case http.StatusRequestEntityTooLarge:
		e.Status, e.Code, e.Hint = http.StatusRequestEntityTooLarge, CodeTooLarge, "Send a smaller request."
	case http.StatusTooManyRequests:
		e.Status, e.Code, e.Hint = http.StatusTooManyRequests, CodeBusy, "Other requests are waiting on the board; retry in a moment."
	case http.StatusGatewayTimeout:
		e.Status, e.Code, e.Hint = http.StatusGatewayTimeout, CodeTimeout, "The board may be busy; retry in a moment."
	}
	if e.Message == "" {
		e.Message = fmt.Sprintf("Sentinel refused the request with HTTP %d.", status)
	}
	return e
}

// lookup says whether path names something a 404 says does not exist, rather than a route.
func lookup(path string) bool {
	return strings.HasPrefix(path, "/v1/runs/") || strings.HasPrefix(path, "/v1/compare?")
}

// daemonScript prints what systemd knows of Sentinel's service, then the board's uptime, from
// which the service's start is worked out: two monotonic clocks, since the board's wall clock
// may be wrong right after boot.
const daemonScript = "systemctl show simaai-sentinel -p LoadState -p ActiveState -p ActiveEnterTimestampMonotonic 2>/dev/null; " +
	"echo @@; cat /proc/uptime"

// daemon is what systemd says of Sentinel's service; all empty where the board has no systemd.
type daemon struct {
	loaded, active string    // LoadState ("loaded", "not-found"), ActiveState ("active", "inactive")
	started        time.Time // zero unless active
}

func readDaemon(ctx context.Context, b *board.Board) (daemon, error) {
	result, err := b.Run(ctx, []string{"sh", "-c", daemonScript}, nil)
	if err != nil {
		return daemon{}, err
	}
	return parseDaemon(string(result.Stdout), time.Now()), nil
}

func parseDaemon(output string, now time.Time) daemon {
	show, uptime, _ := strings.Cut(output, "@@")
	var d daemon
	var since float64
	for line := range strings.Lines(show) {
		key, value, _ := strings.Cut(strings.TrimSpace(line), "=")
		switch key {
		case "LoadState":
			d.loaded = value
		case "ActiveState":
			d.active = value
		case "ActiveEnterTimestampMonotonic":
			_, _ = fmt.Sscan(value, &since)
		}
	}
	var up float64
	if _, err := fmt.Sscan(strings.TrimSpace(uptime), &up); err == nil && d.active == "active" && since > 0 && up*1e6 >= since {
		d.started = now.Add(-time.Duration((up - since/1e6) * float64(time.Second)))
	}
	return d
}

// diagnose words a failure to reach Sentinel's socket: a missing socket is a daemon that is not
// installed or not running, which systemd tells apart.
func diagnose(ctx context.Context, b *board.Board, err error) error {
	var failure *board.Error
	if !errors.As(err, &failure) || failure.Code != board.CodeSentinelMissing || ctx.Err() != nil {
		return err
	}
	d, readErr := readDaemon(ctx, b)
	if readErr != nil {
		return err
	}
	label := b.Target().Label()
	switch {
	case d.loaded == "not-found":
		return &apierr.Error{Status: http.StatusBadGateway, Code: string(board.CodeSentinelMissing), Err: err,
			Message: fmt.Sprintf("Sentinel is not installed on %s.", label),
			Hint:    "Install it on the board with `" + installCommand + "`, then retry."}
	case d.loaded == "loaded" && d.active != "active":
		return &apierr.Error{Status: http.StatusBadGateway, Code: CodeStopped, Err: err,
			Message: fmt.Sprintf("Sentinel is installed on %s but not running (%s).", label, d.active),
			Hint:    "Start it on the board with `sudo systemctl start simaai-sentinel`, then retry."}
	}
	return err
}
