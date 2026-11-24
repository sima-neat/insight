package peripherals

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"insight/internal/apierr"
	"insight/internal/board/boardtest"
)

// The catalog of a board with a MIPI camera, a USB camera and a USB microphone, as Sentinel
// writes one (tests/fixtures/sentinel-catalog-devkit-3.0.json, shortened).
const mipi = `{"id":"camera:imx477 5-001a","type":"camera","backend":"mipi","camera_name":"imx477 5-001a","model":"imx477",
	"max_fps":66.0,"modes":[
	{"format":"NV12","width":1920,"height":1080,"available":true},
	{"format":"NV12","width":4056,"height":3040,"available":false,"reason":"The ISP cannot output this size."},
	{"format":"AR24","width":1920,"height":1080,"available":false,"reason":"Neat's CameraInput outputs NV12 only."}]}`

const usb = `{"id":"camera:v4l2:421bbe426738013b","type":"camera","backend":"v4l2","model":"HD Pro Webcam C920",
	"device_path":"/dev/video1","by_id_path":"/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920-video-index0",
	"modes":[{"format":"MJPG","width":640,"height":480,"available":false,"reason":"USB cameras have no camera overlay on this board.",
	"frame_intervals":[{"width":640,"height":480,"intervals":[{"type":"discrete","numerator":1,"denominator":30},
	{"type":"discrete","numerator":1001,"denominator":30000}]}]},
	{"format":"YUYV","width":320,"height":240,"frame_intervals":[{"width":320,"height":240,"intervals":[
	{"type":"stepwise","minimum":{"numerator":1,"denominator":30},"maximum":{"numerator":1,"denominator":5},"step":{"numerator":1,"denominator":30}}]}]},
	{"format":"H264","width":640,"height":480}]}`

const mic = `{"id":"microphone:alsa:yeti","type":"microphone","backend":"alsa","connection":"usb","name":"Yeti Nano",
	"capture_target":{"device":0,"card_id":"Nano","selector":"plughw:CARD=Nano,DEV=0"},
	"modes":[{"format":"S24_3LE","channels":2,"rates_hz":[44100,48000,96000]}]}`

func catalogOf(devices ...string) string {
	return `{"schema":1,"revision":3,"observed_at":"2026-11-19T01:00:00Z","devices":[` + strings.Join(devices, ",") +
		`],"errors":[],"board":{"model":"SiMa.ai Modalix SoM 16Gig Board"}}`
}

// fakeSentinel answers the peripheral refresh with the catalog it holds.
type fakeSentinel struct {
	mu        sync.Mutex
	catalog   string
	refreshes int
}

func (s *fakeSentinel) set(catalog string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.catalog = catalog
}

func (s *fakeSentinel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Method != http.MethodPost || r.URL.Path != "/v1/peripherals/refresh" {
		http.NotFound(w, r)
		return
	}
	s.refreshes++
	_, _ = io.WriteString(w, s.catalog)
}

func (s *fakeSentinel) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refreshes
}

type fixture struct {
	*boardtest.Fixture
	sentinel *fakeSentinel
	manager  *Manager
	calls    string // what the fake programs were called with
}

func newFixture(t *testing.T, timing Timing) *fixture {
	s := &fakeSentinel{catalog: catalogOf(mipi, usb, mic)}
	f := &fixture{Fixture: boardtest.New(t, s), sentinel: s, manager: New(timing), calls: filepath.Join(t.TempDir(), "calls")}
	t.Cleanup(f.manager.Close)
	return f
}

// program puts a fake program on the board that records its arguments, one per line, then runs
// script.
func (f *fixture) program(t *testing.T, name, script string) {
	f.Program(t, name, `printf '%s\n' "$@" > '`+f.calls+`'`+"\n"+script)
}

func (f *fixture) called(t *testing.T) []string {
	t.Helper()
	content, err := os.ReadFile(f.calls)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(content), "\n"), "\n")
}

func (f *fixture) refresh(t *testing.T) Peripherals {
	t.Helper()
	answer, err := f.manager.Refresh(ctx(t), f.Board)
	if err != nil {
		t.Fatal(err)
	}
	return answer
}

func ctx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func codeOf(err error) string {
	var e *apierr.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func eventually(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestScans(t *testing.T) {
	f := newFixture(t, Timing{})
	if answer, err := f.manager.Peripherals(f.Board); err != nil || answer.Scan != nil {
		t.Fatalf("before a scan: %+v %v", answer, err)
	}
	first := f.refresh(t)
	if first.Scan == nil || first.Scan.Changes != nil || len(first.Scan.Items) != 3 || len(first.Scan.Issues) != 0 ||
		*first.Scan.CameraSetup.Model != "SiMa.ai Modalix SoM 16Gig Board" {
		t.Fatalf("the first scan: %+v", first.Scan)
	}
	if answer, _ := f.manager.Peripherals(f.Board); answer.Scan != first.Scan {
		t.Error("the last scan is not answered from memory")
	}

	f.sentinel.set(catalogOf(mipi, `{"id":"camera:new","type":"camera","backend":"v4l2","model":"New cam","modes":[]}`))
	second := f.refresh(t).Scan
	want := Changes{Added: []DeviceRef{{"camera:new", "New cam"}},
		Removed: []DeviceRef{{"camera:v4l2:421bbe426738013b", "HD Pro Webcam C920"}, {"microphone:alsa:yeti", "Yeti Nano"}}}
	if got, _ := json.Marshal(second.Changes); string(got) != string(must(json.Marshal(want))) {
		t.Errorf("changes %s", got)
	}

	for name, catalog := range map[string]string{
		"twice":   catalogOf(mipi, mipi),
		"no id":   catalogOf(`{"type":"camera"}`),
		"a shape": `{"schema":1,"devices":{}}`,
	} {
		f.sentinel.set(catalog)
		if _, err := f.manager.Refresh(ctx(t), f.Board); codeOf(err) != "sentinel_failed" {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func must(b []byte, err error) []byte {
	if err != nil {
		panic(err)
	}
	return b
}

func TestPreviewable(t *testing.T) {
	var scanned catalog
	if err := json.Unmarshal([]byte(catalogOf(mipi, usb)), &scanned); err != nil {
		t.Fatal(err)
	}
	camera, _ := scanned.device("camera:imx477 5-001a")
	webcam, _ := scanned.device("camera:v4l2:421bbe426738013b")

	s, err := previewable(camera, Mode{"NV12", 1920, 1080, 30})
	if err != nil || s.source != `"imx477 5-001a"` || s.rate != (rate{30, 1}) {
		t.Errorf("MIPI: %+v %v", s, err)
	}
	if s, err := previewable(webcam, Mode{"MJPG", 640, 480, 29.97}); err != nil || s.rate != (rate{30000, 1001}) ||
		s.source != `"/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920-video-index0"` {
		t.Errorf("USB at 29.97: %+v %v", s, err)
	}
	if s, err := previewable(webcam, Mode{"YUYV", 320, 240, 15}); err != nil || s.rate != (rate{15, 1}) {
		t.Errorf("a stepwise range: %+v %v", s, err)
	}
	for name, c := range map[string]struct {
		d device
		m Mode
	}{
		"Sentinel's verdict":     {camera, Mode{"NV12", 4056, 3040, 30}},
		"not NV12":               {camera, Mode{"AR24", 1920, 1080, 30}},
		"faster than it runs":    {camera, Mode{"NV12", 1920, 1080, 120}},
		"a size not listed":      {camera, Mode{"NV12", 1280, 720, 30}},
		"no rate":                {camera, Mode{"NV12", 1920, 1080, 0}},
		"a rate not advertised":  {webcam, Mode{"MJPG", 640, 480, 25}},
		"off the range's step":   {webcam, Mode{"YUYV", 320, 240, 7}},
		"outside the range":      {webcam, Mode{"YUYV", 320, 240, 60}},
		"a format not previewed": {webcam, Mode{"H264", 640, 480, 30}},
	} {
		if _, err := previewable(c.d, c.m); codeOf(err) != "invalid_request" {
			t.Errorf("%s: %v", name, err)
		}
	}
	noNode := webcam
	noNode.ByIDPath, noNode.DevicePath = "", "video1"
	if _, err := previewable(noNode, Mode{"MJPG", 640, 480, 30}); codeOf(err) != "no_device" {
		t.Errorf("no /dev node: %v", err)
	}
	hostile := camera
	hostile.CameraName = "cam\n! filesink location=/etc/passwd"
	if _, err := previewable(hostile, Mode{"NV12", 1920, 1080, 30}); codeOf(err) != "no_device" {
		t.Errorf("a control character: %v", err)
	}
}

func TestPipeline(t *testing.T) {
	got := pipeline(previewSource{connection: "mipi", source: `"imx477 5-001a"`, format: "NV12", width: 1920, height: 1080, rate: rate{60, 1}})
	want := []string{"gst-launch-1.0", "-q", "libcamerasrc", `camera-name="imx477 5-001a"`, "!",
		"video/x-raw,format=NV12,width=1920,height=1080,framerate=60/1", "!", "videoscale", "!", "videorate", "!",
		"video/x-raw,width=640,height=360,framerate=15/1", "!", "jpegenc", "quality=70", "!", "multipartmux", "boundary=frame",
		"!", "fdsink", "fd=1"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got  %q\nwant %q", got, want)
	}
	raw := pipeline(previewSource{connection: "usb", source: `"/dev/video1"`, format: "YUYV", width: 320, height: 240, rate: rate{5, 1}})
	if !strings.Contains(strings.Join(raw, " "), `v4l2src device="/dev/video1" ! video/x-raw,format=YUY2,width=320,height=240,framerate=5/1 ! videoconvert`) ||
		!strings.Contains(strings.Join(raw, " "), "width=320,height=240,framerate=5/1 ! jpegenc") {
		t.Errorf("raw: %q", raw)
	}
	if w, h := previewSize(4056, 3040); w != 640 || h != 480 {
		t.Errorf("size %dx%d", w, h)
	}
	if w, h := previewSize(320, 241); w != 320 || h != 242 {
		t.Errorf("small size %dx%d", w, h)
	}
	if quoted, ok := gstQuoted(`a "b" \c`); !ok || quoted != `"a \"b\" \\c"` {
		t.Errorf("quoted %s", quoted)
	}
	if framesWait(10*time.Second, rate{1, 10}) != 20*time.Second || framesWait(10*time.Second, rate{1, 3600}) != maxFrameWait {
		t.Error("frame waits")
	}
}

// pictures writes a picture every 20 ms as GStreamer's multipartmux does.
const pictures = `while :; do
	printf -- '--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\377\330\377\331\r\n' || exit
	sleep 0.02
done`

// usbNoByID is the USB camera without a by-id link, as the scan lists it; replaced is the camera
// a rescan finds at the same /dev/video1 after a replug.
const usbNoByID = `{"id":"camera:v4l2:cafe","type":"camera","backend":"v4l2","model":"HD Pro Webcam C920",
	"device_path":"/dev/video1","identity":{"vendor_id":"046d","product_id":"08e5","serial":"AAA","driver":"uvcvideo"},
	"modes":[{"format":"MJPG","width":640,"height":480,"available":true,
	"frame_intervals":[{"width":640,"height":480,"intervals":[{"type":"discrete","numerator":1,"denominator":30}]}]}]}`

func TestAUSBPreviewWithoutAByIDLinkConfirmsTheCameraWithARescan(t *testing.T) {
	f := newFixture(t, Timing{Unclaimed: time.Minute})
	f.program(t, "gst-launch-1.0", pictures)
	f.sentinel.set(catalogOf(usbNoByID))
	f.refresh(t)
	camera, mode := "camera:v4l2:cafe", Mode{"MJPG", 640, 480, 30}
	start := func() error {
		answer, err := f.manager.StartPreview(ctx(t), f.Board, camera, mode)
		if err == nil {
			f.manager.StopPreview(f.Board, camera, answer.Preview.ID)
		}
		return err
	}

	before := f.sentinel.count()
	if err := start(); err != nil {
		t.Fatalf("the same camera: %v", err)
	}
	if got := f.sentinel.count() - before; got != 1 {
		t.Errorf("a rescan before the start: %d", got)
	}
	replaced := strings.Replace(usbNoByID, `"serial":"AAA"`, `"serial":"BBB"`, 1)
	moved := strings.Replace(usbNoByID, `/dev/video1`, `/dev/video2`, 1)
	for name, catalog := range map[string]string{"replaced": catalogOf(replaced), "moved": catalogOf(moved), "gone": catalogOf()} {
		f.sentinel.set(catalog)
		f.Program(t, "gst-launch-1.0", `echo started > '`+f.calls+`'; `+pictures)
		os.Remove(f.calls)
		if err := start(); codeOf(err) != "stale_scan" {
			t.Errorf("%s: %v", name, err)
		}
		if _, err := os.Stat(f.calls); err == nil {
			t.Errorf("%s: the pipeline ran", name)
		}
	}
	failed := strings.Replace(catalogOf(usbNoByID), `"errors":[]`, `"errors":[{"provider":"camera.v4l2","code":"x","reason":"y"}]`, 1)
	f.sentinel.set(failed)
	if err := start(); codeOf(err) != "stale_scan" {
		t.Errorf("a failed provider: %v", err)
	}
}

func TestAUSBPreviewWithAByIDLinkIsNotRescanned(t *testing.T) {
	f := newFixture(t, Timing{Unclaimed: time.Minute})
	f.program(t, "gst-launch-1.0", pictures)
	f.refresh(t)
	before := f.sentinel.count()
	answer, err := f.manager.StartPreview(ctx(t), f.Board, "camera:v4l2:421bbe426738013b", Mode{"MJPG", 640, 480, 30})
	if err != nil {
		t.Fatal(err)
	}
	f.manager.StopPreview(f.Board, "camera:v4l2:421bbe426738013b", answer.Preview.ID)
	if got := f.sentinel.count() - before; got != 0 {
		t.Errorf("rescans: %d", got)
	}
}

func TestPreview(t *testing.T) {
	f := newFixture(t, Timing{Unclaimed: time.Minute})
	f.program(t, "gst-launch-1.0", pictures)
	if _, err := f.manager.StartPreview(ctx(t), f.Board, "camera:imx477 5-001a", Mode{"NV12", 1920, 1080, 30}); codeOf(err) != "no_scan" {
		t.Errorf("before a scan: %v", err)
	}
	f.refresh(t)
	started, err := f.manager.StartPreview(ctx(t), f.Board, "camera:v4l2:421bbe426738013b", Mode{"MJPG", 640, 480, 30})
	if err != nil {
		t.Fatal(err)
	}
	p := started.Preview
	if p == nil || p.Camera != "camera:v4l2:421bbe426738013b" || p.CameraFPS == nil || *p.CameraFPS != 30 || p.Viewer {
		t.Fatalf("started %+v", p)
	}
	if argv := strings.Join(f.called(t), " "); !strings.HasPrefix(argv, `-q v4l2src device="/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920-video-index0" ! image/jpeg,width=640,height=480,framerate=30/1 ! jpegdec`) {
		t.Errorf("the pipeline: %s", argv)
	}
	if _, err := f.manager.StartPreview(ctx(t), f.Board, "camera:imx477 5-001a", Mode{"NV12", 1920, 1080, 30}); codeOf(err) != "preview_active" {
		t.Errorf("a second preview: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.manager.ServePreview(w, r, f.Board, r.URL.Query().Get("camera"), r.URL.Query().Get("id"))
	}))
	defer srv.Close()
	if response := get(t, srv.URL+"?camera=camera:v4l2:421bbe426738013b&id=other"); response.StatusCode != 404 {
		t.Errorf("another id: %d", response.StatusCode)
	}
	viewer := get(t, srv.URL+"?camera=camera:v4l2:421bbe426738013b&id="+p.ID)
	if viewer.StatusCode != 200 || viewer.Header.Get("Content-Type") != "multipart/x-mixed-replace; boundary=frame" {
		t.Fatalf("the stream: %d %s", viewer.StatusCode, viewer.Header.Get("Content-Type"))
	}
	start := make([]byte, 120)
	if _, err := io.ReadFull(viewer.Body, start); err != nil || !bytes.Contains(start, []byte("\xff\xd8\xff\xd9")) {
		t.Fatalf("the stream's start %q %v", start, err)
	}
	if second := get(t, srv.URL+"?camera=camera:v4l2:421bbe426738013b"); second.StatusCode != 409 {
		t.Errorf("a second viewer: %d", second.StatusCode)
	}
	if state, _ := f.manager.Preview(f.Board); state.Preview == nil || !state.Preview.Viewer {
		t.Errorf("while watched: %+v", state.Preview)
	}
	// The preview stops with its viewer.
	viewer.Body.Close()
	eventually(t, "the preview's end", func() bool {
		state, _ := f.manager.Preview(f.Board)
		return state.Preview == nil
	})

	// Stopped, and a stop for another camera stops nothing.
	if _, err := f.manager.StartPreview(ctx(t), f.Board, "camera:v4l2:421bbe426738013b", Mode{"MJPG", 640, 480, 30}); err != nil {
		t.Fatal(err)
	}
	if state, _ := f.manager.StopPreview(f.Board, "camera:imx477 5-001a", ""); state.Preview == nil {
		t.Error("a stop of another camera stopped the preview")
	}
	if state, _ := f.manager.StopPreview(f.Board, "camera:v4l2:421bbe426738013b", ""); state.Preview != nil {
		t.Errorf("after the stop: %+v", state.Preview)
	}
}

func get(t *testing.T, url string) *http.Response {
	t.Helper()
	response, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func TestAnUnclaimedPreviewStops(t *testing.T) {
	f := newFixture(t, Timing{Unclaimed: 100 * time.Millisecond})
	f.program(t, "gst-launch-1.0", pictures)
	f.refresh(t)
	if _, err := f.manager.StartPreview(ctx(t), f.Board, "camera:imx477 5-001a", Mode{"NV12", 1920, 1080, 30}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the unclaimed preview's end", func() bool {
		state, _ := f.manager.Preview(f.Board)
		return state.Preview == nil
	})
}

func TestARefreshStopsThePreview(t *testing.T) {
	f := newFixture(t, Timing{})
	f.program(t, "gst-launch-1.0", pictures)
	f.refresh(t)
	if _, err := f.manager.StartPreview(ctx(t), f.Board, "camera:imx477 5-001a", Mode{"NV12", 1920, 1080, 30}); err != nil {
		t.Fatal(err)
	}
	f.refresh(t)
	if state, _ := f.manager.Preview(f.Board); state.Preview != nil {
		t.Errorf("the preview runs on through a scan: %+v", state.Preview)
	}
}

func TestPreviewFailures(t *testing.T) {
	cases := []struct {
		name, script, code string
	}{
		{"a busy camera", `echo "ERROR: Failed to acquire camera imx477" >&2; exit 1`, "camera_in_use"},
		{"another size", `echo "INFO configuring streams: (0) 1332x990-NV12" >&2; exit 1`, "mode_adjusted"},
		{"a missing element", `echo 'WARNING: erroneous pipeline: no element "libcamerasrc"' >&2; exit 1`, "tool_missing"},
		{"nothing said", `exit 1`, "command_failed"},
		{"no picture in time", `exec sleep 30`, "preview_timeout"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t, Timing{FirstFrame: 300 * time.Millisecond})
			f.program(t, "gst-launch-1.0", c.script)
			f.refresh(t)
			_, err := f.manager.StartPreview(ctx(t), f.Board, "camera:imx477 5-001a", Mode{"NV12", 1920, 1080, 30})
			if codeOf(err) != c.code {
				t.Errorf("got %v, want %s", err, c.code)
			}
			if state, _ := f.manager.Preview(f.Board); state.Preview != nil {
				t.Errorf("a failed start left %+v", state.Preview)
			}
		})
	}
}

// loud writes noise near full scale for the seconds arecord is asked for, at the rate and
// channels it is asked for, 50 ms at a time.
const loud = `rate=48000; channels=1; seconds=1
while [ $# -gt 0 ]; do case $1 in -r) rate=$2; shift;; -c) channels=$2; shift;; -d) seconds=$2; shift;; esac; shift; done
i=0; while [ $i -lt $((seconds * 20)) ]; do head -c $((rate * channels * 2 / 20)) /dev/urandom; i=$((i + 1)); sleep 0.01; done`

func TestMicTest(t *testing.T) {
	f := newFixture(t, Timing{})
	f.program(t, "arecord", loud)
	f.refresh(t)
	started, err := f.manager.StartMicTest(f.Board, "microphone:alsa:yeti", 1)
	if err != nil {
		t.Fatal(err)
	}
	if test := started.Test; test.State != "recording" || test.Format != (AudioFormat{48000, 2, 16, 1}) || test.Device != "plughw:CARD=Nano,DEV=0" {
		t.Fatalf("started %+v", test)
	}
	if _, err := f.manager.StartMicTest(f.Board, "microphone:alsa:yeti", 1); codeOf(err) != "test_running" {
		t.Errorf("a second test: %v", err)
	}
	var test *MicTest
	eventually(t, "the recording's end", func() bool {
		state, _ := f.manager.MicTest(f.Board)
		test = state.Test
		return test.State != "recording"
	})
	if test.State != "ready" || test.Level == nil || test.Level.Silent || test.Level.PeakDBFS == nil || *test.Level.PeakDBFS < -1 || test.ElapsedMs != 1000 {
		t.Fatalf("finished %+v %+v", test, test.Level)
	}
	if argv := strings.Join(f.called(t), " "); argv != "-q -D plughw:CARD=Nano,DEV=0 -f S16_LE -r 48000 -c 2 -d 1 -F 50000 -t raw -" {
		t.Errorf("arecord got %s", argv)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.manager.ServeMicTestWAV(w, r, f.Board, "microphone:alsa:yeti", r.URL.Query().Get("test"))
	}))
	defer srv.Close()
	audio := get(t, srv.URL+"?test="+test.ID)
	body, _ := io.ReadAll(audio.Body)
	if audio.StatusCode != 200 || len(body) != 44+48000*2*2 || string(body[:4]) != "RIFF" || string(body[8:12]) != "WAVE" ||
		binary.LittleEndian.Uint32(body[24:]) != 48000 {
		t.Errorf("the WAV: %d, %d bytes", audio.StatusCode, len(body))
	}
	request, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	request.Header.Set("Range", "bytes=0-3")
	if ranged, err := http.DefaultClient.Do(request); err != nil || ranged.StatusCode != http.StatusPartialContent {
		t.Errorf("a range: %v %v", ranged, err)
	} else {
		ranged.Body.Close()
	}
	if other := get(t, srv.URL+"?test=other"); other.StatusCode != 404 {
		t.Errorf("another test's WAV: %d", other.StatusCode)
	}
}

func TestMicTestStoppedAndFailing(t *testing.T) {
	f := newFixture(t, Timing{})
	f.refresh(t)

	// Stopped before anything arrived.
	f.program(t, "arecord", "exec sleep 30")
	if _, err := f.manager.StartMicTest(f.Board, "microphone:alsa:yeti", 0); err != nil {
		t.Fatal(err)
	}
	stopped, err := f.manager.StopMicTest(f.Board, "microphone:alsa:yeti", "")
	if err != nil || stopped.Test.State != "failed" || stopped.Test.Error.Code != "stopped_early" {
		t.Errorf("stopped early: %+v %v", stopped.Test, err)
	}

	for name, c := range map[string]struct{ script, state, code string }{
		"busy":    {`echo "arecord: main:850: audio open error: Device or resource busy" >&2; exit 1`, "failed", "microphone_in_use"},
		"failing": {`echo "arecord: something else" >&2; exit 1`, "failed", "command_failed"},
		"silent":  {`head -c 9600 /dev/zero`, "ready", ""},
	} {
		t.Run(name, func(t *testing.T) {
			f.program(t, "arecord", c.script)
			if _, err := f.manager.StartMicTest(f.Board, "microphone:alsa:yeti", 1); err != nil {
				t.Fatal(err)
			}
			var test *MicTest
			eventually(t, "the recording's end", func() bool {
				state, _ := f.manager.MicTest(f.Board)
				test = state.Test
				return test.State != "recording"
			})
			if test.State != c.state || (c.code != "" && test.Error.Code != c.code) || (c.state == "ready" && !test.Level.Silent) {
				t.Errorf("finished %+v", test)
			}
		})
	}

	for name, seconds := range map[string]int{"too long": MaxSeconds + 1, "negative": -1} {
		if _, err := f.manager.StartMicTest(f.Board, "microphone:alsa:yeti", seconds); codeOf(err) != "invalid_request" {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := f.manager.StartMicTest(f.Board, "camera:imx477 5-001a", 1); codeOf(err) != "not_found" {
		t.Errorf("a camera: %v", err)
	}
}

func TestSelectorsAndFormats(t *testing.T) {
	for selector, safe := range map[string]bool{
		"plughw:CARD=Nano,DEV=0": true, "plughw:CARD=USB-Audio_2,DEV=12": true,
		"plughw:CARD=1,DEV=0": false, "plughw:CARD=12,DEV=0": false, "plughw:CARD=123,DEV=0": true,
		"hw:CARD=Nano,DEV=0": false, "plughw:CARD=Nano,DEV=01": false, "plughw:CARD=Na no,DEV=0": false, "": false,
	} {
		if safeSelector(selector) != safe {
			t.Errorf("%q safe: %v", selector, !safe)
		}
	}
	if rate, channels := chooseFormat([]mode{{Channels: 2, RatesHz: []int{44100, 48000, 96000}}}); rate != 48000 || channels != 2 {
		t.Errorf("%d %d", rate, channels)
	}
	if rate, channels := chooseFormat([]mode{{Channels: 6, RatesHz: []int{96000, 32000}}}); rate != 32000 || channels != 2 {
		t.Errorf("%d %d", rate, channels)
	}
	if rate, _ := chooseFormat([]mode{{RateRangeHz: &struct {
		Min int `json:"min"`
		Max int `json:"max"`
	}{8000, 192000}}}); rate != 48000 {
		t.Errorf("a range: %d", rate)
	}
	if rate, channels := chooseFormat(nil); rate != 48000 || channels != 1 {
		t.Errorf("nothing known: %d %d", rate, channels)
	}
}

func TestMeasure(t *testing.T) {
	samples := func(values ...int16) []byte {
		out := make([]byte, 2*len(values))
		for i, v := range values {
			binary.LittleEndian.PutUint16(out[2*i:], uint16(v))
		}
		return out
	}
	if level := measure(samples(0, 0, 0, 0), 1); level.PeakDBFS != nil || level.RMSDBFS != nil || !level.Silent {
		t.Errorf("silence %+v", level)
	}
	full := measure(samples(-32768, 32767, -32768, 32767), 2)
	if full.PeakDBFS == nil || *full.PeakDBFS != 0 || full.Silent {
		t.Errorf("full scale %+v", full)
	}
	// One click in a quiet recording leaves it silent.
	quiet := make([]int16, 9600)
	quiet[100] = 30000
	if level := measure(samples(quiet...), 1); !level.Silent || *level.PeakDBFS > -0.7 {
		t.Errorf("a click %+v", level)
	}
}
