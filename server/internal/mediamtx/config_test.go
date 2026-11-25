package mediamtx

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// shippedConfig is the configuration the package ships, webrtc/mediamtx.yml in the repo.
var shippedConfig = filepath.Join("..", "..", "..", "webrtc", "mediamtx.yml")

var testSecrets = Secrets{APIPassword: "s3cret_-PW", Publisher: "insight-0123456789abcdef"}

func readShipped(t *testing.T) []byte {
	t.Helper()
	shipped, err := os.ReadFile(shippedConfig)
	if err != nil {
		t.Fatal(err)
	}
	return shipped
}

func TestRenderConfigOfTheShippedFile(t *testing.T) {
	shipped := readShipped(t)
	rendered, err := RenderConfig(shipped, testSecrets)
	if err != nil {
		t.Fatal(err)
	}
	text := string(rendered)
	for _, want := range []string{
		"\n    pass: \"s3cret_-PW\"\n",
		"rtsp://127.0.0.1:8554/src$G1?publisher=insight-0123456789abcdef\n",
		"apiAddress: 127.0.0.1:9901\n",
		"\n  - user: insight\n",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the rendered configuration lacks %q", want)
		}
	}
	for _, placeholder := range []string{passwordPlaceholder, publisherPlaceholder} {
		if strings.Contains(text, placeholder) {
			t.Errorf("the rendered configuration still holds %q", placeholder)
		}
	}
	// A webcam normalizer per rate, 30 fps on camN and 60 fps on camNr60, each publishing onto
	// srcN with this run's tag (the slots' tests hold the commands to the rates).
	for _, pattern := range []string{
		"\n  \"~^cam([1-9]|[1-3][0-9]|4[0-8])$\":\n    runOnReady: >\n",
		"\n  \"~^cam([1-9]|[1-3][0-9]|4[0-8])r60$\":\n    runOnReady: >\n",
	} {
		if !strings.Contains(text, pattern) {
			t.Errorf("the rendered configuration lacks the webcam path %q", pattern)
		}
	}
	if n := strings.Count(text, "src$G1?"+testSecrets.PublisherQuery()+"\n"); n != 2 {
		t.Errorf("%d webcam normalizers publish with this run's tag, not 2", n)
	}
	// Nothing else changed.
	back := strings.Replace(text, `"s3cret_-PW"`, passwordPlaceholder, 1)
	back = strings.ReplaceAll(back, testSecrets.PublisherQuery(), publisherPlaceholder)
	if back != string(shipped) {
		t.Error("rendering changed more than the two placeholders")
	}
	// The constants name what the shipped file binds.
	if APIURL != "http://127.0.0.1:9901" || RTSPURL != "rtsp://127.0.0.1:8554" ||
		!strings.Contains(text, "\nrtspAddress: :8554\n") {
		t.Error("APIURL or RTSPURL disagree with the shipped configuration")
	}
}

func TestRenderConfigQuotesThePassword(t *testing.T) {
	// A bare `pass: null` would read as no password at all, opening the API.
	for _, password := range []string{"null", "NULL", "true", "yes", "off", "0123", "-_"} {
		t.Run(password, func(t *testing.T) {
			rendered, err := RenderConfig([]byte("pass: "+passwordPlaceholder+"\nx: "+publisherPlaceholder+"\n"),
				Secrets{APIPassword: password, Publisher: "insight-1"})
			if err != nil {
				t.Fatal(err)
			}
			if want := "pass: \"" + password + "\"\nx: publisher=insight-1\n"; string(rendered) != want {
				t.Errorf("got %q, want %q", rendered, want)
			}
		})
	}
}

func TestRenderConfigRefuses(t *testing.T) {
	good := "pass: " + passwordPlaceholder + "\nout: " + publisherPlaceholder + "\n"
	for _, tc := range []struct {
		name    string
		config  string
		secrets Secrets
	}{
		// Launching such a file would leave the API on MediaMTX's open default.
		{"no password placeholder", "api: yes\nout: " + publisherPlaceholder + "\n", testSecrets},
		{"two password placeholders", good + "pass: " + passwordPlaceholder + "\n", testSecrets},
		// The webcam normalizer's output would read as an external publisher.
		{"no publisher placeholder", "pass: " + passwordPlaceholder + "\n", testSecrets},
		{"an empty password", good, Secrets{Publisher: "insight-1"}},
		{"a quote in the password", good, Secrets{APIPassword: `a"b`, Publisher: "insight-1"}},
		{"a line break in the password", good, Secrets{APIPassword: "a\nb", Publisher: "insight-1"}},
		{"a space in the password", good, Secrets{APIPassword: "a b", Publisher: "insight-1"}},
		{"an empty publisher tag", good, Secrets{APIPassword: "pw"}},
		{"a query in the publisher tag", good, Secrets{APIPassword: "pw", Publisher: "insight-1&reader=x"}},
		{"a space in the publisher tag", good, Secrets{APIPassword: "pw", Publisher: "insight 1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if rendered, err := RenderConfig([]byte(tc.config), tc.secrets); err == nil {
				t.Fatalf("rendered %q", rendered)
			}
		})
	}
}

func TestNewSecretsAreFreshAndRenderable(t *testing.T) {
	a, b := NewSecrets(), NewSecrets()
	if a.APIPassword == b.APIPassword || a.Publisher == b.Publisher {
		t.Fatalf("two runs share a secret: %+v %+v", a, b)
	}
	if len(a.APIPassword) < 20 || !strings.HasPrefix(a.Publisher, "insight-") || len(a.Publisher) != len("insight-")+16 {
		t.Fatalf("secrets %+v", a)
	}
	if _, err := RenderConfig(readShipped(t), a); err != nil {
		t.Fatal(err)
	}
}

func TestWriteConfigIsPrivateAndReplacesTheLastRun(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "run", "mediamtx")
	first, err := WriteConfig(shippedConfig, dir, Secrets{APIPassword: "first", Publisher: "insight-1"})
	if err != nil {
		t.Fatal(err)
	}
	path, err := WriteConfig(shippedConfig, dir, testSecrets)
	if err != nil {
		t.Fatal(err)
	}
	if path != first || path != filepath.Join(dir, RuntimeConfigName) {
		t.Fatalf("written to %s, then %s", first, path)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("mode %v, want 0600", mode)
	}
	written, _ := os.ReadFile(path)
	want, _ := RenderConfig(readShipped(t), testSecrets)
	if !bytes.Equal(written, want) {
		t.Error("the written file is not the rendered configuration")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("the folder holds %d entries, want only %s", len(entries), RuntimeConfigName)
	}
}

func TestWriteConfigOfABrokenPackage(t *testing.T) {
	dir := t.TempDir()
	broken := filepath.Join(dir, "shipped.yml")
	if err := os.WriteFile(broken, []byte("api: yes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := WriteConfig(broken, filepath.Join(dir, "out"), testSecrets)
	if err == nil || !strings.Contains(err.Error(), "rebuild it with build.sh") {
		t.Fatalf("error %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "out")); !errors.Is(err, fs.ErrNotExist) {
		t.Error("a broken configuration still created the output folder")
	}
	if _, err := WriteConfig(filepath.Join(dir, "missing.yml"), dir, testSecrets); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a missing file gave %v", err)
	}
}
