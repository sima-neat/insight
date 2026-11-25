package slots

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
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

func TestWebcamPathsAreNamedByTheirRate(t *testing.T) {
	for _, c := range []struct {
		n, fps int
		want   string
	}{{1, 30, "cam1"}, {48, 30, "cam48"}, {1, 60, "cam1r60"}, {48, 60, "cam48r60"}} {
		if got := camName(c.n, c.fps); got != c.want {
			t.Errorf("camName(%d, %d) is %s, want %s", c.n, c.fps, got, c.want)
		}
	}
	if got := camNames(3); !slices.Equal(got, []string{"cam3", "cam3r60"}) {
		t.Errorf("camNames(3) is %v", got)
	}
	for _, fps := range []int{30, 60} {
		if !isWebcamRate(fps) {
			t.Errorf("%d fps is not a webcam rate", fps)
		}
	}
	for _, fps := range []int{-60, 0, 1, 15, 25, 29, 50, 59, 61, 120} {
		if isWebcamRate(fps) {
			t.Errorf("%d fps is taken for a webcam rate", fps)
		}
	}
}

// TestTheNormalizerHasAPathPerRate holds webrtc/mediamtx.yml to camName: every slot's webcam
// path at every rate matches exactly one of its cam patterns, whose normalizer encodes at that
// rate with a keyframe every second, the patterns' commands differ in the rate alone, and no
// other name a browser might try (a slot outside 1 to 48, another rate) matches any.
func TestTheNormalizerHasAPathPerRate(t *testing.T) {
	shipped, err := os.ReadFile(filepath.Join("..", "..", "..", "webrtc", "mediamtx.yml"))
	must(t, err)
	patterns := camPatterns(t, string(shipped))
	if len(patterns) != len(webcamRates) {
		t.Fatalf("the configuration has %d cam patterns, not one per rate of %v", len(patterns), webcamRates)
	}
	commandOf := map[int]string{}
	for _, rate := range webcamRates {
		for n := 1; n <= Count; n++ {
			var matched []camPattern
			for _, p := range patterns {
				if p.re.MatchString(camName(n, rate)) {
					matched = append(matched, p)
				}
			}
			if len(matched) != 1 {
				t.Fatalf("%s matches %d patterns", camName(n, rate), len(matched))
			}
			commandOf[rate] = matched[0].command
		}
		flags := fmt.Sprintf(" -r %d -g %d -keyint_min %d ", rate, rate, rate)
		if strings.Count(commandOf[rate], flags) != 1 {
			t.Errorf("the normalizer of %d fps lacks %q: %s", rate, flags, commandOf[rate])
		}
		if !strings.Contains(commandOf[rate], " rtsp://127.0.0.1:8554/src$G1?publisher=insight-unrendered") {
			t.Errorf("the normalizer of %d fps does not publish onto the slot: %s", rate, commandOf[rate])
		}
	}
	plain := func(rate int) string {
		return strings.Replace(commandOf[rate], fmt.Sprintf(" -r %d -g %d -keyint_min %d ", rate, rate, rate), " RATE ", 1)
	}
	for _, rate := range webcamRates[1:] {
		if plain(rate) != plain(webcamRates[0]) {
			t.Errorf("the normalizers of %d and %d fps differ in more than the rate:\n%s\n%s",
				webcamRates[0], rate, commandOf[webcamRates[0]], commandOf[rate])
		}
	}
	for _, name := range []string{"cam0", "cam49", "cam1r30", "cam1r61", "cam1r600", "cam01", "xcam1", "cam1r60x", "src1"} {
		for _, p := range patterns {
			if p.re.MatchString(name) {
				t.Errorf("%s matches %s", name, p.re)
			}
		}
	}
}

type camPattern struct {
	re      *regexp.Regexp
	command string // runOnReady, its folded lines joined by spaces
}

// camPatterns reads the regular-expression paths of the shipped configuration that name cam
// paths, each with its runOnReady command. It reads the file's own layout, a quoted key two
// spaces in and the command folded under it, which TestTheNormalizerHasAPathPerRate relies on.
func camPatterns(t *testing.T, config string) []camPattern {
	t.Helper()
	var patterns []camPattern
	lines := strings.Split(config, "\n")
	for i, line := range lines {
		key, ok := strings.CutPrefix(line, `  "~`)
		if !ok || !strings.HasPrefix(key, "^cam") {
			continue
		}
		re, err := regexp.Compile(strings.TrimSuffix(key, `":`))
		must(t, err)
		p := camPattern{re: re}
		if i+1 >= len(lines) || lines[i+1] != "    runOnReady: >" {
			t.Fatalf("%s has no folded runOnReady after it", line)
		}
		var parts []string
		for _, folded := range lines[i+2:] {
			part, ok := strings.CutPrefix(folded, "      ")
			if !ok {
				break
			}
			parts = append(parts, part)
		}
		p.command = strings.Join(parts, " ")
		patterns = append(patterns, p)
	}
	return patterns
}
