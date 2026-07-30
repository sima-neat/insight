package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Both halves matter: the header has to reach the browser, and a conditional
// request has to still end in 304. Revalidating on every load is the point;
// re-downloading every asset on every load is not.
func TestStaticAssetsRevalidateWithoutRedownloading(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "drawing.js"), []byte("// asset\n"), 0o644); err != nil {
		t.Fatalf("writing the asset: %v", err)
	}
	handler := staticAssets(dir)

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/static/drawing.js", nil))
	if first.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", first.Code, http.StatusOK)
	}
	if got := first.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q, want %q", got, "no-cache")
	}
	modified := first.Header().Get("Last-Modified")
	if modified == "" {
		t.Fatal("no Last-Modified, so a browser has nothing to revalidate against")
	}

	conditional := httptest.NewRequest(http.MethodGet, "/static/drawing.js", nil)
	conditional.Header.Set("If-Modified-Since", modified)
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, conditional)
	if second.Code != http.StatusNotModified {
		t.Fatalf("conditional status = %d, want %d", second.Code, http.StatusNotModified)
	}
	if second.Body.Len() != 0 {
		t.Errorf("304 carried %d bytes of body", second.Body.Len())
	}
}
