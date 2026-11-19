package library

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"insight/internal/apierr"
)

func TestTheLibrarysErrorsAnswer(t *testing.T) {
	f := newFixture(t, nil)
	f.write(t, "clip.mp4", "old")
	_, err := f.upload(t, "clip.mp4", []byte("new"), "")
	rec := httptest.NewRecorder()
	apierr.WriteError(rec, err)
	want := `{"error":{"code":"name_taken","hint":"Replace it, or keep both under another name.","message":"clip.mp4 already exists."},"conflict":{"existing":"clip.mp4","suggested":"clip_2.mp4"}}`
	if rec.Code != http.StatusConflict || strings.TrimSpace(rec.Body.String()) != want {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}

	f.files.use("clip.mp4", 4)
	_, err = f.lib.Delete([]string{"clip.mp4"})
	rec = httptest.NewRecorder()
	apierr.WriteError(rec, err)
	if !strings.Contains(rec.Body.String(), `"slots":[4]`) || rec.Code != http.StatusConflict {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}

	rec = httptest.NewRecorder()
	apierr.WriteError(rec, errors.New("reading the media folder: permission denied"))
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal_error"`) ||
		rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestSizeText(t *testing.T) {
	for n, want := range map[int64]string{0: "0 bytes", 1000: "1000 bytes", 1024: "1 KiB",
		1536 << 10: "1.5 MiB", 8 << 30: "8 GiB"} {
		if got := sizeText(n); got != want {
			t.Errorf("sizeText(%d) = %q, want %q", n, got, want)
		}
	}
}
