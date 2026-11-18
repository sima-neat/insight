package library

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"insight/internal/jobs"
)

// fakeCatalog serves an index and its assets, counting the index's fetches.
type fakeCatalog struct {
	srv     *httptest.Server
	fetches atomic.Int32
	mu      sync.Mutex
	assets  map[string][]byte // by path, what is served
	listed  []map[string]any
	fail    bool          // the index answers 500
	hold    chan struct{} // while set, an asset sends one byte, then waits for it to close
}

func newFakeCatalog(t *testing.T) *fakeCatalog {
	t.Helper()
	c := &fakeCatalog{assets: map[string][]byte{}}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		if r.URL.Path == "/index.json" {
			c.fetches.Add(1)
			fail, listed := c.fail, c.listed
			c.mu.Unlock()
			if fail {
				http.Error(w, "down", http.StatusInternalServerError)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{
				"schema": "sima.neat.insight.media-assets.index.v1", "generated_at": "2026-11-18T00:00:00Z",
				"sources": []any{map[string]any{"id": "street", "title": "Street"}}, "assets": listed,
			})
			return
		}
		data, ok := c.assets[strings.TrimPrefix(r.URL.Path, "/assets/")]
		hold := c.hold
		c.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		if hold != nil {
			w.Header().Set("Content-Length", "1000000")
			w.Write(data[:1])
			w.(http.Flusher).Flush()
			select {
			case <-hold:
			case <-r.Context().Done():
			}
			return
		}
		w.Write(data)
	}))
	t.Cleanup(c.srv.Close)
	return c
}

// add lists an asset at path whose catalog entry says the given size and hash of content, and
// serves served (content, unless it differs).
func (c *fakeCatalog) add(path string, content, served []byte, extra map[string]any) {
	sum := sha256.Sum256(content)
	asset := map[string]any{
		"path": path, "source_id": "street", "source_title": "Street", "profile": "720p30",
		"fps": 30, "codec": "h264", "container": "mp4", "bytes": len(content), "sha256": hex.EncodeToString(sum[:]),
		"title": "kept as the index has it",
	}
	for k, v := range extra {
		asset[k] = v
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.listed = append(c.listed, asset)
	c.assets[path] = served
}

func catalogFixture(t *testing.T) (*fixture, *fakeCatalog) {
	t.Helper()
	c := newFakeCatalog(t)
	f := newFixture(t, func(o *Options) {
		o.CatalogIndexURL = c.srv.URL + "/index.json"
		o.CatalogBaseURL = c.srv.URL + "/assets"
		o.Client = c.srv.Client()
	})
	return f, c
}

func TestCatalogListsAssetsWithTheirURLsAndIsKeptAWhile(t *testing.T) {
	f, c := catalogFixture(t)
	c.add("street/720p30/a.mp4", []byte("a"), []byte("a"), nil)
	c.add("../../evil.mp4", []byte("e"), []byte("e"), nil)
	now := time.Now()
	f.lib.now = func() time.Time { return now }

	catalog, err := f.lib.Catalog(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Assets) != 2 || catalog.Assets[0]["url"] != c.srv.URL+"/assets/street/720p30/a.mp4" ||
		catalog.Assets[0]["title"] != "kept as the index has it" || catalog.BaseURL != c.srv.URL+"/assets/" {
		t.Fatalf("the catalog: %+v", catalog)
	}
	if _, ok := catalog.Assets[1]["url"]; ok {
		t.Fatalf("an asset whose path leads up got a URL: %v", catalog.Assets[1])
	}
	f.lib.Catalog(t.Context())
	if n := c.fetches.Load(); n != 1 {
		t.Fatalf("fetched %d times within its age", n)
	}
	now = now.Add(catalogMaxAge)
	f.lib.Catalog(t.Context())
	if n := c.fetches.Load(); n != 2 {
		t.Fatalf("fetched %d times after its age", n)
	}
}

func TestCatalogUnavailable(t *testing.T) {
	f, c := catalogFixture(t)
	c.fail = true
	if _, err := f.lib.Catalog(t.Context()); code(err) != CodeCatalogUnavailable {
		t.Fatalf("%v, want catalog_unavailable", err)
	}
	c.mu.Lock()
	c.fail = false
	c.mu.Unlock()
	if _, err := f.lib.Catalog(t.Context()); err != nil {
		t.Fatalf("a failure was kept: %v", err)
	}
}

func TestImportCatalog(t *testing.T) {
	f, c := catalogFixture(t)
	content := []byte(strings.Repeat("video", 1000))
	c.add("street/720p30/a.mp4", content, content, nil)
	c.add("street/720p30/bad-sum.mp4", content, []byte(strings.Repeat("VIDEO", 1000)), nil)
	c.add("street/720p30/short.mp4", content, content[:100], nil)

	job, err := f.lib.ImportCatalog(t.Context(), "street/720p30/a.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if job.Snapshot().Kind != KindCatalogImport || job.Snapshot().Title != "Import Street 720p30 h264" {
		t.Fatalf("the job: %+v", job.Snapshot())
	}
	s := waitJob(t, job)
	want := "catalog/street/street_720p30_30fps_h264.mp4"
	if s.State != jobs.Done || s.Result.(*Saved).Path != want || f.read(t, want) != string(content) {
		t.Fatalf("the import: %+v", s)
	}
	// Imported again: the name is taken, and the import never asks.
	s = waitJob(t, mustImport(t, f, "street/720p30/a.mp4"))
	if s.State != jobs.Done || s.Result.(*Saved).Path != "catalog/street/street_720p30_30fps_h264_2.mp4" {
		t.Fatalf("the second import: %+v", s)
	}

	for asset, message := range map[string]string{
		"street/720p30/bad-sum.mp4": "SHA-256",
		"street/720p30/short.mp4":   "ended after",
	} {
		s := waitJob(t, mustImport(t, f, asset))
		if s.State != jobs.Failed || !strings.Contains(s.Error, message) || !strings.Contains(s.Error, "nothing was saved") {
			t.Errorf("%s: %+v", asset, s)
		}
	}
	if files := f.contents(t, "catalog/street"); len(files) != 2 {
		t.Fatalf("the failed imports left %v", files)
	}

	for asset, want := range map[string]string{"street/720p30/missing.mp4": CodeNotFound,
		"../../evil.mp4": CodeInvalidPath, "/abs.mp4": CodeInvalidPath, "": CodeInvalidPath} {
		if _, err := f.lib.ImportCatalog(t.Context(), asset); code(err) != want {
			t.Errorf("ImportCatalog(%q) = %v, want %s", asset, err, want)
		}
	}
	f.noStages(t)
}

func mustImport(t *testing.T, f *fixture, asset string) *jobs.Job {
	t.Helper()
	job, err := f.lib.ImportCatalog(t.Context(), asset)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func TestCancelledImportSavesNothing(t *testing.T) {
	f, c := catalogFixture(t)
	c.add("street/a.mp4", make([]byte, 1000000), make([]byte, 1000000), nil)
	c.hold = make(chan struct{})
	defer close(c.hold)

	job := mustImport(t, f, "street/a.mp4")
	events, unsubscribe, _ := f.jobs.Subscribe(job.ID())
	defer unsubscribe()
	for s := range events {
		if s.Progress.Detail == "0.0 / 1.0 MB" {
			break
		}
	}
	f.jobs.Cancel(job.ID())
	if s := waitJob(t, job); s.State != jobs.Cancelled {
		t.Fatalf("the job ended %s: %s", s.State, s.Error)
	}
	if files := f.contents(t, "catalog"); len(files) != 0 {
		t.Fatalf("a cancelled import left %v", files)
	}
	f.noStages(t)
}

func TestImportName(t *testing.T) {
	for want, asset := range map[string]catalogAsset{
		"street_720p30_30fps_h264.mp4":     {SourceID: "street", Profile: "720p30", FPS: 30.0, Codec: "h264", Container: "mp4"},
		"street_preview_29.97fps_hevc.mp4": {SourceID: "street", Profile: "preview", FPS: 29.97, Codec: "hevc", Path: "x/y.MP4"},
		"catalog_asset_video_video.mkv":    {Path: "x/y.mkv"},
		"passwd_video_video.mp4":           {SourceID: "../../etc/passwd"},
	} {
		if got := importName(asset); got != want {
			t.Errorf("importName(%+v) = %q, want %q", asset, got, want)
		}
	}
}
