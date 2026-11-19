package slots

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/mediamtx"
	"insight/internal/relay"
	"insight/internal/supervisor"
)

// These tests run the real MediaMTX when NEAT_INSIGHT_MEDIAMTX names its program, with ffmpeg
// and ffprobe from the PATH, on free loopback ports in a temporary folder: the slots publish
// generated clips, encode a rendition, pull cameras (MediaMTX's own paths, one of them behind a
// password) and relay MJPEG, and what they publish is read back with ffprobe.

type live struct {
	m       *Manager
	root    string
	rtsp    string // rtsp://127.0.0.1:<port>
	ffmpeg  string
	ffprobe string
	sup     *supervisor.Supervisor
}

func startLive(t *testing.T) *live {
	t.Helper()
	binary := os.Getenv("NEAT_INSIGHT_MEDIAMTX")
	if binary == "" {
		t.Skip("NEAT_INSIGHT_MEDIAMTX does not name a MediaMTX program")
	}
	ffmpeg, err1 := exec.LookPath("ffmpeg")
	ffprobe, err2 := exec.LookPath("ffprobe")
	if err1 != nil || err2 != nil {
		t.Skip("no ffmpeg and ffprobe")
	}
	dir := t.TempDir()
	rtspPort, apiPort := freePort(t), freePort(t)
	shipped, err := os.ReadFile(filepath.Join("..", "..", "..", "webrtc", "mediamtx.yml"))
	must(t, err)
	config := string(shipped)
	for _, swap := range [][2]string{
		{"rtspAddress: :8554", fmt.Sprintf("rtspAddress: :%d", rtspPort)},
		{"apiAddress: 127.0.0.1:9901", fmt.Sprintf("apiAddress: 127.0.0.1:%d", apiPort)},
		{"rtsp://127.0.0.1:8554/", fmt.Sprintf("rtsp://127.0.0.1:%d/", rtspPort)},
		{"api: yes", "api: yes\nrtspTransports: [tcp]\nsrt: no"},
		{"webrtc: yes", "webrtc: no"},
		// A camera behind a password: anyone reads the slots, only camuser reads "secure".
		{"      - action: read\n      - action: playback\n",
			"      - action: read\n        path: \"~^(src|cam)\"\n      - action: playback\n" +
				"  - user: camuser\n    pass: campw\n    permissions:\n      - action: read\n        path: secure\n"},
		{"  src1: {}\n", "  src1: {}\n  secure: {}\n"},
	} {
		if !strings.Contains(config, swap[0]) {
			t.Fatalf("the shipped configuration lacks %q", swap[0])
		}
		config = strings.Replace(config, swap[0], swap[1], 1)
	}
	testShipped := filepath.Join(dir, "shipped.yml")
	must(t, os.WriteFile(testShipped, []byte(config), 0o644))
	secrets := mediamtx.NewSecrets()
	configPath, err := mediamtx.WriteConfig(testShipped, filepath.Join(dir, "run"), secrets)
	must(t, err)

	sup, err := supervisor.New(filepath.Join(dir, "state"))
	must(t, err)
	server, err := sup.Start(supervisor.Spec{Name: "mediamtx", Path: binary, Args: []string{configPath}, Restart: true})
	must(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		sup.StopAll(ctx)
		if t.Failed() {
			t.Logf("MediaMTX's last lines:\n%s", strings.Join(server.Tail(), "\n"))
		}
	})
	client := mediamtx.NewClient(fmt.Sprintf("http://127.0.0.1:%d", apiPort), secrets)
	eventually(t, "MediaMTX's API answers", func() bool {
		_, err := client.Snapshot(context.Background())
		return err == nil
	})

	root := filepath.Join(dir, "media")
	must(t, os.MkdirAll(root, 0o755))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	runner := jobs.New(map[jobs.Kind]int{RenditionJob: 1})
	t.Cleanup(func() { _ = runner.Shutdown(context.Background()) })
	relays, err := relay.New(relay.Options{MaxRelays: 4, IdleStop: time.Second, StallTimeout: 10 * time.Second,
		Start: func(key, source string) (*exec.Cmd, error) {
			cmd, ok := RelayCommand(ffmpeg, key, source)
			if !ok {
				return nil, errors.New("not a slot's stream")
			}
			return cmd, nil
		}})
	must(t, err)
	t.Cleanup(relays.Close)

	l := &live{root: root, rtsp: fmt.Sprintf("rtsp://127.0.0.1:%d", rtspPort), ffmpeg: ffmpeg, ffprobe: ffprobe, sup: sup}
	l.m, err = New(Options{
		StorePath:      filepath.Join(dir, "data", "sources.json"),
		MediaRoot:      root,
		Probes:         media.NewCache(ctx, media.FFprobe(ffprobe)),
		MediaMTX:       client,
		PublisherQuery: secrets.PublisherQuery(),
		RTSPBase:       l.rtsp,
		Start:          sup.Starter(),
		Jobs:           runner,
		Relays:         relays,
		FFmpeg:         ffmpeg,
		FFprobe:        ffprobe,
		snapshotEvery:  200 * time.Millisecond,
	})
	must(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := l.m.Close(ctx); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return l
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

// clip generates a test clip into the library with ffmpeg's output arguments.
func (l *live) clip(t *testing.T, name string, args ...string) {
	t.Helper()
	all := append([]string{"-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=3"}, args...)
	all = append(all, filepath.Join(l.root, name))
	if out, err := exec.Command(l.ffmpeg, all...).CombinedOutput(); err != nil {
		t.Fatalf("making %s: %v\n%s", name, err, out)
	}
}

// waitState waits until slot n is in state, and returns it.
func (l *live) waitState(t *testing.T, n int, state State) Slot {
	t.Helper()
	var s Slot
	deadline := time.Now().Add(40 * time.Second)
	for {
		s, _ = l.m.Slot(n, "127.0.0.1")
		if s.State == state {
			return s
		}
		if time.Now().After(deadline) {
			t.Fatalf("src%d is %s (%s), not %s", n, s.State, s.Error, state)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// probe reads a path's stream with ffprobe.
func (l *live) probe(t *testing.T, path string) map[string]any {
	t.Helper()
	out, err := exec.Command(l.ffprobe, "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
		"-show_entries", "stream=codec_name,width,height,r_frame_rate", "-of", "json", l.rtsp+"/"+path).Output()
	must(t, err)
	var decoded struct {
		Streams []map[string]any `json:"streams"`
	}
	must(t, json.Unmarshal(out, &decoded))
	if len(decoded.Streams) != 1 {
		t.Fatalf("%s carries %d video streams", path, len(decoded.Streams))
	}
	return decoded.Streams[0]
}

// firstPicture reads the first picture of a multipart MJPEG response.
func firstPicture(t *testing.T, handler http.HandlerFunc) []byte {
	t.Helper()
	server := httptest.NewServer(handler)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)
	response, err := http.DefaultClient.Do(request)
	must(t, err)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("%d: %s", response.StatusCode, body)
	}
	_, params, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	must(t, err)
	part, err := multipart.NewReader(bufio.NewReader(response.Body), params["boundary"]).NextPart()
	must(t, err)
	picture, err := io.ReadAll(part)
	must(t, err)
	return picture
}

func TestLiveFileSlotsPublishAndRelay(t *testing.T) {
	l := startLive(t)
	l.clip(t, "clip.mp4", "-c:v", "libx264", "-profile:v", "baseline", "-g", "25", "-pix_fmt", "yuv420p")
	l.clip(t, "clip.avi", "-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p")

	// The probes come in the background; the slot waits for them.
	must(t, l.m.AssignFile(1, "clip.mp4", 0))
	must(t, l.m.Start(1))
	s := l.waitState(t, 1, Live)
	if s.Codec != "h264" || s.Publisher == nil || s.Publisher.Protocol != "rtsp" || s.ActiveFile != "clip.mp4" {
		t.Errorf("a live file slot: %+v %+v", s, s.Publisher)
	}
	if got := l.probe(t, "src1"); got["codec_name"] != "h264" || got["width"] != 320.0 {
		t.Errorf("src1 carries %v", got)
	}

	// A rendition at another rate.
	must(t, l.m.AssignFile(2, "clip.mp4", 10))
	must(t, l.m.Start(2))
	s = l.waitState(t, 2, Live)
	if !strings.HasPrefix(s.ActiveFile, ".renditions/clip_") {
		t.Errorf("the rendition slot streams %q", s.ActiveFile)
	}
	if got := l.probe(t, "src2"); got["r_frame_rate"] != "10/1" {
		t.Errorf("src2 carries %v", got)
	}

	// An MJPEG file: RTP/JPEG over RTSP, and the same pictures over HTTP.
	must(t, l.m.AssignFile(3, "clip.avi", 0))
	must(t, l.m.Start(3))
	s = l.waitState(t, 3, Live)
	if s.Codec != "mjpeg" || s.URLs.HTTPMJPEG == "" {
		t.Errorf("an MJPEG slot: %+v", s)
	}
	eventually(t, "MediaMTX knows src3's codec", func() bool {
		l.m.mu.Lock()
		defer l.m.mu.Unlock()
		return l.m.snap.Paths["src3"].Codec == "mjpeg"
	})
	for _, serve := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"the HTTP MJPEG output", func(w http.ResponseWriter, r *http.Request) { l.m.ServeHTTPMJPEG(w, r, 3) }},
		{"a preview", func(w http.ResponseWriter, r *http.Request) { l.m.Preview(w, r, 1) }},
	} {
		picture := firstPicture(t, serve.handler)
		decoded, err := jpeg.Decode(bytes.NewReader(picture))
		if err != nil {
			t.Fatalf("%s: %v", serve.name, err)
		}
		if size := decoded.Bounds().Size(); size.X != 320 || size.Y != 240 {
			t.Errorf("%s: a picture of %v", serve.name, size)
		}
	}

	// Stopping ends the stream.
	must(t, l.m.Stop(1))
	l.waitState(t, 1, Idle)
	eventually(t, "src1 is not ready", func() bool {
		l.m.mu.Lock()
		defer l.m.mu.Unlock()
		return !l.m.snap.Paths["src1"].Ready
	})
}

func TestLivePullSlots(t *testing.T) {
	l := startLive(t)
	ctx := context.Background()
	// The "camera": a publisher on the password-protected path.
	camera := exec.Command(l.ffmpeg, "-nostdin", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15",
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "15", "-pix_fmt", "yuv420p",
		"-f", "rtsp", "-rtsp_transport", "tcp", l.rtsp+"/secure")
	must(t, camera.Start())
	t.Cleanup(func() {
		_ = camera.Process.Kill() // the ffmpeg this test started
		_ = camera.Wait()
	})
	cameraURL := l.rtsp + "/secure"
	eventually(t, "the camera publishes", func() bool {
		return exec.Command(l.ffprobe, "-v", "error", "-rtsp_transport", "tcp", strings.Replace(cameraURL, "rtsp://", "rtsp://camuser:campw@", 1)).Run() == nil
	})

	wantCode(t, l.m.AssignPull(ctx, 1, cameraURL, "", ""), CodePullAuthFailed)
	wantCode(t, l.m.AssignPull(ctx, 1, cameraURL, "camuser", "wrong"), CodePullAuthFailed)
	closed := fmt.Sprintf("rtsp://127.0.0.1:%d/x", freePort(t))
	err := l.m.AssignPull(ctx, 1, closed, "", "")
	wantCode(t, err, CodePullUnreachable)
	t.Logf("an unreachable camera: %v", err)

	must(t, l.m.AssignPull(ctx, 1, cameraURL, "camuser", "campw"))
	s := l.waitState(t, 1, Live)
	if s.Pull == nil || s.Pull.Status != PullLive || s.Codec != "h264" {
		t.Errorf("a live pull: %+v %+v", s, s.Pull)
	}
	if got := l.probe(t, "src1"); got["width"] != 320.0 {
		t.Errorf("src1 carries %v", got)
	}
	eventually(t, "the pulled stream is probed", func() bool {
		s, _ := l.m.Slot(1, "")
		return s.Publisher != nil && s.Publisher.Width == 320
	})

	// Stopping clears MediaMTX's pull; the slot keeps its camera and starts again.
	must(t, l.m.Stop(1))
	l.waitState(t, 1, Idle)
	must(t, l.m.Start(1))
	l.waitState(t, 1, Live)
	must(t, l.m.Clear(1))
	eventually(t, "the pull is cleared", func() bool {
		l.m.mu.Lock()
		defer l.m.mu.Unlock()
		path := l.m.snap.Paths["src1"]
		return !path.Ready && !path.Pulled()
	})
}
