package mediamtx

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"insight/internal/supervisor"
)

// These tests run the real MediaMTX when NEAT_INSIGHT_MEDIAMTX names its program (CI downloads
// the release build.sh bundles), from the shipped configuration rendered by WriteConfig, under
// the supervisor with Spec's environment, on free loopback ports in a temporary folder. The
// publishers are ffmpeg processes the tests start and stop themselves.

type liveMediaMTX struct {
	client  *Client
	secrets Secrets
	rtsp    string // rtsp://127.0.0.1:<port>
	apiURL  string
	ffmpeg  string
}

func startMediaMTX(t *testing.T) *liveMediaMTX {
	t.Helper()
	binary := os.Getenv("NEAT_INSIGHT_MEDIAMTX")
	if binary == "" {
		t.Skip("NEAT_INSIGHT_MEDIAMTX does not name a MediaMTX program")
	}
	dir := t.TempDir()
	rtspPort, apiPort := freePort(t), freePort(t)
	// The test's ports instead of the fixed ones, as the old backend's integration tests do:
	// RTSP over TCP only (UDP would bind MediaMTX's fixed RTP ports), and no WHIP or SRT
	// listener, which would bind fixed ports the tests do not use.
	shipped := string(readShipped(t))
	for _, swap := range [][2]string{
		{"rtspAddress: :8554", fmt.Sprintf("rtspAddress: :%d", rtspPort)},
		{"apiAddress: 127.0.0.1:9901", fmt.Sprintf("apiAddress: 127.0.0.1:%d", apiPort)},
		{"rtsp://127.0.0.1:8554/", fmt.Sprintf("rtsp://127.0.0.1:%d/", rtspPort)},
		{"api: yes", "api: yes\nrtspTransports: [tcp]\nsrt: no"},
		{"webrtc: yes", "webrtc: no"},
	} {
		if !strings.Contains(shipped, swap[0]) {
			t.Fatalf("the shipped configuration lacks %q", swap[0])
		}
		shipped = strings.ReplaceAll(shipped, swap[0], swap[1])
	}
	testShipped := filepath.Join(dir, "shipped.yml")
	if err := os.WriteFile(testShipped, []byte(shipped), 0o644); err != nil {
		t.Fatal(err)
	}
	secrets := NewSecrets()
	config, err := WriteConfig(testShipped, filepath.Join(dir, "run"), secrets)
	if err != nil {
		t.Fatal(err)
	}
	cert, key := writeTestCertificate(t, dir)

	sup, err := supervisor.New(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	process, err := sup.Start(Spec(Options{Binary: binary, Config: config, CertFile: cert, KeyFile: key}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		sup.StopAll(ctx)
		if t.Failed() {
			t.Logf("MediaMTX's last lines:\n%s", strings.Join(process.Tail(), "\n"))
		}
	})

	live := &liveMediaMTX{
		secrets: secrets,
		rtsp:    fmt.Sprintf("rtsp://127.0.0.1:%d", rtspPort),
		apiURL:  fmt.Sprintf("http://127.0.0.1:%d", apiPort),
	}
	live.client = NewClient(live.apiURL, secrets)
	live.ffmpeg, _ = exec.LookPath("ffmpeg")
	eventually(t, 10*time.Second, "MediaMTX's API answers", func() bool {
		_, err := live.client.Snapshot(context.Background())
		return err == nil
	})
	return live
}

func (m *liveMediaMTX) needFFmpeg(t *testing.T) {
	t.Helper()
	if m.ffmpeg == "" {
		t.Skip("no ffmpeg to publish with")
	}
}

// publish starts ffmpeg publishing a test picture to path, with query when it is not empty,
// and returns a channel closed when it exits.
func (m *liveMediaMTX) publish(t *testing.T, path, query string) <-chan struct{} {
	t.Helper()
	target := m.rtsp + "/" + path
	if query != "" {
		target += "?" + query
	}
	cmd := exec.Command(m.ffmpeg, "-nostdin", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15",
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "15", "-pix_fmt", "yuv420p",
		"-f", "rtsp", "-rtsp_transport", "tcp", target)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() {
		_ = cmd.Process.Kill() // the ffmpeg this test started
		<-exited
	})
	return exited
}

func (m *liveMediaMTX) path(t *testing.T, name string) Path {
	t.Helper()
	snap, err := m.client.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return snap.Paths[name]
}

func (m *liveMediaMTX) waitFor(t *testing.T, name, what string, ok func(Path) bool) Path {
	t.Helper()
	var path Path
	eventually(t, 15*time.Second, name+": "+what, func() bool {
		path = m.path(t, name)
		return ok(path)
	})
	return path
}

func TestMediaMTXTakesThisRunsPasswordOnly(t *testing.T) {
	m := startMediaMTX(t)
	snap, err := m.client.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for n := 1; n <= 48; n++ {
		if path, ok := snap.Paths[fmt.Sprintf("src%d", n)]; !ok || path.Ready || path.Source != nil {
			t.Errorf("src%d: %+v", n, path)
		}
	}
	// MediaMTX's default would let any local program, and any web page by CORS, drive it.
	response, err := http.Get(m.apiURL + "/v3/paths/list")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Errorf("without the password: %d", response.StatusCode)
	}
	_, err = NewClient(m.apiURL, Secrets{APIPassword: "wrong", Publisher: m.secrets.Publisher}).Snapshot(context.Background())
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("with another password: %v", err)
	}
}

func TestMediaMTXPublishersRatesAndKick(t *testing.T) {
	m := startMediaMTX(t)
	m.needFFmpeg(t)

	ours := m.publish(t, "src3", m.secrets.PublisherQuery())
	path := m.waitFor(t, "src3", "Insight's stream is ready", func(p Path) bool { return p.Ready })
	if path.External() || path.Source == nil || !path.Source.Insight || path.Codec != "h264" {
		t.Errorf("Insight's own stream: %+v", path)
	}

	m.publish(t, "src2", "")
	path = m.waitFor(t, "src2", "an external publisher", func(p Path) bool { return p.External() })
	if path.Source.Protocol != "rtsp" || path.Source.Address != "127.0.0.1" || path.Source.Type != "rtspSession" {
		t.Errorf("source %+v", *path.Source)
	}

	// First publisher wins: a second one is refused.
	select {
	case <-m.publish(t, "src2", ""):
	case <-time.After(10 * time.Second):
		t.Error("a second publisher was not refused")
	}

	first, err := m.client.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond)
	later, err := m.client.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if bps, ok := later.Bitrate(first, "src2"); !ok || bps <= 0 {
		t.Errorf("bitrate %v %v", bps, ok)
	}

	if err := m.client.Kick(context.Background(), path.Source.Type, path.Source.ID); err != nil {
		t.Fatal(err)
	}
	m.waitFor(t, "src2", "the kicked publisher is gone", func(p Path) bool { return !p.Ready })
	if err := m.client.Kick(context.Background(), path.Source.Type, path.Source.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("kicking it again: %v", err)
	}
	select {
	case <-ours:
		t.Error("kicking src2 ended Insight's stream on src3")
	default:
	}
}

func TestMediaMTXPullsAndReaders(t *testing.T) {
	m := startMediaMTX(t)
	m.needFFmpeg(t)
	m.publish(t, "src2", m.secrets.PublisherQuery())
	m.waitFor(t, "src2", "the camera stands in", func(p Path) bool { return p.Ready })

	ctx := context.Background()
	if err := m.client.SetPullSource(ctx, "src1", m.rtsp+"/src2"); err != nil {
		t.Fatal(err)
	}
	path := m.waitFor(t, "src1", "the pull is ready", func(p Path) bool { return p.Ready })
	if !path.Pulled() || path.External() || path.Codec != "h264" || !strings.HasPrefix(path.StreamKey(), "pull:src1:") {
		t.Errorf("the pulled path: %+v", path)
	}
	camera := m.path(t, "src2")
	if len(camera.Readers) != 1 || camera.Readers[0].Protocol != "rtsp" || camera.Readers[0].Address != "127.0.0.1" {
		t.Errorf("the camera's readers: %+v", camera.Readers)
	}

	// MediaMTX refuses a source it cannot use, and the error does not repeat it.
	err := m.client.SetPullSource(ctx, "src4", "nosuch://admin:hunter2@10.0.0.5/x")
	if !errors.Is(err, ErrRejected) || strings.Contains(err.Error(), "hunter2") {
		t.Errorf("an unusable source: %v", err)
	}

	if err := m.client.ClearPullSource(ctx, "src1"); err != nil {
		t.Fatal(err)
	}
	m.waitFor(t, "src1", "the pull is cleared", func(p Path) bool { return !p.Ready && !p.Pulled() })
	if err := m.client.ClearPullSource(ctx, "nosuch"); err != nil {
		t.Errorf("clearing a path MediaMTX lacks: %v", err)
	}
}

func TestMediaMTXWebcamNormalizerIsInsightsOwn(t *testing.T) {
	// A browser publishes to camN at 30 fps and to camNr60 at 60; MediaMTX's runOnReady ffmpeg
	// republishes it on srcN at that rate with this run's tag, so it must not read as an
	// external publisher on the webcam's slot. The test pictures come at 15 fps, as from a
	// camera slower than the rate: the normalizer repeats pictures to reach it.
	m := startMediaMTX(t)
	m.needFFmpeg(t)
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("no ffprobe to read the normalized rate with")
	}
	for _, c := range []struct{ cam, src, rate string }{{"cam2", "src2", "30/1"}, {"cam3r60", "src3", "60/1"}} {
		m.publish(t, c.cam, "")
		path := m.waitFor(t, c.src, "the normalizer publishes", func(p Path) bool { return p.Ready })
		if path.External() || !path.Source.Insight {
			t.Errorf("the normalized webcam on %s: %+v", c.src, *path.Source)
		}
		// Its stderr may say it joined between keyframes; only what it prints counts.
		out, err := exec.Command(ffprobe, "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
			"-show_entries", "stream=profile,r_frame_rate", "-of", "default=noprint_wrappers=1",
			m.rtsp+"/"+c.src).Output()
		if err != nil {
			t.Fatalf("probing %s: %v", c.src, err)
		}
		if got, want := string(out), "profile=Constrained Baseline\nr_frame_rate="+c.rate+"\n"; got != want {
			t.Errorf("%s published to %s comes out as %q, not %q", c.cam, c.src, got, want)
		}
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func eventually(t *testing.T, within time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("not within %v: %s", within, what)
}

// writeTestCertificate writes a self-signed pair for Spec's environment; the WHIP listener
// that would serve it is off in these tests.
func writeTestCertificate(t *testing.T, dir string) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "127.0.0.1"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certFile, keyFile := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certFile, keyFile
}
