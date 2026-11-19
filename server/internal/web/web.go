// Package web is the server's HTTP side: the API's routes and the web UI.
package web

import (
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"time"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/board"
	"insight/internal/config"
	"insight/internal/jobs"
	"insight/internal/library"
	"insight/internal/peripherals"
	"insight/internal/slots"
	"insight/internal/system"
)

// Deps is what the handlers need.
type Deps struct {
	Config config.Config
	// Channels are the Viewer's channels.
	Channels ChannelSet
	// Slots are the sources src1 to src48, Library the media library and Jobs the long work
	// they start.
	Slots   *slots.Manager
	Library *library.Library
	Jobs    *jobs.Runner
	// Boards are the known boards and the selected one; Peripherals that board's scans,
	// camera previews and microphone tests.
	Boards      *board.Registry
	Peripherals *peripherals.Manager
	// System is System Info, Host this computer's readings.
	System *system.Reader
	Host   *system.HostReader
	// UI serves every path outside the API and the streams.
	UI http.Handler
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

// NewHandler routes every request.
func NewHandler(deps Deps) http.Handler {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	h := &handlers{deps}
	mux := http.NewServeMux()
	api.HandlerWithOptions(h, api.StdHTTPServerOptions{
		BaseRouter:  mux,
		Middlewares: []api.MiddlewareFunc{noStore},
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			apierr.Write(w, http.StatusBadRequest, "invalid_request", err.Error(), "")
		},
	})
	// The slots' HTTP MJPEG output, Frozen at a path the API document cannot describe: its
	// number is part of a path segment (/stream/http/src3.mjpg).
	mux.HandleFunc("GET /stream/http/{file}", h.StreamHTTPMJPEG)
	mux.Handle("/stream/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apierr.Write(w, http.StatusNotFound, "not_found", "There is no such stream.", "")
	}))
	mux.Handle("/api/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apierr.Write(w, http.StatusNotFound, "not_found", "There is no such API route.", "")
	}))
	mux.Handle("/", deps.UI)
	return mux
}

// noStore keeps browsers and proxies from caching API answers, which describe the moment.
func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

type handlers struct{ deps Deps }

func (h *handlers) GetHealth(w http.ResponseWriter, r *http.Request) {
	network := h.deps.Config.Network
	writeJSON(w, http.StatusOK, api.Health{
		Status:  "ok",
		Service: "neat-insight",
		Time:    h.deps.Now().UTC().Format("2006-01-02T15:04:05.000000Z"),
		Network: api.HealthNetwork{
			BrowserIceAddress:       optional(network.BrowserICEAddress),
			BrowserIceAddressSource: api.HealthNetworkBrowserIceAddressSource(network.BrowserICEAddressSource),
			PublicOrigin:            optional(network.PublicOrigin),
		},
	})
}

// GetOpenAPIDocument serves the API's own description, embedded when the server was built.
func (h *handlers) GetOpenAPIDocument(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/yaml")
	_, _ = w.Write(api.Document)
}

func optional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// maxBodyBytes bounds a JSON request body; the API's are a few hundred bytes.
const maxBodyBytes = 1 << 20

// requireJSON refuses a body that is not sent as application/json: a cross-site page can post a
// form or text without a CORS preflight, which must not change anything through a visitor's
// browser. what names the body in the message ("The offer").
func requireJSON(w http.ResponseWriter, r *http.Request, what string) bool {
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		apierr.Write(w, http.StatusUnsupportedMediaType, "json_only", what+" must be sent as application/json.", "")
		return false
	}
	return true
}

// decodeJSON reads a JSON request body into dst, or answers why it cannot: 415 when it is not
// sent as JSON, 413 when it is too large, 400 when it is not the object the route takes (a
// field it does not know included).
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if !requireJSON(w, r, "The request") {
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			apierr.Write(w, http.StatusRequestEntityTooLarge, "request_too_large", "The request is larger than 1 MiB.", "")
			return false
		}
		apierr.Write(w, http.StatusBadRequest, "invalid_request", "The request is not the JSON object this route takes: "+err.Error()+".", "")
		return false
	}
	return true
}
