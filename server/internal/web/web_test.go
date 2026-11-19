package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"insight/internal/config"
	"insight/internal/legacy"
)

func serve(t *testing.T, h http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, target, nil))
	return w
}

func marker(name string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(name)) })
}

var fixed = func() time.Time { return time.Date(2026, 11, 18, 21, 0, 0, 123456000, time.UTC) }

func TestHealth(t *testing.T) {
	ready := false
	h := NewHandler(Deps{
		Config: config.Config{Network: config.Network{BrowserICEAddress: "10.0.0.5", BrowserICEAddressSource: "CONTAINER_HOST_IP"}},
		Ready:  func() bool { return ready },
		UI:     marker("ui"),
		Now:    fixed,
	})
	w := serve(t, h, http.MethodGet, "/api/health")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d while starting", w.Code)
	}
	ready = true
	w = serve(t, h, http.MethodGet, "/api/health")
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status %d, cache %q", w.Code, w.Header().Get("Cache-Control"))
	}
	// The frozen shape: the SDK and tools read these names.
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"status":  "ok",
		"service": "neat-insight",
		"time":    "2026-11-18T21:00:00.123456Z",
		"network": map[string]any{
			"browser_ice_address":        "10.0.0.5",
			"browser_ice_address_source": "CONTAINER_HOST_IP",
			"public_origin":              nil,
		},
	}
	gotJSON, _ := json.Marshal(body)
	wantJSON, _ := json.Marshal(want)
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("got %s\nwant %s", gotJSON, wantJSON)
	}
}

func TestRouting(t *testing.T) {
	h := NewHandler(Deps{
		Legacy:         marker("legacy"),
		LegacyPrefixes: legacy.Prefixes,
		UI:             marker("ui"),
		Now:            fixed,
	})
	cases := []struct {
		target, want string // "" is the new server's own answer, with status
		status       int
	}{
		{"/", "ui", http.StatusOK},
		{"/viewer", "ui", http.StatusOK},
		{"/api/genai/health", "legacy", http.StatusOK},
		{"/swagger-ui-assets/swagger-ui.css", "legacy", http.StatusOK},
		{"/media", "ui", http.StatusOK}, // the Media page; files are /api/media/file
		{"/media/clip.mp4", "ui", http.StatusOK},
		{"/mediafile", "ui", http.StatusOK},
		{"/api/health", "", http.StatusOK},
		{"/stream/preview/src1.mjpg", "", http.StatusNotFound},
		{"/stream/http/src1.jpg", "", http.StatusNotFound},
	}
	for _, c := range cases {
		w := serve(t, h, http.MethodGet, c.target)
		if c.want != "" && w.Body.String() != c.want {
			t.Errorf("%s went to %q, want %q", c.target, w.Body.String(), c.want)
		}
		if w.Code != c.status {
			t.Errorf("%s answered %d, want %d", c.target, w.Code, c.status)
		}
	}
}

func TestAnUnknownAPIRouteWithoutTheOldBackend(t *testing.T) {
	h := NewHandler(Deps{UI: marker("ui"), Now: fixed})
	w := serve(t, h, http.MethodGet, "/api/nothing")
	var body struct{ Error struct{ Code string } }
	json.Unmarshal(w.Body.Bytes(), &body)
	if w.Code != http.StatusNotFound || body.Error.Code != "not_found" {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}
