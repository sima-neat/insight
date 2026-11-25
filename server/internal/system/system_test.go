package system

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"insight/internal/config"
)

// neatJSON is `neat --json` as core's scripts/neat writes it in the SDK, with the fields System
// Info must not pass on.
const neatJSON = `{
  "schema": "sima.neat.status.v1",
  "environment": {"mode": "elxr-sdk", "label": "eLxr SDK", "sdkVersion": "2.1.0", "devkitBuildVersion": null, "sysroot": "/opt/sysroot"},
  "updateCheck": {"offline": false, "status": "Update available", "errors": ["core: timeout"]},
  "components": {
    "core": {"name": "Neat core", "version": "0.9.1", "tag": "v0.9.1", "channel": "stable", "latestTag": "v0.9.2",
      "updateAvailable": true, "provenance": {"vulcanBaseUrl": "https://internal.example/vulcan"}},
    "insight": {"name": "neat-insight", "version": "1.4.0", "serviceState": "Running", "venv": "/opt/venv"}
  },
  "insight": {"serviceState": "Running", "venv": "/opt/venv", "webUiUrl": "https://10.0.0.2:19900"},
  "codeUI": {"backend": "code-server", "auth": "password", "password": "hunter2", "localUrl": "http://127.0.0.1:8443"},
  "exposedPorts": [{"name": "mainUI", "protocol": "tcp", "hostPortStart": 19900, "hostPortEnd": null}],
  "pcie": {"cards": []}
}`

func testConfig() config.Config {
	return config.Config{
		Port: 9900, Place: config.SDK, DataDir: "/data", CertHost: "10.0.0.2",
		Network:  config.Network{BrowserICEAddressSource: "none"},
		Channels: config.Channels{Count: 4, Source: "sdk-port-map"}, WebRTCPorts: config.PortRange{Start: 40000, End: 40010},
		Published:    config.PublishedPorts{RTSP: 18554},
		ExposedPorts: []config.ExposedPort{{Name: "mainUI.tcp", Protocol: "tcp", Start: 19900}},
	}
}

func TestNeatIsAllowlisted(t *testing.T) {
	r := New(Options{Version: "1.4.0", Config: testConfig(),
		RunNeat: func(context.Context) ([]byte, error) { return []byte(neatJSON), nil }})
	info := r.Info(t.Context(), "10.0.0.2:19900", true)
	if info.Neat.State != "ready" || info.Neat.ReadAt == nil || *info.Neat.Environment.Label != "eLxr SDK" ||
		*info.Neat.Components["core"].LatestTag != "v0.9.2" || info.Neat.UpdateCheck.Errors[0] != "core: timeout" {
		t.Fatalf("neat %+v", info.Neat)
	}
	encoded, _ := json.Marshal(info)
	for _, secret := range []string{"hunter2", "codeUI", "password", "provenance", "vulcan", "pcie"} {
		if strings.Contains(string(encoded), secret) {
			t.Errorf("the answer holds %q: %s", secret, encoded)
		}
	}
	if info.Insight.Version != "1.4.0" || info.Insight.WebUIURL != "https://10.0.0.2:19900/" || info.Insight.Ports.RTSP != 18554 ||
		info.Insight.Build.GoVersion == "" {
		t.Errorf("insight %+v", info.Insight)
	}
	if len(info.Neat.ExposedPorts) != 1 || info.Neat.ExposedPorts[0].Name != "mainUI" {
		t.Errorf("neat's ports first: %+v", info.Neat.ExposedPorts)
	}
}

func TestNeatIsReadOnceAndOnRequest(t *testing.T) {
	var runs atomic.Int32
	release := make(chan struct{})
	r := New(Options{Config: testConfig(), RunNeat: func(context.Context) ([]byte, error) {
		runs.Add(1)
		<-release
		return []byte(neatJSON), nil
	}})
	if info := r.Info(t.Context(), "h", false); info.Neat.State != "reading" || len(info.Neat.ExposedPorts) != 1 {
		t.Errorf("while reading %+v", info.Neat)
	}
	// A refresh during the first read waits for it rather than starting another.
	answered := make(chan Info)
	go func() { answered <- r.Info(context.Background(), "h", true) }()
	time.Sleep(20 * time.Millisecond)
	close(release)
	if info := <-answered; info.Neat.State != "ready" || runs.Load() != 1 {
		t.Errorf("the refresh: %+v, %d runs", info.Neat, runs.Load())
	}
	r.Info(t.Context(), "h", false)
	r.Info(t.Context(), "h", false)
	if runs.Load() != 1 {
		t.Errorf("plain reads ran neat: %d runs", runs.Load())
	}
	r.Info(t.Context(), "h", true)
	if runs.Load() != 2 {
		t.Errorf("a refresh did not run neat: %d runs", runs.Load())
	}
}

func TestNeatMissingOrFailing(t *testing.T) {
	cases := []struct {
		name  string
		run   func(context.Context) ([]byte, error)
		state string
		code  string
	}{
		{"missing", func(context.Context) ([]byte, error) { return nil, exec.ErrNotFound }, "missing", ""},
		{"failing", func(context.Context) ([]byte, error) { return nil, errors.New("exit status 2") }, "failed", "neat_failed"},
		{"not JSON", func(context.Context) ([]byte, error) { return []byte("{"), nil }, "failed", "neat_failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			info := New(Options{Config: testConfig(), RunNeat: c.run}).Info(t.Context(), "h", true)
			if info.Neat.State != c.state || (c.code != "" && info.Neat.Error.Code != c.code) {
				t.Errorf("neat %+v", info.Neat)
			}
			// The port map's ports, which neat would have given.
			if len(info.Neat.ExposedPorts) != 1 || info.Neat.ExposedPorts[0].Name != "mainUI.tcp" || *info.Neat.ExposedPorts[0].HostPortStart != 19900 {
				t.Errorf("ports %+v", info.Neat.ExposedPorts)
			}
		})
	}
}

func TestThePublicOriginIsTheWebUI(t *testing.T) {
	cfg := testConfig()
	cfg.Network.PublicOrigin, cfg.Network.URLRouting = "https://insight.example/", "proxy"
	r := New(Options{Config: cfg, RunNeat: func(context.Context) ([]byte, error) { return nil, exec.ErrNotFound }})
	if url := r.Info(t.Context(), "h:1", false).Insight.WebUIURL; url != "https://insight.example/" {
		t.Errorf("url %s", url)
	}
}

func writeProc(t *testing.T, dir, stat string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHostReadings(t *testing.T) {
	proc := t.TempDir()
	writeProc(t, proc, "cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3\n")
	if err := os.WriteFile(filepath.Join(proc, "meminfo"), []byte("MemTotal:  8000000 kB\nMemFree: 1000000 kB\nMemAvailable:  2000000 kB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := NewHostReader(proc, t.TempDir())
	// 300 more ticks, 150 of them busy: 50 %.
	writeProc(t, proc, "cpu  200 0 150 800 150 0 0 0 0 0\n")
	h.at = time.Now().Add(-time.Second)
	host := h.Read()
	if host.CPUPercent == nil || *host.CPUPercent != 50 {
		t.Errorf("cpu %v", host.CPUPercent)
	}
	// Read again at once: the same reading, not one of a few milliseconds.
	writeProc(t, proc, "cpu  1000 0 150 800 150 0 0 0 0 0\n")
	if again := h.Read(); again.CPUPercent == nil || *again.CPUPercent != 50 {
		t.Errorf("an immediate second read %v", again.CPUPercent)
	}
	if host.Memory == nil || host.Memory.Total != 8000000*1024 || host.Memory.Used != 6000000*1024 || host.Memory.Percent != 75 {
		t.Errorf("memory %+v", host.Memory)
	}
	if host.Disk == nil || host.Disk.Total == 0 || host.Disk.Path == "" || host.Disk.Percent < 0 || host.Disk.Percent > 100 {
		t.Errorf("disk %+v", host.Disk)
	}

	none := NewHostReader(filepath.Join(proc, "missing"), filepath.Join(proc, "missing"))
	if got := none.Read(); got.CPUPercent != nil || got.Memory != nil || got.Disk != nil {
		t.Errorf("no readings %+v", got)
	}
}

func TestTheRealHost(t *testing.T) {
	h := NewHostReader("/proc", t.TempDir())
	time.Sleep(minCPUWindow + 50*time.Millisecond)
	host := h.Read()
	if host.CPUPercent == nil || *host.CPUPercent < 0 || *host.CPUPercent > 100 || host.Memory == nil || host.Disk == nil {
		t.Errorf("host %+v", host)
	}
}

func TestRunNeat(t *testing.T) {
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	if _, err := runNeat(t.Context()); !errors.Is(err, exec.ErrNotFound) {
		t.Errorf("no neat: %v", err)
	}
	// A neat whose child outlives it holding its output: the run still ends at its deadline.
	script := "#!/bin/sh\n[ \"$1\" = --json ] || exit 2\nsleep 30 &\necho '{\"schema\":\"sima.neat.status.v1\"}'\nwait\n"
	if err := os.WriteFile(filepath.Join(bin, "neat"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := runNeat(ctx); err == nil || time.Since(started) > 5*time.Second {
		t.Errorf("a hanging neat: %v after %s", err, time.Since(started))
	}
}

func TestRunNeatEndsWithItsGroup(t *testing.T) {
	bin := t.TempDir()
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	write := func(script string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(bin, "neat"), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// A neat that answers and exits, leaving a child of its own on its output: the child goes with
	// the group, so the answer comes at once and whole.
	write("sleep 30 &\necho '{\"ok\":true}'\n")
	started := time.Now()
	output, err := runNeat(t.Context())
	if err != nil || strings.TrimSpace(string(output)) != `{"ok":true}` || time.Since(started) > 900*time.Millisecond {
		t.Errorf("a neat that left a child: %q %v after %s", output, err, time.Since(started))
	}
	// A failure says the end of what neat wrote to stderr.
	write("echo 'no such board' >&2\nexit 3\n")
	if _, err := runNeat(t.Context()); err == nil || !strings.Contains(err.Error(), "no such board") || !strings.Contains(err.Error(), "exit status 3") {
		t.Errorf("a failing neat: %v", err)
	}
}
