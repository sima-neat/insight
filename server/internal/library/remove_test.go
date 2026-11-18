package library

import (
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
)

// The guard is tested on plain strings: nothing is removed by these cases.
func TestCheckRemoval(t *testing.T) {
	root := t.TempDir() // empty: the guard reads it for the links before an entry, never writes
	for _, abs := range []string{
		filepath.Join(root, "clip.mp4"),
		filepath.Join(root, "sub", "clip.mp4"),
		filepath.Join(root, "sub"),
	} {
		if err := checkRemoval(root, abs); err != nil {
			t.Errorf("checkRemoval(%s) refused: %v", abs, err)
		}
	}
	for _, abs := range []string{
		"",
		"/",
		".",
		"clip.mp4",
		root,
		root + "/",
		root + "/.",
		root + "/./clip.mp4",
		root + "//clip.mp4",
		root + "/../clip.mp4",
		root + "/sub/../../x",
		filepath.Dir(root),
		root + "-other/clip.mp4",
		"/etc/passwd",
		root + "/.staging-1",
		root + "/sub/.renditions",
		root + "/__MACOSX",
		root + "/clip\x00.mp4",
	} {
		if err := checkRemoval(root, abs); err == nil {
			t.Errorf("checkRemoval(%q) allowed it", abs)
		}
	}
	for _, badRoot := range []string{"", "/", "media", "."} {
		if err := checkRemoval(badRoot, "/media/clip.mp4"); err == nil {
			t.Errorf("checkRemoval with the root %q allowed a removal", badRoot)
		}
	}
}

// stubRemoval records what Delete would remove, removing nothing.
type stubRemoval struct {
	mu      sync.Mutex
	removed []string
	folders []bool
}

func (s *stubRemoval) remove(root, abs string, folder bool) error {
	if err := checkRemoval(root, abs); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removed = append(s.removed, abs)
	s.folders = append(s.folders, folder)
	return nil
}

// links lays out the fixture's library with links of every kind and a folder outside it.
func links(t *testing.T, f *fixture) (outside string) {
	t.Helper()
	outside = t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.mp4"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.write(t, "clip.mp4", "clip")
	f.write(t, "sub/deep.mp4", "deep")
	for target, link := range map[string]string{
		"sub":                                "link-sub",
		filepath.Join(outside, "secret.mp4"): "link-out.mp4",
		outside:                              "link-out-dir",
		filepath.Join(f.root, "missing.mp4"): "dangling.mp4",
	} {
		if err := os.Symlink(target, filepath.Join(f.root, link)); err != nil {
			t.Fatal(err)
		}
	}
	return outside
}

func TestDeleteRefusesWithoutRemoving(t *testing.T) {
	f := newFixture(t, nil)
	links(t, f)
	stub := &stubRemoval{}
	f.lib.remove = stub.remove
	if err := os.Mkdir(filepath.Join(f.root, ".staging-x"), 0o755); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		paths []string
		code  string
	}{
		{nil, CodeInvalidRequest},
		{[]string{""}, CodeInvalidPath},
		{[]string{"."}, CodeInvalidPath},
		{[]string{"/"}, CodeInvalidPath},
		{[]string{"./"}, CodeInvalidPath},
		{[]string{".."}, CodeInvalidPath},
		{[]string{"../x"}, CodeInvalidPath},
		{[]string{"sub/../.."}, CodeInvalidPath},
		{[]string{"/etc/passwd"}, CodeInvalidPath},
		{[]string{".staging-x"}, CodeInvalidPath},
		{[]string{"sub/.hidden"}, CodeInvalidPath},
		{[]string{"__MACOSX"}, CodeInvalidPath},
		{[]string{"link-out-dir/secret.mp4"}, CodeInvalidPath},
		{[]string{"missing.mp4"}, CodeNotFound},
		{[]string{"clip.mp4/below"}, CodeNotFound},
		// One bad path refuses the whole request.
		{[]string{"clip.mp4", "../x"}, CodeInvalidPath},
		{[]string{"clip.mp4", "missing.mp4"}, CodeNotFound},
	} {
		if _, err := f.lib.Delete(test.paths); code(err) != test.code {
			t.Errorf("Delete(%q) = %v, want %s", test.paths, err, test.code)
		}
	}
	if len(stub.removed) != 0 {
		t.Fatalf("refused requests removed %v", stub.removed)
	}
}

func TestDeleteRefusesWhatSlotsUse(t *testing.T) {
	f := newFixture(t, nil)
	links(t, f)
	stub := &stubRemoval{}
	f.lib.remove = stub.remove
	f.files.use("clip.mp4", 9, 3)
	f.files.use("link-sub/deep.mp4", 5)

	for _, paths := range [][]string{{"clip.mp4"}, {"sub/deep.mp4", "clip.mp4"}, {"link-sub"}} {
		_, err := f.lib.Delete(paths)
		if code(err) != CodeInUse {
			t.Fatalf("Delete(%q) = %v, want in_use", paths, err)
		}
	}
	_, err := f.lib.Delete([]string{"clip.mp4", "link-sub"})
	if e := err.(*Error); !slices.Equal(e.Slots, []int{3, 5, 9}) || e.Message != "clip.mp4, link-sub/deep.mp4 are used by src3, src5, src9." {
		t.Fatalf("in_use names %v: %s", e.Slots, e.Message)
	}
	if len(stub.removed) != 0 {
		t.Fatalf("a refused request removed %v", stub.removed)
	}
}

func TestDeleteRemovesEachEntryOnceAndLinksAsLinks(t *testing.T) {
	f := newFixture(t, nil)
	links(t, f)
	stub := &stubRemoval{}
	f.lib.remove = stub.remove

	deleted, err := f.lib.Delete([]string{"sub/deep.mp4", "sub", "link-out.mp4", "./link-out-dir/", "dangling.mp4", "sub"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"dangling.mp4", "link-out-dir", "link-out.mp4", "sub"}; !slices.Equal(deleted.Paths, want) {
		t.Fatalf("deleted %v, want %v", deleted.Paths, want)
	}
	want := []string{"dangling.mp4", "link-out-dir", "link-out.mp4", "sub"}
	for i, abs := range stub.removed {
		if abs != filepath.Join(f.root, want[i]) || stub.folders[i] != (want[i] == "sub") {
			t.Errorf("removal %d: %s (folder %v)", i, abs, stub.folders[i])
		}
	}
}

// Real removals, only below temporary folders.
func TestDeleteRemoves(t *testing.T) {
	f := newFixture(t, nil)
	outside := links(t, f)
	f.write(t, "sub/more/clip.mp4", "x")
	if _, err := f.lib.Tree(); err != nil { // walked once, so the change must walk again
		t.Fatal(err)
	}

	if _, err := f.lib.Delete([]string{"clip.mp4", "sub", "link-out.mp4", "link-out-dir", "dangling.mp4"}); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"clip.mp4", "sub", "link-out.mp4", "link-out-dir", "dangling.mp4"} {
		if _, err := os.Lstat(filepath.Join(f.root, rel)); !os.IsNotExist(err) {
			t.Errorf("%s is still there: %v", rel, err)
		}
	}
	// The links went, not what they led to.
	if data, err := os.ReadFile(filepath.Join(outside, "secret.mp4")); err != nil || string(data) != "secret" {
		t.Fatalf("the link's target was touched: %q, %v", data, err)
	}
	tree, err := f.lib.Tree()
	if err != nil {
		t.Fatal(err)
	}
	if len(tree.Children) != 1 || tree.Children[0].Name != "link-sub" {
		t.Fatalf("the tree after the delete: %+v", tree.Children)
	}
	if _, err := os.Stat(f.root); err != nil {
		t.Fatalf("the media folder itself is gone: %v", err)
	}
}
