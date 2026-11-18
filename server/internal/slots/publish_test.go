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
	var aliases shimAliases
	if got := preloadValue(preloadEnv(shim, &aliases)); got != shim+":/lib/other.so" {
		t.Errorf("LD_PRELOAD is %q", got)
	}
	if env := preloadEnv(filepath.Join(dir, "missing.so"), &aliases); env != nil {
		t.Error("a missing shim was preloaded")
	}
	if env := preloadEnv("", &aliases); env != nil {
		t.Error("no shim changed the environment")
	}

	// A path the loader would split or expand is preloaded through a link.
	t.Setenv("LD_PRELOAD", "")
	odd := filepath.Join(dir, "my lib:$ORIGIN")
	must(t, os.MkdirAll(odd, 0o755))
	oddShim := filepath.Join(odd, "ffmpeg_nodelay.so")
	must(t, os.WriteFile(oddShim, []byte("elf"), 0o644))
	got := preloadValue(preloadEnv(oddShim, &aliases))
	if loaderUnsafe(got) || !strings.HasSuffix(got, "/ffmpeg_nodelay.so") {
		t.Fatalf("an unsafe shim path is preloaded as %q", got)
	}
	if target, err := os.Readlink(got); err != nil || target != oddShim {
		t.Errorf("the link leads to %q (%v)", target, err)
	}
	if again := preloadValue(preloadEnv(oddShim, &aliases)); again != got {
		t.Error("a second publisher made a second link")
	}
	aliases.remove()
	if _, err := os.Lstat(filepath.Dir(got)); !os.IsNotExist(err) {
		t.Error("the link's folder is left")
	}
	if _, err := os.Stat(oddShim); err != nil {
		t.Error("removing the link removed the shim")
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
