package library

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"insight/internal/media"
	"insight/internal/relay"
)

func get(t *testing.T, handler func(http.ResponseWriter, *http.Request), header ...string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("not the error shape: %s", rec.Body)
	}
	return body.Error.Code
}

func TestFile(t *testing.T) {
	f := newFixture(t, nil)
	f.write(t, "clip.mp4", "0123456789")
	f.write(t, "page.html", "<script>alert(1)</script>")
	f.write(t, "drawing.svg", "<svg/>")
	os.Mkdir(filepath.Join(f.root, "folder"), 0o755)

	rec := get(t, func(w http.ResponseWriter, r *http.Request) { f.lib.File(w, r, "clip.mp4") }, "Range", "bytes=2-4")
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "234" || rec.Header().Get("Content-Type") != "video/mp4" {
		t.Fatalf("a range of clip.mp4: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	for _, name := range []string{"page.html", "drawing.svg"} {
		rec = get(t, func(w http.ResponseWriter, r *http.Request) { f.lib.File(w, r, name) })
		h := rec.Header()
		if h.Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(h.Get("Content-Disposition"), "attachment") ||
			h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Content-Security-Policy") != "sandbox" {
			t.Errorf("%s is served as %v", name, h)
		}
	}
	for rel, want := range map[string]int{"missing.mp4": 404, "folder": 404, "../x": 400, ".staging-1/x": 400} {
		rec = get(t, func(w http.ResponseWriter, r *http.Request) { f.lib.File(w, r, rel) })
		if rec.Code != want {
			t.Errorf("File(%q) answered %d, want %d", rel, rec.Code, want)
		}
	}
}

func TestPreviewCommand(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.FFmpeg = "/usr/bin/ffmpeg" })
	abs := f.write(t, "clip.avi", "x")
	if _, err := f.lib.PreviewCommand(abs); err == nil {
		t.Fatal("a file not probed yet made a command")
	}
	f.probes.set("clip.avi", media.Info{Kind: media.KindVideo, Codec: "mpeg4"})
	if _, err := f.lib.cache.Probe(t.Context(), abs); err != nil {
		t.Fatal(err)
	}
	cmd, err := f.lib.PreviewCommand(abs)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Join(cmd.Args[1:], " ")
	if !strings.Contains(args, "-re -stream_loop -1 -protocol_whitelist file -i file:"+abs+" -map 0:v:0 -an -c:v mjpeg -q:v 5 -f mpjpeg") {
		t.Fatalf("a preview of an H.264 file: %s", args)
	}
	f.probes.set("clip.avi", media.Info{Kind: media.KindVideo, Codec: media.CodecMJPEG})
	f.write(t, "clip.avi", "another version") // probed again
	if _, err := f.lib.cache.Probe(t.Context(), abs); err != nil {
		t.Fatal(err)
	}
	cmd, _ = f.lib.PreviewCommand(abs)
	if args := strings.Join(cmd.Args, " "); !strings.Contains(args, "-c:v copy") {
		t.Fatalf("an MJPEG file is not copied: %s", args)
	}
	for _, source := range []string{"/etc/passwd", f.root, filepath.Join(f.root, "../x"), "clip.avi"} {
		if _, err := f.lib.PreviewCommand(source); err == nil {
			t.Errorf("PreviewCommand(%q) made a command", source)
		}
	}
}

func TestPreviewRefusals(t *testing.T) {
	f := newFixture(t, nil) // no FFmpeg
	f.write(t, "clip.mp4", "x")
	for rel, want := range map[string]string{"clip.mp4": CodeFFmpegMissing, "missing.mp4": CodeNotFound, "/etc/passwd": CodeInvalidPath} {
		rec := get(t, func(w http.ResponseWriter, r *http.Request) { f.lib.Preview(w, r, rel) })
		if got := errorCode(t, rec); got != want {
			t.Errorf("Preview(%q): %s, want %s", rel, got, want)
		}
	}
}

// TestPreviewWithFFmpeg runs a real preview through the shared relays.
func TestPreviewWithFFmpeg(t *testing.T) {
	ffmpeg, ffprobe := tools(t)
	var lib *Library
	relays, err := relay.New(relay.Options{MaxRelays: 2, IdleStop: 100 * time.Millisecond, StallTimeout: 10 * time.Second,
		Start: func(key, source string) (*exec.Cmd, error) {
			if !strings.HasPrefix(key, PreviewKeyPrefix) {
				return nil, errors.New("not a file preview")
			}
			return lib.PreviewCommand(source)
		}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(relays.Close)
	f := newFixture(t, func(o *Options) {
		o.FFmpeg, o.Relays, o.Probe = ffmpeg, relays, media.FFprobe(ffprobe)
		o.Cache = media.NewCache(t.Context(), media.FFprobe(ffprobe))
	})
	lib = f.lib
	makeVideo(t, ffmpeg, f.root, "clip.mp4", 1, "-c:v", "libx264", "-pix_fmt", "yuv420p")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lib.Preview(w, r, r.URL.Query().Get("path"))
	}))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/?path=clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != relay.ContentType {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("%s %v: %s", resp.Status, resp.Header, body)
	}
	head := make([]byte, 4096)
	n, _ := io.ReadAtLeast(bufio.NewReader(resp.Body), head, 1024)
	if !bytes.Contains(head[:n], []byte{0xff, 0xd8}) {
		t.Fatalf("no JPEG in the first %d bytes", n)
	}
}

// recordingRelays are relays whose producers are recorded, never run.
func recordingRelays(t *testing.T) (*relay.Relays, *[]string) {
	t.Helper()
	var mu sync.Mutex
	started := &[]string{}
	relays, err := relay.New(relay.Options{MaxRelays: 2, IdleStop: 100 * time.Millisecond, StallTimeout: time.Second,
		Start: func(key, _ string) (*exec.Cmd, error) {
			mu.Lock()
			defer mu.Unlock()
			*started = append(*started, key)
			return nil, errors.New("recorded, not run")
		}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(relays.Close)
	return relays, started
}

// A file the probe did not read as a video or a picture never reaches ffmpeg: a playlist would
// make it stream the files the playlist names, wherever they are.
func TestAPreviewOfWhatIsNoVideoRunsNothing(t *testing.T) {
	relays, started := recordingRelays(t)
	f := newFixture(t, func(o *Options) { o.FFmpeg, o.Relays = "/usr/bin/ffmpeg", relays })
	f.write(t, "list.m3u8", "#EXTM3U\n#EXTINF:1,\n/elsewhere/private.ts\n")
	f.probes.fail("list.m3u8", fmt.Errorf("probing list.m3u8: %w", media.ErrPlaylist))
	f.write(t, "notes.txt", "text")
	for _, rel := range []string{"list.m3u8", "notes.txt"} {
		rec := get(t, func(w http.ResponseWriter, r *http.Request) { f.lib.Preview(w, r, rel) })
		if rec.Code != http.StatusUnsupportedMediaType || errorCode(t, rec) != CodeNotPreviewable {
			t.Errorf("Preview(%q) answered %d %s", rel, rec.Code, rec.Body)
		}
	}
	if len(*started) != 0 {
		t.Fatalf("producers started for %v", *started)
	}
}

// The same with the real ffprobe, for a playlist naming a clip outside the library.
func TestAPreviewOfAPlaylistWithFFprobeRunsNothing(t *testing.T) {
	ffmpeg, ffprobe := tools(t)
	relays, started := recordingRelays(t)
	f := newFixture(t, func(o *Options) {
		o.FFmpeg, o.Relays, o.Cache = ffmpeg, relays, media.NewCache(t.Context(), media.FFprobe(ffprobe))
	})
	private := makeVideo(t, ffmpeg, t.TempDir(), "private.ts", 1, "-c:v", "libx264", "-pix_fmt", "yuv420p")
	f.write(t, "list.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n"+private+"\n#EXT-X-ENDLIST\n")
	rec := get(t, func(w http.ResponseWriter, r *http.Request) { f.lib.Preview(w, r, "list.m3u8") })
	if rec.Code != http.StatusUnsupportedMediaType || len(*started) != 0 {
		t.Fatalf("a playlist's preview: %d %s, producers %v", rec.Code, rec.Body, *started)
	}
}
