package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"insight/api"
	"insight/internal/channels"
	"insight/internal/config"
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
	h := NewHandler(Deps{
		Config: config.Config{Network: config.Network{BrowserICEAddress: "10.0.0.5", BrowserICEAddressSource: "CONTAINER_HOST_IP"}},
		UI:     marker("ui"),
		Now:    fixed,
	})
	w := serve(t, h, http.MethodGet, "/api/health")
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
	h := NewHandler(Deps{UI: marker("ui"), Now: fixed})
	cases := []struct {
		target, want string // "" is the new server's own answer, with status
		status       int
	}{
		{"/", "ui", http.StatusOK},
		{"/viewer", "ui", http.StatusOK},
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

func TestAnUnknownAPIRoute(t *testing.T) {
	h := NewHandler(Deps{UI: marker("ui"), Now: fixed})
	// Routes earlier releases had among them: nothing behind the server answers them any more.
	for _, target := range []string{"/api/nothing", "/api/docs", "/api/openapi.json", "/api/import/youtube"} {
		w := serve(t, h, http.MethodGet, target)
		var body struct{ Error struct{ Code string } }
		json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != http.StatusNotFound || body.Error.Code != "not_found" || w.Header().Get("Content-Type") != "application/json" {
			t.Errorf("%s: %d %s %s", target, w.Code, w.Header().Get("Content-Type"), w.Body.String())
		}
	}
}

func TestTheAPIDocument(t *testing.T) {
	h := NewHandler(Deps{UI: marker("ui"), Now: fixed})
	w := serve(t, h, http.MethodGet, "/api/openapi.yaml")
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/yaml" ||
		!bytes.Equal(w.Body.Bytes(), api.Document) || !bytes.HasPrefix(api.Document, []byte("openapi: 3.")) {
		t.Fatalf("%d %s, %d bytes", w.Code, w.Header().Get("Content-Type"), w.Body.Len())
	}
}

func TestWritesFromAnotherWebsiteAreRefused(t *testing.T) {
	set := &fakeChannels{states: make([]channels.State, 1), answer: channels.Description{Type: "answer", SDP: "v=0"}}
	hosted := config.Config{Network: config.Network{PublicOrigin: "https://insight.example.com/"}}
	offer := `{"type":"offer","sdp":"v=0"}`
	for _, c := range []struct {
		name, method, target, host string
		headers                    map[string]string
		cfg                        config.Config
		refused                    bool
	}{
		{"the UI's own page", http.MethodPost, "/api/channels/0/offer", "10.0.0.5:9900",
			map[string]string{"Sec-Fetch-Site": "same-origin", "Origin": "https://10.0.0.5:9900"}, config.Config{}, false},
		{"another website", http.MethodPost, "/api/channels/0/offer", "10.0.0.5:9900",
			map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}, config.Config{}, true},
		{"another port of the same host", http.MethodPost, "/api/channels/0/offer", "10.0.0.5:9900",
			map[string]string{"Sec-Fetch-Site": "same-site", "Origin": "https://10.0.0.5:8080"}, config.Config{}, true},
		{"a body-less write", http.MethodPost, "/api/slots/stop", "10.0.0.5:9900",
			map[string]string{"Sec-Fetch-Site": "cross-site"}, config.Config{}, true},
		{"a multipart upload", http.MethodPost, "/api/media/uploads", "10.0.0.5:9900",
			map[string]string{"Sec-Fetch-Site": "cross-site", "Content-Type": "multipart/form-data; boundary=x"}, config.Config{}, true},
		{"an older browser, another website", http.MethodPost, "/api/channels/0/offer", "10.0.0.5:9900",
			map[string]string{"Origin": "https://evil.example"}, config.Config{}, true},
		// A port map changes the port Insight listens on, not the Host the browser sends.
		{"an older browser through a port map", http.MethodPost, "/api/channels/0/offer", "localhost:19900",
			map[string]string{"Origin": "https://localhost:19900"}, config.Config{}, false},
		{"an older browser through a proxy that rewrites Host", http.MethodPost, "/api/channels/0/offer", "10.77.0.1:9900",
			map[string]string{"Origin": "https://insight.example.com"}, hosted, false},
		{"curl or a script", http.MethodPost, "/api/channels/0/offer", "127.0.0.1:9900", nil, config.Config{}, false},
		{"a read from another website", http.MethodGet, "/api/health", "10.0.0.5:9900",
			map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}, config.Config{}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := NewHandler(Deps{Config: c.cfg, Channels: set, UI: marker("ui"), Now: fixed})
			r := httptest.NewRequest(c.method, c.target, strings.NewReader(offer))
			r.Host = c.host
			for key, value := range c.headers {
				r.Header.Set(key, value)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if refused := w.Code == http.StatusForbidden; refused != c.refused || refused && errorCode(t, w) != "cross_origin" {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
		})
	}
}
