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
