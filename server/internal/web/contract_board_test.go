package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"insight/internal/board/boardtest"
	"insight/internal/config"
	"insight/internal/peripherals"
	"insight/internal/system"
)

// The board routes are held to the document over the board Insight runs on (local mode): its
// Sentinel is fakeSentinel's answers, and gst-launch-1.0, arecord, simaai-sentinel and
// systemctl are scripts that stand in for the board's.

const (
	contractRun    = "20260924T175231.958Z-baseline"
	contractCamera = "camera:imx477 5-001a"
	contractMic    = "microphone:alsa:yeti"
)

// sentinelAnswers are Sentinel's answers by route, as its public clients see them.
var sentinelAnswers = map[string]string{
	"GET /v1/health": `{"schema":1,"version":"main:80ab7de4da31","cached_samples":2,"metric_count":1,"errors":[],` +
		`"latest_sample_at":"2026-09-22T20:55:43Z","updated_at":"2026-09-22T20:55:43Z","active_trace":null}`,
	"GET /v1/metrics": `{"schema":1,"metrics":[{"key":"cpu_usage_pct","label":"CPU usage","short":"CPU%","unit":"%",` +
		`"group":"CPU","description":"CPU use.","warn":80.0,"critical":95.0}]}`,
	"GET /v1/samples/latest": `{"schema":1,"version":"v","updated_at":"2026-09-22T20:55:43Z",` +
		`"sample":{"timestamp":"2026-09-22T20:55:43Z","values":{"cpu_usage_pct":12.5}}}`,
	"GET /v1/cache": `{"schema":1,"version":"v","metrics":[],"latest":null,"errors":[],"samples":[` +
		`{"timestamp":"2026-09-22T20:55:41Z","values":{"cpu_usage_pct":10}},{"timestamp":"2026-09-22T20:55:43Z","values":{"cpu_usage_pct":12.5}}]}`,
	"GET /v1/traces/active":                `{"schema":1,"trace":null,"summary":null}`,
	"POST /v1/traces":                      `{"schema":1,"trace":{"id":"t1","name":"bench"}}`,
	"POST /v1/traces/t1/stop":              `{"schema":1,"trace":{"id":"t1"},"summary":{"id":"t1"}}`,
	"GET /v1/runs/" + contractRun:          `{"schema":1,"metadata":{"id":"` + contractRun + `"},"metrics":[],"samples":[]}`,
	"GET /v1/compare?runs=a,b&raw=1":       `{"schema":1,"baseline_id":"a","runs":[],"summaries":{},"baseline_deltas_pct":{}}`,
	"POST /v1/peripherals/refresh":         contractCatalog,
	"GET /v1/runs?the-cli-deleted-the-run": `{"schema":1,"runs":[]}`,
	"GET /v1/runs":                         `{"schema":1,"runs":[{"id":"` + contractRun + `","name":"baseline","ended_at":"2026-09-24T17:52:40Z"}]}`,
}

const contractCatalog = `{"schema":1,"revision":1,"observed_at":"2026-11-19T01:00:00Z","errors":[],"board":{"model":"Modalix"},"devices":[
	{"id":"camera:imx477 5-001a","type":"camera","backend":"mipi","camera_name":"imx477 5-001a","max_fps":30,
	 "modes":[{"format":"NV12","width":1920,"height":1080,"available":true}]},
	{"id":"microphone:alsa:yeti","type":"microphone","backend":"alsa","name":"Yeti Nano",
	 "capture_target":{"selector":"plughw:CARD=Nano,DEV=0"},"modes":[{"format":"S16_LE","channels":1,"rates_hz":[16000]}]}]}`

// newBoards makes the board side of the contract: the local board, its Sentinel and programs,
// the Peripherals manager and System Info.
func newBoards(t *testing.T) (*boardtest.Fixture, *peripherals.Manager, *system.Reader, *system.HostReader) {
	t.Helper()
	deleted := filepath.Join(t.TempDir(), "deleted")
	f := boardtest.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := r.Method + " " + r.URL.RequestURI()
		if _, err := os.Stat(deleted); err == nil && route == "GET /v1/runs" {
			route += "?the-cli-deleted-the-run"
		}
		body, ok := sentinelAnswers[route]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			body = `{"error":"unknown run"}`
		}
		_, _ = io.WriteString(w, body)
	}))
	f.Program(t, "gst-launch-1.0", pictures)
	f.Program(t, "arecord", `head -c 32000 /dev/urandom`)
	f.Program(t, "simaai-sentinel", `[ "$1 $2 $3" = "runs delete `+contractRun+`" ] && touch '`+deleted+`'`)
	f.Program(t, "systemctl", `printf 'LoadState=loaded\nActiveState=active\nActiveEnterTimestampMonotonic=1000000\n'`)

	manager := peripherals.New(peripherals.Timing{})
	t.Cleanup(manager.Close)
	reader := system.New(system.Options{Version: "test", Config: config.Config{Place: config.Host, Port: 9900},
		RunNeat: func(context.Context) ([]byte, error) {
			return []byte(`{"schema":"sima.neat.status.v1","environment":{"mode":"elxr-sdk","label":"SDK"},` +
				`"components":{"core":{"name":"Neat core","version":"0.9.1"}},"updateCheck":{"offline":true,"status":"Offline"},` +
				`"insight":{"serviceState":"Running","venv":null,"webUiUrl":null},"codeUI":{"password":"secret"},"exposedPorts":[]}`), nil
		}})
	return f, manager, reader, system.NewHostReader("/proc", t.TempDir())
}

// boardRoutes sends a request to every board, Peripherals, Sentinel and System route.
func (c *contract) boardRoutes() {
	t := c.t
	// The boards: the local one, an entered one that does not answer, then the local one again.
	if list := c.ok(c.get("/api/boards")); !strings.Contains(list, `"id":"local"`) {
		t.Errorf("the boards: %s", list)
	}
	c.ok(c.send(http.MethodPost, "/api/boards/local/check", ""))
	if list := c.ok(c.get("/api/boards")); !strings.Contains(list, `"state":"connected"`) {
		t.Errorf("after the check: %s", list)
	}
	c.refused(c.send(http.MethodPost, "/api/boards/local/trust-host-key", `{"fingerprint":"SHA256:x"}`), 400, "invalid_request")
	c.refused(c.send(http.MethodPost, "/api/boards", `{"host":"not a host"}`), 400, "invalid_request")
	entered := c.ok(c.send(http.MethodPost, "/api/boards", `{"host":"127.0.0.1","port":1}`))
	if !strings.Contains(entered, `"ssh":"ssh -p 1 sima@127.0.0.1"`) {
		t.Errorf("the entered board: %s", entered)
	}
	c.refused(c.send(http.MethodPost, "/api/boards/local/check", ""), 404, "not_found")
	// The fixture's account has no SSH key: the refusal says how to make and authorize one.
	if refused := c.refused(c.send(http.MethodPost, "/api/boards/"+url.PathEscape("ssh:sima@127.0.0.1:1")+"/check", ""), 502, "auth_failed"); !strings.Contains(refused, `"command":"ssh-keygen`) {
		t.Errorf("the refusal: %s", refused)
	}
	if list := c.ok(c.get("/api/boards")); !strings.Contains(list, `"state":"error"`) || !strings.Contains(list, `"command":"ssh-keygen`) {
		t.Errorf("the failed board's status: %s", list)
	}
	c.refused(c.send(http.MethodDelete, "/api/boards/local", ""), 409, "not_entered")
	c.refused(c.send(http.MethodDelete, "/api/boards/nothing", ""), 404, "not_found")
	c.ok(c.send(http.MethodDelete, "/api/boards/"+url.PathEscape("ssh:sima@127.0.0.1:1"), ""))

	// Sentinel.
	const s = "/api/boards/local/sentinel"
	if health := c.ok(c.get(s + "/health")); !strings.Contains(health, `"started_at":"`) || strings.Contains(health, `"schema"`) {
		t.Errorf("the health: %s", health)
	}
	c.ok(c.get(s + "/metrics"))
	c.ok(c.get(s + "/samples/latest"))
	if cache := c.ok(c.get(s + "/cache?after=2026-09-22T20:55:41Z")); !strings.Contains(cache, `"full":false`) {
		t.Errorf("the cache: %s", cache)
	}
	c.ok(c.get(s + "/traces/active"))
	c.ok(c.send(http.MethodPost, s+"/traces", `{"name":"bench","tags":["v2"]}`))
	c.refused(c.send(http.MethodPost, s+"/traces", `{"name":"a,b"}`), 400, "invalid_request")
	c.ok(c.send(http.MethodPost, s+"/traces/stop?trace=t1", ""))
	c.ok(c.get(s + "/runs"))
	c.ok(c.get(s + "/runs/" + contractRun))
	c.refused(c.get(s+"/runs/nope"), 404, "not_found")
	c.ok(c.get(s + "/compare?runs=a,b&raw=true"))
	c.refused(c.get(s+"/compare?runs=a"), 400, "invalid_request")
	c.refused(c.send(http.MethodDelete, s+"/runs/"+url.PathEscape("$(reboot)"), ""), 400, "invalid_request")
	if deleted := c.ok(c.send(http.MethodDelete, s+"/runs/"+contractRun, "")); !strings.Contains(deleted, `"runs":{"runs":[]}`) {
		t.Errorf("the delete: %s", deleted)
	}
	c.refused(c.get("/api/boards/other/sentinel/health"), 404, "not_found")

	// Peripherals.
	const b = "/api/boards/local"
	camera, mic := b+"/cameras/"+url.PathEscape(contractCamera), b+"/microphones/"+url.PathEscape(contractMic)
	if scan := c.ok(c.get(b + "/peripherals")); scan != "{\"scan\":null}\n" {
		t.Errorf("before a scan: %s", scan)
	}
	c.refused(c.send(http.MethodPost, camera+"/preview", `{"format":"NV12","width":1920,"height":1080,"fps":30}`), 409, "no_scan")
	c.ok(c.send(http.MethodPost, b+"/peripherals/refresh", ""))
	c.ok(c.get(b + "/cameras/preview"))
	c.refused(c.send(http.MethodPost, camera+"/preview", `{"format":"NV12","width":640,"height":480,"fps":30}`), 400, "invalid_request")
	var started peripherals.PreviewAnswer
	if err := json.Unmarshal([]byte(c.ok(c.send(http.MethodPost, camera+"/preview", `{"format":"NV12","width":1920,"height":1080,"fps":30}`))), &started); err != nil || started.Preview == nil {
		t.Fatalf("the preview: %+v %v", started, err)
	}
	c.ok(c.stream(camera + "/preview.mjpg?preview=" + started.Preview.ID))
	// The preview ends with its viewer.
	deadline := time.Now().Add(5 * time.Second)
	for c.ok(c.get(b+"/cameras/preview")) != "{\"preview\":null}\n" {
		if time.Now().After(deadline) {
			t.Fatal("the preview did not end with its viewer")
		}
		time.Sleep(20 * time.Millisecond)
	}
	c.refused(c.get(camera+"/preview.mjpg"), 404, "not_found")
	c.ok(c.send(http.MethodPost, camera+"/preview/stop?preview="+started.Preview.ID, ""))

	c.ok(c.get(b + "/microphones/test"))
	c.refused(c.send(http.MethodPost, mic+"/test", `{"seconds":31}`), 400, "invalid_request")
	var test peripherals.MicTestAnswer
	if err := json.Unmarshal([]byte(c.ok(c.send(http.MethodPost, mic+"/test", ""))), &test); err != nil || test.Test == nil {
		t.Fatalf("the test: %+v %v", test, err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for !strings.Contains(c.ok(c.get(b+"/microphones/test")), `"state":"ready"`) {
		if time.Now().After(deadline) {
			t.Fatal("the test did not finish")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if audio := c.get(mic + "/test.wav?test=" + test.Test.ID); audio.status != 200 || audio.header.Get("Content-Type") != "audio/wav" || len(audio.body) != 44+32000 {
		t.Errorf("the WAV: %d %s, %d bytes", audio.status, audio.header.Get("Content-Type"), len(audio.body))
	}
	c.refused(c.get(mic+"/test.wav?test=other"), 404, "not_found")
	c.ok(c.send(http.MethodPost, mic+"/test/stop?test="+test.Test.ID, ""))

	// System Info.
	if info := c.ok(c.get("/api/system?refresh=true")); !strings.Contains(info, `"state":"ready"`) || strings.Contains(info, "secret") {
		t.Errorf("System Info: %s", info)
	}
	c.ok(c.get("/api/system/host"))
}
