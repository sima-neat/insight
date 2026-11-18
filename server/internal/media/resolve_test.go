package media

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// libraryWithLinks lays out a media folder beside an outside folder, with links of every kind.
func libraryWithLinks(t *testing.T) (root, outside string) {
	t.Helper()
	dir := t.TempDir()
	root = filepath.Join(dir, "media")
	outside = filepath.Join(dir, "outside")
	writeFile(t, root, "clip.mp4", "x")
	writeFile(t, root, "sub/deep.mp4", "x")
	writeFile(t, outside, "secret.mp4", "x")
	writeFile(t, dir, "media-other/sibling.mp4", "x")
	symlink(t, "clip.mp4", filepath.Join(root, "link-in.mp4"))
	symlink(t, "sub", filepath.Join(root, "link-sub"))
	symlink(t, filepath.Join(outside, "secret.mp4"), filepath.Join(root, "link-out.mp4"))
	symlink(t, outside, filepath.Join(root, "link-out-dir"))
	symlink(t, "../media-other", filepath.Join(root, "link-sibling"))
	symlink(t, "missing.mp4", filepath.Join(root, "dangling.mp4"))
	symlink(t, ".", filepath.Join(root, "self"))
	symlink(t, "loop-b", filepath.Join(root, "loop-a"))
	symlink(t, "loop-a", filepath.Join(root, "loop-b"))
	return root, outside
}

func TestResolve(t *testing.T) {
	root, _ := libraryWithLinks(t)
	tests := []struct {
		rel  string
		want string // the path below root; "" when Resolve must refuse it
	}{
		{"clip.mp4", "clip.mp4"},
		{"sub/deep.mp4", "sub/deep.mp4"},
		{"./sub//deep.mp4", "sub/deep.mp4"},
		{"sub/", "sub"},
		{"new.mp4", "new.mp4"},
		{"new/folder/clip.mp4", "new/folder/clip.mp4"},
		{"clip.mp4/below", "clip.mp4/below"},
		{"link-in.mp4", "link-in.mp4"},
		{"link-sub/deep.mp4", "link-sub/deep.mp4"},
		{"link-sub/new.mp4", "link-sub/new.mp4"},

		{"", ""},
		{".", ""},
		{"/", ""},
		{"/etc/passwd", ""},
		{"../outside/secret.mp4", ""},
		{"sub/../clip.mp4", ""},
		{"sub/../../outside/secret.mp4", ""},
		{"clip\x00.mp4", ""},
		{".renditions/clip.mp4", ""},
		{"sub/.upload-1", ""},
		{"__MACOSX/clip.mp4", ""},
		{"link-out.mp4", ""},
		{"link-out-dir", ""},
		{"link-out-dir/secret.mp4", ""},
		{"link-out-dir/new.mp4", ""},
		{"link-sibling/sibling.mp4", ""},
		{"dangling.mp4", ""},
		{"self", ""},
		{"self/clip.mp4", "self/clip.mp4"},
		{"loop-a", ""},
	}
	for _, test := range tests {
		t.Run(test.rel, func(t *testing.T) {
			got, err := Resolve(root, test.rel)
			if test.want == "" {
				if !errors.Is(err, ErrInvalidPath) {
					t.Fatalf("Resolve(%q) = %q, %v; want ErrInvalidPath", test.rel, got, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resolve(%q): %v", test.rel, err)
			}
			if want := filepath.Join(root, test.want); got != want {
				t.Fatalf("Resolve(%q) = %s, want %s", test.rel, got, want)
			}
		})
	}
}

// On a board the media folder sits in a data folder that is a link to the NVMe drive.
func TestResolveUnderALinkedRoot(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "nvme", "media")
	writeFile(t, real, "clip.mp4", "x")
	linked := filepath.Join(dir, "home", "neat-insight")
	symlink(t, filepath.Join(dir, "nvme"), linked)
	root := filepath.Join(linked, "media")

	got, err := Resolve(root, "clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "clip.mp4"); got != want {
		t.Fatalf("Resolve = %s, want %s", got, want)
	}
	if _, err := Resolve(root, "../../nvme/media/clip.mp4"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("a path up and out was accepted: %v", err)
	}
}

func TestResolveWithoutARoot(t *testing.T) {
	_, err := Resolve(filepath.Join(t.TempDir(), "missing"), "clip.mp4")
	if err == nil || errors.Is(err, ErrInvalidPath) {
		t.Fatalf("a missing media folder gave %v, want an error that is not ErrInvalidPath", err)
	}
}

func TestResolveLeavesALinkALink(t *testing.T) {
	root, _ := libraryWithLinks(t)
	got, err := Resolve(root, "link-in.mp4")
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(got)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("Resolve returned the link's target, not the link")
	}
}

func TestResolveEntry(t *testing.T) {
	root, _ := libraryWithLinks(t)
	tests := []struct {
		rel  string
		want string // the path below root; "" when ResolveEntry must refuse it
	}{
		{"clip.mp4", "clip.mp4"},
		{"./sub//deep.mp4", "sub/deep.mp4"},
		{"sub", "sub"},
		{"new.mp4", "new.mp4"},
		{"link-sub/deep.mp4", "link-sub/deep.mp4"},
		// The entry itself may lead anywhere: removing or replacing it touches only the link.
		{"link-out.mp4", "link-out.mp4"},
		{"link-out-dir", "link-out-dir"},
		{"dangling.mp4", "dangling.mp4"},
		{"loop-a", "loop-a"},
		{"self", "self"},

		{"", ""},
		{".", ""},
		{"/", ""},
		{"/etc/passwd", ""},
		{"..", ""},
		{"../outside/secret.mp4", ""},
		{"sub/../clip.mp4", ""},
		{"clip\x00.mp4", ""},
		{".renditions", ""},
		{"sub/.upload-1", ""},
		{"__MACOSX", ""},
		// What lies before the entry must stay inside.
		{"link-out-dir/secret.mp4", ""},
		{"link-sibling/sibling.mp4", ""},
		{"loop-a/clip.mp4", ""},
	}
	for _, test := range tests {
		t.Run(test.rel, func(t *testing.T) {
			got, err := ResolveEntry(root, test.rel)
			if test.want == "" {
				if !errors.Is(err, ErrInvalidPath) {
					t.Fatalf("ResolveEntry(%q) = %q, %v; want ErrInvalidPath", test.rel, got, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveEntry(%q): %v", test.rel, err)
			}
			if want := filepath.Join(root, test.want); got != want {
				t.Fatalf("ResolveEntry(%q) = %s, want %s", test.rel, got, want)
			}
		})
	}
}
