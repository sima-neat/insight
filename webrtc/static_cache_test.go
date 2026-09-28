package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestStaticFilesAskBrowsersToRevalidate(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.js"), []byte("console.log(1);\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler := staticFileHandler(http.Dir(dir))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/static/app.js", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, want %q", got, "no-cache")
	}
	if got := rec.Body.String(); got != "console.log(1);\n" {
		t.Fatalf("body = %q", got)
	}
	lastModified := rec.Header().Get("Last-Modified")
	if lastModified == "" {
		t.Fatal("Last-Modified missing, conditional requests would not work")
	}

	conditional := httptest.NewRequest(http.MethodGet, "/static/app.js", nil)
	conditional.Header.Set("If-Modified-Since", lastModified)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, conditional)

	if rec.Code != http.StatusNotModified {
		t.Fatalf("conditional status = %d, want %d", rec.Code, http.StatusNotModified)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("conditional Cache-Control = %q, want %q", got, "no-cache")
	}
}

func TestViewerPageAsksBrowsersToRevalidate(t *testing.T) {
	// serveViewer reads static/viewer.html relative to the working directory.
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "static"), 0o755); err != nil {
		t.Fatal(err)
	}
	page := "<!doctype html><title>viewer</title>\n"
	if err := os.WriteFile(filepath.Join(dir, "static", "viewer.html"), []byte(page), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	handler := viewerPageHandler()

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, want %q", got, "no-cache")
	}
	if got := rec.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := rec.Body.String(); got != page {
		t.Fatalf("body = %q", got)
	}
}
