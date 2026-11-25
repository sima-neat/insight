package spa

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

var built = fstest.MapFS{
	"index.html":           {Data: []byte("<app-root></app-root>")},
	"main-B2TFS5NE.js":     {Data: []byte("main")},
	"favicon.svg":          {Data: []byte("<svg/>")},
	"assets/logo.svg":      {Data: []byte("<svg/>")},
	"chunk-66hVC8Pg.js":    {Data: []byte("chunk")},
	"3rdpartylicenses.txt": {Data: []byte("licenses")},
}

func get(t *testing.T, h http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, target, nil))
	return w
}

func TestHandler(t *testing.T) {
	h := Handler(built)
	cases := []struct {
		target, wantBody, wantCache string
		wantStatus                  int
	}{
		{"/", "<app-root></app-root>", "no-cache", 200},
		{"/viewer", "<app-root></app-root>", "no-cache", 200},
		{"/stats/runs/compare", "<app-root></app-root>", "no-cache", 200},
		{"/main-B2TFS5NE.js", "main", "public, max-age=31536000, immutable", 200},
		{"/chunk-66hVC8Pg.js", "chunk", "public, max-age=31536000, immutable", 200},
		{"/favicon.svg", "<svg/>", "no-cache", 200},
		{"/assets/logo.svg", "<svg/>", "no-cache", 200},
		{"/missing.js", "", "", 404},
		{"/../index.html", "<app-root></app-root>", "no-cache", 200},
	}
	for _, c := range cases {
		t.Run(c.target, func(t *testing.T) {
			w := get(t, h, http.MethodGet, c.target)
			if w.Code != c.wantStatus {
				t.Fatalf("status %d, want %d", w.Code, c.wantStatus)
			}
			if c.wantBody != "" && w.Body.String() != c.wantBody {
				t.Fatalf("body %q", w.Body.String())
			}
			if got := w.Header().Get("Cache-Control"); got != c.wantCache {
				t.Fatalf("cache %q, want %q", got, c.wantCache)
			}
		})
	}
	if w := get(t, h, http.MethodPost, "/"); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST answered %d", w.Code)
	}
}

func TestHandlerWithoutABuild(t *testing.T) {
	w := get(t, Handler(fstest.MapFS{}), http.MethodGet, "/viewer")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", w.Code)
	}
}

func TestTheEmbeddedFilesHaveTheirFolder(t *testing.T) {
	// Without a frontend build, dist holds its README only; Files must still work.
	if _, err := Files().Open("README.md"); err != nil {
		t.Fatal(err)
	}
}
