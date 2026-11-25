package slots

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTheStoreKeepsTheDesiredStateButNotRunOrSecrets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "sources.json")
	s, err := LoadStore(path)
	must(t, err)
	if d := s.get(1); d.Kind != KindNone {
		t.Fatalf("an empty store's slot: %+v", d)
	}
	pull, err := parsePullURL("rtsp://cam/live?token=abc", "admin", "pw")
	must(t, err)
	open, err := parsePullURL("rtsp://10.0.0.8:8554/stream", "", "")
	must(t, err)
	s.set(1, Desired{Kind: KindFile, File: "clips/a.mp4", FPS: 15, Run: true})
	s.set(2, Desired{Kind: KindWebcam, FPS: 60, Run: true})
	s.set(3, Desired{Kind: KindPull, Pull: &pull.target, Run: true})
	s.set(48, Desired{Kind: KindPull, Pull: &open.target})
	must(t, s.write(s.encode()))

	content, err := os.ReadFile(path)
	must(t, err)
	for _, secret := range []string{"admin", "pw", "abc", "run"} {
		if strings.Contains(string(content), secret) {
			t.Errorf("the saved store holds %q:\n%s", secret, content)
		}
	}
	loaded, err := LoadStore(path)
	must(t, err)
	if d := loaded.get(1); d.Kind != KindFile || d.File != "clips/a.mp4" || d.FPS != 15 || d.Run {
		t.Errorf("slot 1: %+v", d)
	}
	if d := loaded.get(2); d.Kind != KindWebcam || d.FPS != 60 || d.Run {
		t.Errorf("slot 2: %+v", d)
	}
	if d := loaded.get(3); d.Kind != KindPull || d.Pull.Host != "cam:554" || d.Pull.Path != "/live?token=***" || d.Pull.URL != "" {
		t.Errorf("slot 3: %+v %+v", d, d.Pull)
	}
	if d := loaded.get(48); d.Pull == nil || d.Pull.URL != "rtsp://10.0.0.8:8554/stream" {
		t.Errorf("slot 48: %+v", d)
	}
	if d := loaded.get(4); d.Kind != KindNone {
		t.Errorf("slot 4: %+v", d)
	}
}

func TestADamagedStoreStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sources.json")
	must(t, os.WriteFile(path, []byte(`{"version": 1, "slots": [{"n": 1, "kind": "fi`), 0o644))
	s, err := LoadStore(path)
	if err == nil || !strings.Contains(err.Error(), "damaged") {
		t.Errorf("a torn store: %v", err)
	}
	if s == nil || s.get(1).Kind != KindNone {
		t.Fatal("a torn store did not start empty")
	}
	// The next change replaces it.
	s.set(1, Desired{Kind: KindWebcam})
	must(t, s.write(s.encode()))
	if _, err := LoadStore(path); err != nil {
		t.Errorf("after a change: %v", err)
	}

	must(t, os.WriteFile(path, []byte(`{"version": 7, "slots": []}`), 0o644))
	if _, err := LoadStore(path); err == nil {
		t.Error("a store of another format was read")
	}

	// Entries that cannot be slots are left out, the rest kept.
	must(t, os.WriteFile(path, []byte(`{"version": 1, "slots": [
		{"n": 0, "kind": "webcam"}, {"n": 49, "kind": "webcam"}, {"n": 2, "kind": "magic"},
		{"n": 3, "kind": "file"}, {"n": 4, "kind": "pull"}, {"n": 6, "kind": "webcam", "fps": 25},
		{"n": 5, "kind": "webcam"}]}`), 0o644))
	s, err = LoadStore(path)
	if err == nil || strings.Count(err.Error(), "\n") != 5 || !strings.Contains(err.Error(), "webcam rate 25") {
		t.Errorf("six bad entries: %v", err)
	}
	// A webcam saved before there were two rates, with none, is at the one rate there was.
	if d := s.get(5); d.Kind != KindWebcam || d.FPS != DefaultWebcamFPS {
		t.Errorf("the good entry was not kept: %+v", d)
	}
	if s.get(2).Kind != KindNone || s.get(3).Kind != KindNone || s.get(6).Kind != KindNone {
		t.Errorf("a bad entry was kept")
	}
}

func TestTheStoreIsWrittenWholeAndInOrder(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sources.json")
	s, err := LoadStore(path)
	must(t, err)
	s.set(1, Desired{Kind: KindWebcam})
	older, olderContent := s.encode()
	s.set(2, Desired{Kind: KindWebcam})
	newer, newerContent := s.encode()

	// Two saves whose writes overtook each other: the older one is not written over the newer.
	must(t, s.write(newer, newerContent))
	must(t, s.write(older, olderContent))
	loaded, err := LoadStore(path)
	must(t, err)
	if loaded.get(2).Kind != KindWebcam {
		t.Error("an older save replaced a newer one")
	}
	entries, err := os.ReadDir(dir)
	must(t, err)
	if len(entries) != 1 {
		t.Errorf("the folder holds %d entries, temporary files left behind", len(entries))
	}

	// A write that cannot be made leaves the file as it was.
	must(t, os.Chmod(dir, 0o500))
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	s.set(3, Desired{Kind: KindWebcam})
	if err := s.write(s.encode()); err == nil {
		t.Skip("the folder is writable regardless (running as root)")
	}
	loaded, err = LoadStore(path)
	must(t, err)
	if loaded.get(2).Kind != KindWebcam || loaded.get(3).Kind != KindNone {
		t.Error("a failed write changed the file")
	}
}
