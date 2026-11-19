package web

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"

	"insight/internal/channels"
	"insight/internal/config"
	"insight/internal/jobs"
	"insight/internal/library"
	"insight/internal/media"
	"insight/internal/mediamtx"
	"insight/internal/relay"
	"insight/internal/slots"
	"insight/internal/supervisor"
)

// The contract test sends requests to the real handlers, over real slots, library, jobs and
// relays with fakes only where a process or MediaMTX would run, and checks every request and
// answer against api/openapi.yaml: an answer's status must be documented, and its body must
// match its schema with no field the schema does not name. Every operation of the document
// must be answered at least once, so a route and its description cannot drift apart.

func init() {
	// The streams', files' and the document's own types, read as the binary strings the document
	// says they are.
	for _, contentType := range []string{"multipart/x-mixed-replace", "image/jpeg", "video/mp4", "audio/wav", "application/yaml"} {
		openapi3filter.RegisterBodyDecoder(contentType, openapi3filter.FileBodyDecoder)
	}
	openapi3filter.RegisterBodyDecoder("text/event-stream", openapi3filter.PlainBodyDecoder)
}

func TestTheAPIAnswersAsItsDocumentSays(t *testing.T) {
	c := newContract(t)

	// The service's own routes.
	c.ok(c.get("/api/health"))
	c.ok(c.get("/api/openapi.yaml"))

	// The Viewer's routes.
	c.ok(c.get("/api/channels"))
	c.ok(c.send(http.MethodPost, "/api/channels/0/offer", `{"type":"offer","sdp":"v=0"}`))
	c.ok(c.get("/api/ingest/stats?all=1&verbose=1"))
	c.ok(c.get("/api/viewer-url?src=0,1"))

	// The library, probed.
	c.write("clip.mp4", "video")
	c.write("sub/b.mp4", "video")
	c.write("still.jpg", "picture")
	c.write("notes.txt", "text")
	deadline := time.Now().Add(5 * time.Second)
	for !everyFileProbed(t, c.ok(c.get("/api/media"))) {
		if time.Now().After(deadline) {
			t.Fatal("the library's files were not probed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	c.ok(c.get("/api/media/info?path=clip.mp4"))
	c.refused(c.get("/api/media/info?path=../outside.mp4"), 400, "invalid_path")
	c.refused(c.get("/api/media/info?path=gone.mp4"), 404, "not_found")
	if body := c.ok(c.get("/api/media/file?path=still.jpg")); body != "picture" {
		t.Errorf("the file's content is %q", body)
	}
	c.ok(c.get("/api/media/file?path=notes.txt"))
	c.ok(c.stream("/api/media/preview.mjpg?path=clip.mp4"))

	// The slots: src1 carries an external H.264 stream, src2 an external MJPEG one.
	c.ok(c.send(http.MethodPut, "/api/slots/3", `{"kind":"file","file":"clip.mp4"}`))
	c.ok(c.send(http.MethodPut, "/api/slots/4", `{"kind":"webcam"}`))
	c.refused(c.send(http.MethodPut, "/api/slots/5", `{"kind":"pull","url":"rtsp://127.0.0.1:1/cam"}`), 502, "pull_unreachable")
	c.refused(c.send(http.MethodPut, "/api/slots/1", `{"kind":"file","file":"clip.mp4"}`), 409, "slot_busy")
	c.refused(c.send(http.MethodPut, "/api/slots/49", `{"kind":"webcam"}`), 404, "no_such_slot")
	c.refused(c.send(http.MethodPut, "/api/slots/3", `{"kind":"file","fsp":3}`), 400, "invalid_request")
	c.ok(c.send(http.MethodPost, "/api/slots/3/start", ""))
	c.ok(c.send(http.MethodPost, "/api/slots/3/stop", ""))
	c.refused(c.send(http.MethodPost, "/api/slots/6/start", ""), 409, "nothing_assigned")
	c.ok(c.send(http.MethodPost, "/api/slots/1/take-over", ""))
	c.refused(c.send(http.MethodPost, "/api/slots/4/take-over", ""), 409, "not_external")
	c.refused(c.send(http.MethodPost, "/api/slots/x/start", ""), 400, "invalid_request")
	list := c.ok(c.get("/api/slots"))
	if !strings.Contains(list, `"state":"external"`) || !strings.Contains(list, `"whip":"https://127.0.0.1:18889/cam4/whip"`) {
		t.Errorf("the slots: %s", list)
	}
	c.ok(c.stream("/api/slots/1/preview.mjpg"))
	c.refused(c.get("/api/slots/3/preview.mjpg"), 409, "slot_not_live")

	// The Frozen HTTP MJPEG output, which the document names but cannot describe.
	if w := c.raw(http.MethodGet, "/stream/http/src2.mjpg"); w.status != 200 || !strings.HasPrefix(w.header.Get("Content-Type"), "multipart/x-mixed-replace") {
		t.Errorf("/stream/http/src2.mjpg answered %d %s", w.status, w.header.Get("Content-Type"))
	}
	if w := c.raw(http.MethodGet, "/stream/http/src1.mjpg"); w.status != 409 {
		t.Errorf("/stream/http/src1.mjpg (H.264) answered %d", w.status)
	}
	for _, path := range []string{"/stream/http/src+1.mjpg", "/stream/http/src1.jpg", "/stream/http/1.mjpg"} {
		if w := c.raw(http.MethodGet, path); w.status != 404 {
			t.Errorf("%s answered %d", path, w.status)
		}
	}

	// What the library refuses while a slot uses a file.
	c.refused(c.send(http.MethodPost, "/api/media/delete", `{"paths":["clip.mp4"]}`), 409, "in_use")
	c.ok(c.send(http.MethodPost, "/api/media/delete", `{"paths":["sub/b.mp4"]}`))

	c.ok(c.send(http.MethodPost, "/api/slots/start", `{"count":2}`))
	c.refused(c.send(http.MethodPost, "/api/slots/start", `{"count":0}`), 400, "invalid_count")
	c.ok(c.send(http.MethodPost, "/api/slots/stop", ""))
	c.ok(c.send(http.MethodPost, "/api/slots/auto-assign", ""))
	c.ok(c.send(http.MethodDelete, "/api/slots/4", ""))
	c.ok(c.send(http.MethodPost, "/api/slots/reset", ""))
	c.ok(c.get("/api/renditions"))
	c.ok(c.send(http.MethodDelete, "/api/renditions", ""))

	// Uploads.
	c.ok(c.upload("new.mp4", ""))
	if body := c.refused(c.upload("new.mp4", "ask"), 409, "name_taken"); !strings.Contains(body, `"suggested":"new_2.mp4"`) {
		t.Errorf("the conflict: %s", body)
	}

	// The catalog, an import and its job.
	c.ok(c.get("/api/catalog"))
	var job jobs.Snapshot
	if err := json.Unmarshal([]byte(c.ok(c.send(http.MethodPost, "/api/catalog/imports", `{"path":"street/clip.mp4"}`))), &job); err != nil {
		t.Fatal(err)
	}
	c.refused(c.send(http.MethodPost, "/api/catalog/imports", `{"path":"street/none.mp4"}`), 404, "not_found")
	if events := c.ok(c.get("/api/jobs/" + job.ID + "/events")); !strings.Contains(events, `"state":"done"`) {
		t.Errorf("the import's events: %s", events)
	}
	c.refused(c.get("/api/jobs/nothing/events"), 404, "job_not_found")

	c.boardRoutes()

	c.allAnswered()
}

// everyFileProbed says whether every file of a /api/media answer has its probe.
func everyFileProbed(t *testing.T, tree string) bool {
	type entry struct {
		Folder   bool
		Probe    json.RawMessage
		Children []entry
	}
	var probed func(e entry) bool
	probed = func(e entry) bool {
		if !e.Folder {
			return string(e.Probe) != "null"
		}
		for _, child := range e.Children {
			if !probed(child) {
				return false
			}
		}
		return true
	}
	var root entry
	must(t, json.Unmarshal([]byte(tree), &root))
	return probed(root)
}

// contract is the server under test and the document it is held to.
type contract struct {
	t      *testing.T
	srv    *httptest.Server
	doc    *openapi3.T
	router routers.Router
	root   string

	mu       sync.Mutex
	answered map[string]bool // "GET /api/slots/{n}/preview.mjpg"
}

func newContract(t *testing.T) *contract {
	t.Helper()
	doc := loadDocument(t)
	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	c := &contract{t: t, doc: doc, router: router, root: filepath.Join(dir, "media"), answered: map[string]bool{}}
	must(t, os.MkdirAll(c.root, 0o755))

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	runner := jobs.New(map[jobs.Kind]int{slots.RenditionJob: 1, library.KindUpload: 1, library.KindCatalogImport: 2})
	t.Cleanup(func() { _ = runner.Shutdown(context.Background()) })
	relays, err := relay.New(relay.Options{MaxRelays: 4, StallTimeout: 5 * time.Second,
		Start: func(key, source string) (*exec.Cmd, error) { return exec.Command("sh", "-c", pictures), nil }})
	must(t, err)
	t.Cleanup(relays.Close)
	probes := media.NewCache(ctx, probeByExtension)

	manager, err := slots.New(slots.Options{
		StorePath:      filepath.Join(dir, "data", "sources.json"),
		MediaRoot:      c.root,
		Probes:         probes,
		MediaMTX:       newExternalStreams(),
		PublisherQuery: "publisher=insight-test",
		Start:          startNothing,
		Jobs:           runner,
		Relays:         relays,
		FFmpeg:         "/nonexistent/ffmpeg",
		URLs:           slots.URLOptions{WHIPPort: 18889},
	})
	must(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := manager.Close(ctx); err != nil {
			t.Errorf("closing the slots: %v", err)
		}
	})

	catalog := newCatalog(t)
	lib, err := library.New(library.Options{
		Root: c.root, Cache: probes, FFmpeg: "/nonexistent/ffmpeg", Start: startNothing, Probe: probeByExtension,
		Keyframes: func(context.Context, string) (time.Duration, error) { return time.Second, nil },
		Jobs:      runner, Relays: relays, Files: manager,
		CatalogIndexURL: catalog.URL + "/index.json", CatalogBaseURL: catalog.URL + "/assets/",
	})
	must(t, err)

	viewer := &fakeChannels{states: make([]channels.State, 2), answer: channels.Description{Type: "answer", SDP: "v=0"}}
	boards, devices, info, host := newBoards(t)
	c.srv = httptest.NewServer(NewHandler(Deps{
		Config: config.Config{
			Network:  config.Network{BrowserICEAddressSource: "none"},
			Channels: config.Channels{Count: 2, Source: "sdk-port-map", Limited: true},
		},
		Channels: viewer, Slots: manager, Library: lib, Jobs: runner, UI: marker("ui"), Now: time.Now,
		Boards: boards.Registry, Peripherals: devices, System: info, Host: host,
	}))
	t.Cleanup(c.srv.Close)
	return c
}

// loadDocument loads api/openapi.yaml with every object schema closed: a field the schema does
// not name fails, unless the schema says additionalProperties itself.
func loadDocument(t *testing.T) *openapi3.T {
	t.Helper()
	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[*openapi3.Schema]bool{}
	for _, schema := range doc.Components.Schemas {
		closeObjects(schema, seen)
	}
	return doc
}

func closeObjects(ref *openapi3.SchemaRef, seen map[*openapi3.Schema]bool) {
	if ref == nil || ref.Value == nil || seen[ref.Value] {
		return
	}
	s := ref.Value
	seen[s] = true
	if s.Type.Is("object") && s.AdditionalProperties.Has == nil && s.AdditionalProperties.Schema == nil {
		closed := false
		s.AdditionalProperties.Has = &closed
	}
	for _, property := range s.Properties {
		closeObjects(property, seen)
	}
	closeObjects(s.Items, seen)
	for _, list := range []openapi3.SchemaRefs{s.AllOf, s.OneOf, s.AnyOf} {
		for _, part := range list {
			closeObjects(part, seen)
		}
	}
}

// answer is what the server answered.
type answer struct {
	status int
	header http.Header
	body   []byte
}

func (c *contract) get(target string) answer { return c.send(http.MethodGet, target, "") }

// send sends body as JSON, or no body when it is "".
func (c *contract) send(method, target, body string) answer {
	contentType := ""
	if body != "" {
		contentType = "application/json"
	}
	return c.sendAs(method, target, contentType, body)
}

func (c *contract) sendAs(method, target, contentType, body string) answer {
	req, err := http.NewRequest(method, c.srv.URL+target, strings.NewReader(body))
	must(c.t, err)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return c.check(req, []byte(body), 0)
}

// stream reads the start of a stream that does not end by itself.
func (c *contract) stream(target string) answer {
	req, err := http.NewRequest(http.MethodGet, c.srv.URL+target, nil)
	must(c.t, err)
	return c.check(req, nil, 64)
}

func (c *contract) upload(name, onConflict string) answer {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	if onConflict != "" {
		must(c.t, form.WriteField("on_conflict", onConflict))
	}
	part, err := form.CreateFormFile("file", name)
	must(c.t, err)
	_, _ = part.Write([]byte("video"))
	must(c.t, form.Close())
	req, err := http.NewRequest(http.MethodPost, c.srv.URL+"/api/media/uploads", bytes.NewReader(body.Bytes()))
	must(c.t, err)
	req.Header.Set("Content-Type", form.FormDataContentType())
	return c.check(req, body.Bytes(), 0)
}

// raw sends a request to a path the document does not describe.
func (c *contract) raw(method, target string) answer {
	req, err := http.NewRequest(method, c.srv.URL+target, nil)
	must(c.t, err)
	return c.do(req, 64)
}

// do sends req and reads its answer: all of it, or its first limit bytes, after which the
// request is cancelled.
func (c *contract) do(req *http.Request, limit int) answer {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(ctx))
	must(c.t, err)
	defer resp.Body.Close()
	var body []byte
	if limit > 0 && resp.StatusCode == http.StatusOK {
		body = make([]byte, limit)
		_, err = io.ReadFull(resp.Body, body)
	} else {
		body, err = io.ReadAll(resp.Body)
	}
	must(c.t, err)
	return answer{status: resp.StatusCode, header: resp.Header, body: body}
}

// check sends req and holds the answer to the document. A request the test means to be valid
// (one answered 2xx) is held to it too.
func (c *contract) check(req *http.Request, body []byte, limit int) answer {
	c.t.Helper()
	got := c.do(req, limit)
	// The router and the validators read a request of their own, with the body sent.
	probe, err := http.NewRequest(req.Method, req.URL.String(), bytes.NewReader(body))
	must(c.t, err)
	probe.Header = req.Header.Clone()
	route, params, err := c.router.FindRoute(probe)
	if err != nil {
		c.t.Fatalf("%s %s is not in the document: %v", req.Method, req.URL.Path, err)
	}
	input := &openapi3filter.RequestValidationInput{Request: probe, PathParams: params, Route: route,
		Options: &openapi3filter.Options{IncludeResponseStatus: true}}
	if got.status < 300 {
		if err := openapi3filter.ValidateRequest(context.Background(), input); err != nil {
			c.t.Errorf("%s %s: the request does not match the document: %v", req.Method, req.URL.Path, err)
		}
	}
	response := &openapi3filter.ResponseValidationInput{RequestValidationInput: input, Status: got.status,
		Header: got.header, Options: input.Options}
	response.SetBodyBytes(got.body)
	if err := openapi3filter.ValidateResponse(context.Background(), response); err != nil {
		c.t.Errorf("%s %s answered %d, not as the document says: %v\n%s", req.Method, req.URL.Path, got.status, err, got.body)
	}
	c.mu.Lock()
	c.answered[route.Method+" "+route.Path] = true
	c.mu.Unlock()
	return got
}

// ok checks that the answer is a success and returns its body.
func (c *contract) ok(a answer) string {
	c.t.Helper()
	if a.status >= 300 {
		c.t.Errorf("answered %d: %s", a.status, a.body)
	}
	return string(a.body)
}

// refused checks the answer's status and error code and returns its body.
func (c *contract) refused(a answer, status int, code string) string {
	c.t.Helper()
	var body struct{ Error struct{ Code string } }
	_ = json.Unmarshal(a.body, &body)
	if a.status != status || body.Error.Code != code {
		c.t.Errorf("answered %d %q, want %d %q: %s", a.status, body.Error.Code, status, code, a.body)
	}
	return string(a.body)
}

func (c *contract) allAnswered() {
	c.t.Helper()
	var missing []string
	for path, item := range c.doc.Paths.Map() {
		for method := range item.Operations() {
			if !c.answered[method+" "+path] {
				missing = append(missing, method+" "+path)
			}
		}
	}
	slices.Sort(missing)
	if len(missing) > 0 {
		c.t.Errorf("the test sends nothing to %s", strings.Join(missing, ", "))
	}
}

func (c *contract) write(rel, content string) {
	abs := filepath.Join(c.root, filepath.FromSlash(rel))
	must(c.t, os.MkdirAll(filepath.Dir(abs), 0o755))
	must(c.t, os.WriteFile(abs, []byte(content), 0o644))
}

// pictures writes a picture every 20 ms in ffmpeg's mpjpeg format, as the relays' producers do.
const pictures = `while :; do
	printf '%s\r\nContent-type: image/jpeg\r\nContent-length: 4\r\n\r\n\377\330\377\331\r\n' --frame
	sleep 0.02
done`

// probeByExtension probes a .mp4 as H.264 and a .jpg as a picture.
func probeByExtension(_ context.Context, abs string) (media.Info, error) {
	info, err := os.Stat(abs)
	if err != nil {
		return media.Info{}, err
	}
	switch filepath.Ext(abs) {
	case ".mp4":
		return media.Info{Kind: media.KindVideo, Codec: media.CodecH264, CodecName: "H.264", Profile: "High",
			PixelFormat: "yuv420p", Width: 1280, Height: 720, FPS: 30, FrameRate: "30/1",
			Duration: 10 * time.Second, Size: info.Size()}, nil
	case ".jpg":
		return media.Info{Kind: media.KindImage, Codec: media.CodecMJPEG, CodecName: "MJPEG",
			Width: 640, Height: 480, Size: info.Size()}, nil
	}
	return media.Info{Kind: media.KindUnknown, Size: info.Size()}, nil
}

// externalStreams is a MediaMTX on which external publishers hold src1 (H.264) and src2 (MJPEG).
type externalStreams struct{ snapshot mediamtx.Snapshot }

func newExternalStreams() *externalStreams {
	since := time.Date(2026, 11, 18, 21, 0, 0, 0, time.UTC)
	paths := map[string]mediamtx.Path{}
	for n := 1; n <= slots.Count; n++ {
		name := "src" + strconv.Itoa(n)
		paths[name] = mediamtx.Path{Name: name}
	}
	for name, codec := range map[string]string{"src1": "h264", "src2": "mjpeg"} {
		paths[name] = mediamtx.Path{Name: name, Ready: true, ReadySince: since, Codec: codec,
			Source:  &mediamtx.Source{Type: "rtspSession", ID: "session-" + name, Protocol: "rtsp", Address: "10.0.0.9"},
			Readers: []mediamtx.Reader{{Type: "rtspSession", ID: "reader", Protocol: "rtsp", Address: "10.0.0.8"}}}
	}
	return &externalStreams{mediamtx.Snapshot{At: since, Paths: paths}}
}

func (e *externalStreams) Snapshot(context.Context) (mediamtx.Snapshot, error) {
	return e.snapshot, nil
}
func (e *externalStreams) Kick(context.Context, string, string) error          { return nil }
func (e *externalStreams) SetPullSource(context.Context, string, string) error { return nil }
func (e *externalStreams) ClearPullSource(context.Context, string) error       { return nil }

// startNothing stands in for the supervisor: the slots' publishers "run" until stopped.
func startNothing(supervisor.Spec) (supervisor.Child, error) {
	return &idleProcess{done: make(chan struct{})}, nil
}

type idleProcess struct {
	once sync.Once
	done chan struct{}
}

func (p *idleProcess) Status() supervisor.Status {
	select {
	case <-p.done:
		return supervisor.Status{LastExit: "signal: terminated"}
	default:
		return supervisor.Status{Running: true, PID: 1}
	}
}
func (p *idleProcess) Tail() []string        { return nil }
func (p *idleProcess) Done() <-chan struct{} { return p.done }
func (p *idleProcess) Stop(context.Context) error {
	p.once.Do(func() { close(p.done) })
	return nil
}

// newCatalog serves a catalog of one asset, street/clip.mp4.
func newCatalog(t *testing.T) *httptest.Server {
	content := []byte("catalog video")
	sum := sha256.Sum256(content)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.json":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"schema": "sima.neat.insight.media-assets.index.v1", "generated_at": "2026-11-18T00:00:00Z",
				"sources": []any{map[string]any{"id": "street", "title": "Street"}},
				"assets": []any{map[string]any{
					"path": "street/clip.mp4", "source_id": "street", "source_title": "Street", "profile": "720p30",
					"fps": 30, "codec": "h264", "container": "mp4", "bytes": len(content), "sha256": hex.EncodeToString(sum[:]),
				}},
			})
		case "/assets/street/clip.mp4":
			_, _ = w.Write(content)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
