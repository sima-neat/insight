package mediamtx

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// The shapes below are MediaMTX 1.12.1's API v3 answers, as the old backend's tests captured
// them (tests/test_mediamtx_client.py); testPublisher's query is that of a stream Insight
// started.
const testPublisher = "publisher=insight-0123456789abcdef"

var testPaths = []map[string]any{
	{"name": "src1", "confName": "src1", "source": map[string]any{"type": "rtspSession", "id": "pub-1"}, "ready": true,
		"readyTime": "2026-09-16T13:09:59.424615217Z", "tracks": []string{"H264"}, "bytesReceived": 1_000_000, "bytesSent": 0,
		"readers": []map[string]any{{"type": "rtspSession", "id": "read-1"}, {"type": "rtspSession", "id": "probe-1"}, {"type": "rtspSession", "id": "prev-1"}}},
	{"name": "src2", "confName": "src2", "source": map[string]any{"type": "rtspSession", "id": "pub-2"}, "ready": true,
		"readyTime": "2026-09-16T13:10:00.000000000Z", "tracks": []string{"H264"}, "bytesReceived": 468_305, "bytesSent": 0, "readers": []any{}},
	{"name": "src3", "confName": "src3", "source": map[string]any{"type": "srtConn", "id": "pub-3"}, "ready": true,
		"readyTime": "2026-09-16T13:11:00.000000000Z", "tracks": []string{"H264"}, "bytesReceived": 5_000, "bytesSent": 0, "readers": []any{}},
	{"name": "src4", "confName": "src4", "source": map[string]any{"type": "webRTCSession", "id": "pub-4"}, "ready": true,
		"readyTime": "2026-09-16T13:12:00.000000000Z", "tracks": []string{"VP8", "Opus"}, "bytesReceived": 5_000, "bytesSent": 0, "readers": []any{}},
	{"name": "src5", "confName": "src5", "source": nil, "ready": false, "readyTime": nil, "tracks": []any{}, "bytesReceived": 0, "bytesSent": 0, "readers": []any{}},
	{"name": "src6", "confName": "src6", "source": map[string]any{"type": "rtspSession", "id": "pub-6"}, "ready": true,
		"readyTime": "2026-09-16T13:13:00.000000000Z", "tracks": []string{"Opus"}, "bytesReceived": 100, "bytesSent": 0, "readers": []any{}},
	{"name": "src7", "confName": "src7", "source": map[string]any{"type": "rtspSource", "id": ""}, "ready": true,
		"readyTime": "2026-09-24T15:16:24.085Z", "tracks": []string{"H265"}, "bytesReceived": 209_429, "bytesSent": 0, "readers": []any{}},
	{"name": "src8", "confName": "src8", "source": map[string]any{"type": "rtspSource", "id": ""}, "ready": false,
		"readyTime": nil, "tracks": []any{}, "bytesReceived": 0, "bytesSent": 0, "readers": []any{}},
}

var testSessions = map[string][]map[string]any{
	"rtspsessions": {
		{"id": "pub-1", "remoteAddr": "127.0.0.1:40968", "state": "publish", "path": "src1", "query": testPublisher, "transport": "TCP"},
		{"id": "read-1", "remoteAddr": "172.19.0.1:49878", "state": "read", "path": "src1", "query": "", "transport": "TCP"},
		{"id": "probe-1", "remoteAddr": "127.0.0.1:50001", "state": "read", "path": "src1", "query": "reader=insight-probe", "transport": "TCP"},
		{"id": "prev-1", "remoteAddr": "127.0.0.1:50002", "state": "read", "path": "src1", "query": "reader=insight-preview", "transport": "TCP"},
		{"id": "pub-2", "remoteAddr": "172.19.0.1:47168", "state": "publish", "path": "src2", "query": "", "transport": "TCP"},
		{"id": "pub-6", "remoteAddr": "172.19.0.1:47170", "state": "publish", "path": "src6", "query": "", "transport": "TCP"},
	},
	"rtspssessions":  {},
	"webrtcsessions": {{"id": "pub-4", "remoteAddr": "172.19.0.5:51000", "state": "publish", "path": "src4", "query": ""}},
	"srtconns":       {{"id": "pub-3", "remoteAddr": "10.0.0.5:59399", "state": "publish", "path": "src3", "query": ""}},
	"rtmpconns":      {},
	"rtmpsconns":     {},
}

// request is one request the fake MediaMTX received.
type request struct {
	Method, Path, Query, ContentType string
	Body                             map[string]any
}

// fakeMediaMTX answers like MediaMTX's API: lists in pages, kicks and path patches, behind
// basic auth. Its fields may be changed between calls under mu.
type fakeMediaMTX struct {
	t        *testing.T
	password string

	mu       sync.Mutex
	paths    []map[string]any
	sessions map[string][]map[string]any
	// status answers an endpoint ("paths/list", "srtconns/kick/pub-3") with this status and
	// body instead.
	status   map[string]int
	body     map[string]string
	requests []request
}

func newFake(t *testing.T) (*fakeMediaMTX, *Client) {
	fake := &fakeMediaMTX{t: t, password: testSecrets.APIPassword, paths: testPaths, sessions: testSessions,
		status: map[string]int{}, body: map[string]string{}}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	return fake, NewClient(server.URL, testSecrets)
}

func (f *fakeMediaMTX) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	user, password, ok := r.BasicAuth()
	if !ok || user != APIUser || password != f.password {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	endpoint, found := strings.CutPrefix(r.URL.Path, "/v3/")
	if !found {
		http.NotFound(w, r)
		return
	}
	got := request{Method: r.Method, Path: endpoint, Query: r.URL.RawQuery, ContentType: r.Header.Get("Content-Type")}
	if content, _ := io.ReadAll(r.Body); len(content) > 0 {
		if err := json.Unmarshal(content, &got.Body); err != nil {
			f.t.Errorf("%s %s: body %q is not JSON", r.Method, endpoint, content)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, got)
	if status, ok := f.status[endpoint]; ok {
		w.WriteHeader(status)
		io.WriteString(w, f.body[endpoint])
		return
	}
	switch {
	case r.Method == http.MethodGet && endpoint == "paths/list":
		f.writeList(w, r, f.paths)
	case r.Method == http.MethodGet && strings.HasSuffix(endpoint, "/list"):
		list, ok := f.sessions[strings.TrimSuffix(endpoint, "/list")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		f.writeList(w, r, list)
	case r.Method == http.MethodPost && strings.Contains(endpoint, "/kick/"),
		r.Method == http.MethodPatch && strings.HasPrefix(endpoint, "config/paths/patch/"):
		w.WriteHeader(http.StatusOK)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeMediaMTX) writeList(w http.ResponseWriter, r *http.Request, items []map[string]any) {
	perPage, err := strconv.Atoi(r.URL.Query().Get("itemsPerPage"))
	if err != nil || perPage < 1 {
		perPage = 100 // MediaMTX's default
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageCount := (len(items) + perPage - 1) / perPage
	start, end := min(page*perPage, len(items)), min((page+1)*perPage, len(items))
	if items == nil {
		items = []map[string]any{}
	}
	json.NewEncoder(w).Encode(map[string]any{"pageCount": pageCount, "itemCount": len(items), "items": items[start:end]})
}

func (f *fakeMediaMTX) set(change func(f *fakeMediaMTX)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

func (f *fakeMediaMTX) received() []request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]request(nil), f.requests...)
}

// withPath returns a copy of paths with the one named name changed.
func withPath(paths []map[string]any, name string, change map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(paths)+1)
	found := false
	for _, path := range paths {
		if path["name"] == name {
			copied := map[string]any{}
			for k, v := range path {
				copied[k] = v
			}
			for k, v := range change {
				copied[k] = v
			}
			path, found = copied, true
		}
		out = append(out, path)
	}
	if !found {
		panic(fmt.Sprintf("no path %s", name))
	}
	return out
}
