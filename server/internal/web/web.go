// Package web is the server's HTTP side: the routes it implements, the web UI, and the old
// backend behind them for the routes not moved yet.
package web

import (
	"encoding/json"
	"net/http"
	"slices"
	"time"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/config"
)

// Deps is what the handlers need.
type Deps struct {
	Config config.Config
	// Ready says whether every service Insight runs is up.
	Ready func() bool
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
	mux := http.NewServeMux()
	api.HandlerWithOptions(&handlers{deps}, api.StdHTTPServerOptions{
		BaseRouter:  mux,
		Middlewares: []api.MiddlewareFunc{noStore},
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			apierr.Write(w, http.StatusBadRequest, "invalid_request", err.Error(), "")
		},
	})
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
		Status:  api.Ok,
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
		body.Status, status = api.Starting, http.StatusServiceUnavailable
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
