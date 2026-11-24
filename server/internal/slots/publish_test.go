package slots

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublishersPreloadTheShim(t *testing.T) {
	t.Setenv("LD_PRELOAD", "/lib/other.so")
	dir := t.TempDir()
	shim := filepath.Join(dir, "ffmpeg_nodelay.so")
	must(t, os.WriteFile(shim, []byte("elf"), 0o644))
	if got := preloadValue(preloadEnv(shim)); got != shim+":/lib/other.so" {
		t.Errorf("LD_PRELOAD is %q", got)
	}
	if env := preloadEnv(filepath.Join(dir, "missing.so")); env != nil {
		t.Error("a missing shim was preloaded")
	}
	if env := preloadEnv(""); env != nil {
		t.Error("no shim changed the environment")
	}
	// A path the loader would split or expand is not preloaded, as a missing shim is not.
	odd := filepath.Join(dir, "my lib:$ORIGIN")
	must(t, os.MkdirAll(odd, 0o755))
	oddShim := filepath.Join(odd, "ffmpeg_nodelay.so")
	must(t, os.WriteFile(oddShim, []byte("elf"), 0o644))
	if env := preloadEnv(oddShim); env != nil {
		t.Errorf("a shim the loader cannot name was preloaded as %q", preloadValue(env))
	}
}

func preloadValue(env []string) string {
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, "LD_PRELOAD="); ok {
			return value
		}
	}
	return ""
}

func TestFFmpegOpensOnlyWhatEachInputNeeds(t *testing.T) {
	for name, test := range map[string]struct {
		args             []string
		whitelist, input string
	}{
		"a library file": {publishArgs("/m/a.m3u8", "h264", "rtsp://127.0.0.1:8554/src1"), "file", "file:/m/a.m3u8"},
		"a relay":        {mustRelay(t, previewKey(1), "rtsp://127.0.0.1:8554/src1"), "tcp,tls", "rtsp://127.0.0.1:8554/src1"},
		"a stream probe": {streamProbeArgs("rtsp://cam/stream"), "tcp,tls", "rtsp://cam/stream"},
	} {
		joined := strings.Join(test.args, " ") + " "
		if !strings.Contains(joined, "-protocol_whitelist "+test.whitelist+" ") || !strings.Contains(joined, "-i "+test.input+" ") {
			t.Errorf("%s: %s", name, joined)
		}
	}
}

func mustRelay(t *testing.T, key, source string) []string {
	t.Helper()
	args, ok := relayArgs(key, source)
	if !ok {
		t.Fatalf("no relay for %s", key)
	}
	return args
}
