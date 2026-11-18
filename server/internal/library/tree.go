package library

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"slices"
	"time"

	"insight/internal/media"
)

// Entry is a folder or a file of the library as the Media page lists it.
type Entry struct {
	// Name is the entry's own name; the root's is "".
	Name string `json:"name"`
	// Path is the library path; the root's is "".
	Path   string `json:"path"`
	Folder bool   `json:"folder"`
	// Children are a folder's entries, folders first; absent for a file and an empty folder.
	Children []Entry `json:"children,omitempty"`
	// Streamable says whether a slot can stream the file: from its probe when there is one,
	// else from its extension. For a folder, whether any file below it is.
	Streamable bool `json:"streamable"`
	// StreamableCount is, for a folder, the number of streamable files below it.
	StreamableCount int `json:"streamable_count,omitempty"`
	// Probe is what probing said about a file, null while it is being probed and for a file
	// that is not probed (a link that leads out of the library).
	Probe *Probe `json:"probe"`
	// Probing says that a probe of the file is queued or running.
	Probing bool `json:"probing,omitempty"`
}

// Probe is what ffprobe says about a library file (media.Info).
type Probe struct {
	Kind media.Kind `json:"kind"`
	// Codec is "h264", "h265", "mjpeg" or ffprobe's name of another codec.
	Codec string `json:"codec,omitempty"`
	// CodecName is the codec as the UI shows it ("H.264").
	CodecName   string  `json:"codec_name,omitempty"`
	Profile     string  `json:"profile,omitempty"`
	PixelFormat string  `json:"pixel_format,omitempty"`
	Width       int     `json:"width,omitempty"`
	Height      int     `json:"height,omitempty"`
	FPS         float64 `json:"fps,omitempty"`
	// FrameRate is the rate as ffprobe writes it ("30000/1001").
	FrameRate  string `json:"frame_rate,omitempty"`
	DurationMS int64  `json:"duration_ms,omitempty"`
	Size       int64  `json:"size"`
	HasBFrames bool   `json:"has_b_frames,omitempty"`
	Streamable bool   `json:"streamable"`
	// Problem says why ffprobe could not read the file.
	Problem string `json:"problem,omitempty"`
}

func probeOf(info media.Info) *Probe {
	return &Probe{
		Kind: info.Kind, Codec: info.Codec, CodecName: info.CodecName, Profile: info.Profile,
		PixelFormat: info.PixelFormat, Width: info.Width, Height: info.Height, FPS: info.FPS,
		FrameRate: info.FrameRate, DurationMS: info.Duration.Milliseconds(), Size: info.Size,
		HasBFrames: info.HasBFrames, Streamable: info.Streamable(), Problem: info.Problem,
	}
}

// scanned is one walk of the media folder.
type scanned struct {
	at   time.Time
	root scanNode
}

// scanNode is a media.Node with what probing needs: the absolute path of a file the cache may
// probe, "" for one it must not (a link that leads out of the library or nowhere).
type scanNode struct {
	node     media.Node
	abs      string
	children []scanNode
}

// Tree lists the library with each file's probe. The folder is walked again when the last walk
// is older than a few seconds, or the library changed it since; otherwise the last walk
// answers, with the probes as they are now. Files without a probe are queued for one.
func (l *Library) Tree() (Entry, error) {
	scan, err := l.scanned()
	if err != nil {
		return Entry{}, err
	}
	return l.entry(scan.root), nil
}

func (l *Library) scanned() (*scanned, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.scan != nil && l.now().Sub(l.scan.at) < treeMaxAge {
		return l.scan, nil
	}
	at := l.now()
	root, err := media.Tree(l.root)
	if err != nil {
		return nil, err
	}
	l.scan = &scanned{at: at, root: l.scanNode(root)}
	return l.scan, nil
}

func (l *Library) scanNode(node media.Node) scanNode {
	s := scanNode{node: node}
	if node.Folder {
		s.children = make([]scanNode, len(node.Children))
		for i, child := range node.Children {
			s.children[i] = l.scanNode(child)
		}
		return s
	}
	abs := l.abs(node.Path)
	info, err := os.Lstat(abs)
	switch {
	case err != nil:
	case info.Mode().IsRegular():
		s.abs = abs
	case info.Mode()&fs.ModeSymlink != 0:
		// Probed only when it leads to a file inside the library, which media.Tree has found
		// for a streamable name only; any other name is checked here.
		if node.Streamable || l.linksInside(node.Path) {
			s.abs = abs
		}
	}
	return s
}

// linksInside says whether the link at the library path rel leads to a file in the library.
func (l *Library) linksInside(rel string) bool {
	abs, err := media.Resolve(l.root, rel)
	if err != nil {
		return false
	}
	info, err := os.Stat(abs)
	return err == nil && info.Mode().IsRegular()
}

func (l *Library) entry(s scanNode) Entry {
	e := Entry{Name: s.node.Name, Path: s.node.Path, Folder: s.node.Folder}
	if s.node.Folder {
		for _, child := range s.children {
			c := l.entry(child)
			if c.Folder {
				e.StreamableCount += c.StreamableCount
			} else if c.Streamable {
				e.StreamableCount++
			}
			e.Children = append(e.Children, c)
		}
		e.Streamable = e.StreamableCount > 0
		return e
	}
	if s.abs == "" {
		return e
	}
	if info, ok := l.cache.Get(s.abs); ok {
		e.Probe = probeOf(info)
		e.Streamable = info.Streamable()
		return e
	}
	l.cache.Want(s.abs)
	e.Probing = true
	e.Streamable = s.node.Streamable
	return e
}

// FileInfo is what the Media page's panel shows about a file.
type FileInfo struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Probe Probe  `json:"probe"`
}

// Info probes the file at the library path rel, or answers from the cache when it has not
// changed since its last probe.
func (l *Library) Info(ctx context.Context, rel string) (FileInfo, error) {
	abs, err := l.existingFile(rel)
	if err != nil {
		return FileInfo{}, err
	}
	info, err := l.cache.Probe(ctx, abs)
	if errors.Is(err, fs.ErrNotExist) {
		return FileInfo{}, notFound("There is no file %s in the media library.", rel)
	}
	if err != nil {
		return FileInfo{}, err
	}
	clean := l.libraryPath(abs)
	return FileInfo{Name: path.Base(clean), Path: clean, Probe: *probeOf(info)}, nil
}

// existingFile resolves the library path rel to read it: a file (or a link to one in the
// library) that exists.
func (l *Library) existingFile(rel string) (string, error) {
	abs, err := media.Resolve(l.root, rel)
	if err != nil {
		return "", pathError(rel, err)
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return "", notFound("There is no file %s in the media library.", rel)
	}
	return abs, nil
}

// StreamableFiles lists the library paths of the files a slot can stream, as Tree judges them
// (by their probe, or by their extension while they are being probed), in path order: what
// auto-assign hands out to the slots.
func (l *Library) StreamableFiles() ([]string, error) {
	root, err := l.Tree()
	if err != nil {
		return nil, err
	}
	var paths []string
	var walk func(Entry)
	walk = func(e Entry) {
		if !e.Folder && e.Streamable {
			paths = append(paths, e.Path)
		}
		for _, child := range e.Children {
			walk(child)
		}
	}
	walk(root)
	slices.Sort(paths)
	return paths, nil
}
