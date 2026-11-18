package media

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

// outline writes a tree as one line per node, indented by depth: "/name n" for a folder with n
// streamable files, "name *" for a streamable file, "name" for another.
func outline(node Node, depth int, out *strings.Builder) {
	for _, child := range node.Children {
		indent := strings.Repeat("  ", depth)
		switch {
		case child.Folder:
			fmt.Fprintf(out, "%s/%s %d [%s]\n", indent, child.Name, child.StreamableCount, child.Path)
			outline(child, depth+1, out)
		case child.Streamable:
			fmt.Fprintf(out, "%s%s * [%s]\n", indent, child.Name, child.Path)
		default:
			fmt.Fprintf(out, "%s%s [%s]\n", indent, child.Name, child.Path)
		}
	}
}

func TestTree(t *testing.T) {
	root := filepath.Join(t.TempDir(), "media")
	outside := filepath.Join(filepath.Dir(root), "outside")
	for _, rel := range []string{
		"b.mp4", "A.MOV", "c.txt", "picture.png", "photo.JPG", "zeta/clip.mkv",
		"Alpha/one.webm", "Alpha/two.avi", "Alpha/inner/three.mjpeg", "Alpha/inner/notes.md",
		".hidden.mp4", ".renditions/r.mp4", "__MACOSX/._b.mp4", "Alpha/.upload-1/part.mp4",
		"Empty/.keep",
	} {
		writeFile(t, root, rel, "x")
	}
	writeFile(t, outside, "secret.mp4", "x")
	symlink(t, "b.mp4", filepath.Join(root, "link-in.mp4"))
	symlink(t, filepath.Join(outside, "secret.mp4"), filepath.Join(root, "link-out.mp4"))
	symlink(t, "Alpha", filepath.Join(root, "link-folder.mp4"))
	symlink(t, "missing.mp4", filepath.Join(root, "dangling.mp4"))
	symlink(t, ".", filepath.Join(root, "loop"))
	if err := syscall.Mkfifo(filepath.Join(root, "pipe.mp4"), 0o644); err != nil {
		t.Fatal(err)
	}

	tree, err := Tree(root)
	if err != nil {
		t.Fatal(err)
	}
	if !tree.Folder || tree.Name != "" || tree.Path != "" {
		t.Fatalf("root node = %+v", tree)
	}
	if tree.StreamableCount != 8 {
		t.Errorf("the root counts %d streamable files, want 8", tree.StreamableCount)
	}
	var got strings.Builder
	outline(tree, 0, &got)
	want := `/Alpha 3 [Alpha]
  /inner 1 [Alpha/inner]
    notes.md [Alpha/inner/notes.md]
    three.mjpeg * [Alpha/inner/three.mjpeg]
  one.webm * [Alpha/one.webm]
  two.avi * [Alpha/two.avi]
/Empty 0 [Empty]
/zeta 1 [zeta]
  clip.mkv * [zeta/clip.mkv]
A.MOV * [A.MOV]
b.mp4 * [b.mp4]
c.txt [c.txt]
dangling.mp4 [dangling.mp4]
link-folder.mp4 [link-folder.mp4]
link-in.mp4 * [link-in.mp4]
link-out.mp4 [link-out.mp4]
loop [loop]
photo.JPG * [photo.JPG]
picture.png [picture.png]
`
	if got.String() != want {
		t.Errorf("tree:\n%s\nwant:\n%s", got.String(), want)
	}
	empty := tree.Children[1]
	if empty.Name != "Empty" || empty.Children == nil {
		t.Errorf("an empty folder's children are %#v, want an empty list", empty.Children)
	}
}

func TestTreeOrdersNamesThatDifferOnlyInCase(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"b.mp4", "B.mp4", "a.mp4"} {
		writeFile(t, root, name, "x")
	}
	tree, err := Tree(root)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, child := range tree.Children {
		names = append(names, child.Name)
	}
	if want := []string{"a.mp4", "B.mp4", "b.mp4"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("order = %v, want %v", names, want)
	}
}

func TestTreeShowsAnUnreadableFolderEmpty(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads every folder")
	}
	root := t.TempDir()
	writeFile(t, root, "locked/clip.mp4", "x")
	writeFile(t, root, "open.mp4", "x")
	locked := filepath.Join(root, "locked")
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	tree, err := Tree(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(tree.Children) != 2 || len(tree.Children[0].Children) != 0 || tree.StreamableCount != 1 {
		t.Fatalf("tree = %+v", tree)
	}
}

func TestTreeWithoutARoot(t *testing.T) {
	if _, err := Tree(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("a missing media folder gave no error")
	}
}
