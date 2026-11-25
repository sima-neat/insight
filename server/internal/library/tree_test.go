package library

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"insight/internal/media"
)

// find is the entry at the library path rel in tree.
func find(tree Entry, rel string) (Entry, bool) {
	if tree.Path == rel {
		return tree, true
	}
	for _, child := range tree.Children {
		if e, ok := find(child, rel); ok {
			return e, true
		}
	}
	return Entry{}, false
}

// probedTree waits until each of the files rels has its probe.
func probedTree(t *testing.T, l *Library, rels ...string) Entry {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		tree, err := l.Tree()
		if err != nil {
			t.Fatal(err)
		}
		probed := true
		for _, rel := range rels {
			if e, _ := find(tree, rel); e.Probe == nil {
				probed = false
			}
		}
		if probed {
			return tree
		}
		if time.Now().After(deadline) {
			t.Fatal("the files were not probed")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestTreeTakesStreamableFromTheProbe(t *testing.T) {
	f := newFixture(t, nil)
	links(t, f) // clip.mp4, sub/deep.mp4 and links
	f.write(t, "sub/vp9.webm", "x")
	f.write(t, "raw.h264", "x")
	f.probes.set("clip.mp4", h264())
	f.probes.set("deep.mp4", h264())
	f.probes.set("vp9.webm", media.Info{Kind: media.KindVideo, Codec: "vp9", CodecName: "vp9"})
	f.probes.set("raw.h264", h264())

	first, err := f.lib.Tree()
	if err != nil {
		t.Fatal(err)
	}
	// Before its probe a file is judged by its extension.
	if e, _ := find(first, "sub/vp9.webm"); e.Probe != nil || !e.Streamable {
		t.Fatalf("vp9.webm before its probe: %+v", e)
	}

	tree := probedTree(t, f.lib, "clip.mp4", "sub/vp9.webm", "raw.h264", "sub/deep.mp4")
	for rel, want := range map[string]bool{
		"clip.mp4": true, "sub/vp9.webm": false, "raw.h264": true, "sub/deep.mp4": true,
	} {
		e, ok := find(tree, rel)
		if !ok || e.Probe == nil || e.Streamable != want || e.Probe.Streamable != want {
			t.Errorf("%s: %+v (probe %+v), want streamable %v", rel, e, e.Probe, want)
		}
	}
	// A link that leads out of the library, or nowhere, is never probed.
	for _, rel := range []string{"link-out.mp4", "dangling.mp4"} {
		if e, _ := find(tree, rel); e.Probe != nil || e.Streamable {
			t.Errorf("%s: %+v", rel, e)
		}
	}
	// A link to a file inside is probed like the file.
	if err := os.Symlink("clip.mp4", filepath.Join(f.root, "link-in.bin")); err != nil {
		t.Fatal(err)
	}
	f.probes.set("link-in.bin", h264()) // ffprobe follows the link; the fake goes by name
	f.lib.changed()
	tree = probedTree(t, f.lib, "link-in.bin")
	if e, _ := find(tree, "link-in.bin"); e.Probe == nil || !e.Streamable {
		t.Errorf("link-in.bin: %+v", e)
	}
	if sub, _ := find(tree, "sub"); !sub.Folder || sub.StreamableCount != 1 || !sub.Streamable {
		t.Errorf("sub: %+v", sub)
	}
	if tree.StreamableCount != 4 { // clip.mp4, raw.h264, sub/deep.mp4, link-in.bin
		t.Errorf("the root counts %d streamable files", tree.StreamableCount)
	}
}

func TestTreeIsWalkedAgainWhenOldOrChangedOnly(t *testing.T) {
	f := newFixture(t, nil)
	now := time.Now()
	f.lib.now = func() time.Time { return now }
	if _, err := f.lib.Tree(); err != nil {
		t.Fatal(err)
	}
	f.write(t, "copied.mp4", "x") // by other means than the library

	tree, _ := f.lib.Tree()
	if _, ok := find(tree, "copied.mp4"); ok {
		t.Fatal("the folder was walked again within the tree's age")
	}
	now = now.Add(treeMaxAge)
	tree, _ = f.lib.Tree()
	if _, ok := find(tree, "copied.mp4"); !ok {
		t.Fatal("an old walk was not walked again")
	}

	// The library's own change shows at once.
	f.save(t, "uploaded.mp4", []byte("x"), "")
	tree, _ = f.lib.Tree()
	if _, ok := find(tree, "uploaded.mp4"); !ok {
		t.Fatal("an upload did not show at once")
	}
}

func TestInfo(t *testing.T) {
	f := newFixture(t, nil)
	f.write(t, "sub/clip.mp4", "x")
	f.probes.set("clip.mp4", h264())
	info, err := f.lib.Info(t.Context(), "./sub//clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "clip.mp4" || info.Path != "sub/clip.mp4" || info.Probe.Codec != media.CodecH264 ||
		info.Probe.DurationMS != 1000 || !info.Probe.Streamable {
		t.Fatalf("Info = %+v", info)
	}
	// The answer is kept: the tree has it without another probe.
	calls := f.probes.count()
	tree, _ := f.lib.Tree()
	if e, _ := find(tree, "sub/clip.mp4"); e.Probe == nil || f.probes.count() != calls {
		t.Fatalf("the tree after Info: %+v, %d more probes", e, f.probes.count()-calls)
	}
	for rel, want := range map[string]string{"missing.mp4": CodeNotFound, "sub": CodeNotFound,
		"../x": CodeInvalidPath, ".staging-1/x": CodeInvalidPath} {
		if _, err := f.lib.Info(t.Context(), rel); code(err) != want {
			t.Errorf("Info(%q) = %v, want %s", rel, err, want)
		}
	}
}

func TestStreamableFilesAreInPathOrder(t *testing.T) {
	f := newFixture(t, nil)
	f.write(t, "b.mp4", "x")
	f.write(t, "a/z.mp4", "x")
	f.write(t, "a/notes.txt", "x")
	f.write(t, "a/vp9.webm", "x")
	f.write(t, "A.mp4", "x")
	for _, name := range []string{"b.mp4", "z.mp4", "A.mp4"} {
		f.probes.set(name, h264())
	}
	f.probes.set("vp9.webm", media.Info{Kind: media.KindVideo, Codec: "vp9", CodecName: "vp9"})
	probedTree(t, f.lib, "b.mp4", "a/z.mp4", "a/notes.txt", "a/vp9.webm", "A.mp4")

	paths, err := f.lib.StreamableFiles()
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"A.mp4", "a/z.mp4", "b.mp4"}; !slices.Equal(paths, want) {
		t.Fatalf("%q, want %q", paths, want)
	}
}
