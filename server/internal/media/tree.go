package media

import (
	"cmp"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

// Node is a folder or a file of the library.
type Node struct {
	// Name is the entry's own name; the root's is "".
	Name string
	// Path is the library path (sub/clip.mp4); the root's is "".
	Path   string
	Folder bool
	// Children are a folder's entries, folders first, each group in case-insensitive order.
	// A folder that cannot be read has none.
	Children []Node
	// Streamable says whether a file's extension is one the slots stream. It is the guess the
	// tree can make without probing; the probe (Info.Streamable) has the last word.
	Streamable bool
	// StreamableCount is the number of streamable files anywhere below a folder.
	StreamableCount int
}

// streamableExtensions are the extensions of the files a slot can stream: H.264, H.265 and
// MJPEG come in these containers, and a JPEG picture streams as MJPEG.
var streamableExtensions = map[string]bool{
	".mp4": true, ".mov": true, ".avi": true, ".mkv": true, ".webm": true,
	".mjpeg": true, ".mjpg": true, ".jpg": true, ".jpeg": true,
}

// Tree walks the media folder. Symbolic links are listed as files and never walked into, so a
// link to a folder cannot make the walk loop; a link is streamable only when it leads to a
// regular file inside the media folder. Entries that are neither files, folders nor links
// (sockets, pipes, devices) are left out: they are no media, and opening a pipe would block.
func Tree(root string) (Node, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return Node{}, fmt.Errorf("reading the media folder: %w", err)
	}
	node := Node{Folder: true}
	node.Children, node.StreamableCount = children(root, "", entries)
	return node, nil
}

// children makes the nodes of the folder at the library path dir, whose entries are given.
func children(root, dir string, entries []os.DirEntry) ([]Node, int) {
	nodes := []Node{}
	count := 0
	for _, entry := range entries {
		name := entry.Name()
		if hidden(name) {
			continue
		}
		rel := path.Join(dir, name)
		node := Node{Name: name, Path: rel}
		mode := entry.Type()
		switch {
		case mode.IsDir():
			node.Folder = true
			// A folder that cannot be read is shown empty rather than failing the whole tree.
			sub, _ := os.ReadDir(filepath.Join(root, filepath.FromSlash(rel)))
			node.Children, node.StreamableCount = children(root, rel, sub)
			count += node.StreamableCount
		case mode.IsRegular():
			node.Streamable = streamableName(name)
		case mode&os.ModeSymlink != 0:
			node.Streamable = streamableName(name) && linksToFile(root, rel)
		default:
			continue
		}
		if node.Streamable {
			count++
		}
		nodes = append(nodes, node)
	}
	slices.SortFunc(nodes, func(a, b Node) int {
		if a.Folder != b.Folder {
			if a.Folder {
				return -1
			}
			return 1
		}
		return cmp.Or(
			strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)),
			strings.Compare(a.Name, b.Name),
		)
	})
	return nodes, count
}

func streamableName(name string) bool {
	return streamableExtensions[strings.ToLower(filepath.Ext(name))]
}

// linksToFile says whether the link at the library path rel leads to a regular file inside the
// media folder.
func linksToFile(root, rel string) bool {
	abs, err := Resolve(root, rel)
	if err != nil {
		return false
	}
	info, err := os.Stat(abs)
	return err == nil && info.Mode().IsRegular()
}
