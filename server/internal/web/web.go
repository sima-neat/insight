// Package web is the server's HTTP side: the routes it implements, the web UI, and the old
// backend behind them for the routes not moved yet.
package web

import (
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"slices"
	"time"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/config"
	"insight/internal/jobs"
	"insight/internal/library"
	"insight/internal/slots"
)

// Deps is what the handlers need.
type Deps struct {
	Config config.Config
	// Ready says whether every service Insight runs is up.
	Ready func() bool
	// Channels are the Viewer's channels.
	Channels ChannelSet
	// Slots are the sources src1 to src48, Library the media library and Jobs the long work
	// they start.
	Slots   *slots.Manager
	Library *library.Library
	Jobs    *jobs.Runner
	// Legacy serves the paths in LegacyPrefixes; nil answers them 404.
	Legacy         http.Handler
	LegacyPrefixes []string
	// UI serves every other path.
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
	if deps.Legacy != nil {
		for _, prefix := range deps.LegacyPrefixes {
			mux.Handle(prefix, deps.Legacy)
		}
	}
	if deps.Legacy == nil || !slices.Contains(deps.LegacyPrefixes, "/api/") {
		mux.Handle("/api/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			apierr.Write(w, http.StatusNotFound, "not_found", "There is no such API route.", "")
		}))
	}
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
	body := api.Health{
		Status:  api.HealthStatusOk,
		Service: "neat-insight",
		Time:    h.deps.Now().UTC().Format("2006-01-02T15:04:05.000000Z"),
		Network: api.HealthNetwork{
			BrowserIceAddress:       optional(network.BrowserICEAddress),
			BrowserIceAddressSource: api.HealthNetworkBrowserIceAddressSource(network.BrowserICEAddressSource),
			PublicOrigin:            optional(network.PublicOrigin),
		},
	}
	status := http.StatusOK
	if h.deps.Ready != nil && !h.deps.Ready() {
		body.Status, status = api.HealthStatusStarting, http.StatusServiceUnavailable
	}
	writeJSON(w, status, body)
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
