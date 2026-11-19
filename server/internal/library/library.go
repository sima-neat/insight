// Package library is what the Media page does with the media library: list it with what probing
// said about each file, inspect, serve and preview a file, delete, upload (files and archives,
// re-encoded when the board would stream them badly) and import from the published catalog.
//
// Paths are library paths (internal/media): relative to the media folder, with "/". Every path
// from outside goes through media.Resolve (to read) or media.ResolveEntry (to remove or
// replace), so nothing outside the media folder, the folder itself or a hidden entry is touched.
//
// Work in progress lives in hidden staging folders (.staging-*) in the media folder, on its
// filesystem, so that moving a finished file or folder in is one rename. They are swept when the
// library is made, which removes what a killed run left.
package library

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/relay"
	"insight/internal/supervisor"
)

// FileUser is what the library needs of the slots: which slots use a library file, and how to
// restart or unassign them when the file is replaced or gone. The slots implement it.
type FileUser interface {
	// SlotsUsing returns the slots (their numbers, srcN's N) that use the file at the library
	// path. The library refuses to delete a file it names, and restarts or unassigns them when
	// an upload replaces the file.
	SlotsUsing(path string) []int
	// Restart starts the slots again on their file's new content. It returns one error per
	// slot, in order, nil where the slot restarted.
	Restart(ctx context.Context, slots []int) []error
	// Unassign stops the slots and clears their file.
	Unassign(slots []int)
}

// The kinds of job the library submits.
const (
	// KindUpload re-encodes an upload the board would stream badly, then saves it.
	KindUpload jobs.Kind = "upload"
	// KindCatalogImport downloads a catalog asset into the library.
	KindCatalogImport jobs.Kind = "catalog_import"
)

// JobLimits are how many of the library's jobs of each kind run at once, for jobs.New: one
// re-encode (it takes every core a board has) and two downloads.
func JobLimits() map[jobs.Kind]int {
	return map[jobs.Kind]int{KindUpload: 1, KindCatalogImport: 2}
}

// The catalog Insight imports from unless told otherwise.
const (
	DefaultCatalogIndexURL = "https://artifacts.neat.sima.ai/media-assets/index.json"
	DefaultCatalogBaseURL  = "https://artifacts.neat.sima.ai/media-assets/"
)

// DefaultMaxUploadBytes bounds an upload, and what an uploaded archive unpacks to.
const DefaultMaxUploadBytes int64 = 8 << 30

// Options configure a Library.
type Options struct {
	// Root is the media folder (media.Root).
	Root string
	// Cache keeps what probing says about the library's files.
	Cache *media.Cache
	// FFmpeg and FFprobe are the tools' paths, "" when they are not installed.
	FFmpeg, FFprobe string
	// Start runs the re-encodes (Supervisor.Starter).
	Start supervisor.Starter
	// Probe probes an upload before it joins the library; nil probes with FFprobe.
	Probe media.Prober
	// Keyframes measures how far apart an upload's keyframes are; nil measures with FFprobe.
	Keyframes KeyframeProber
	// Jobs runs re-encodes and catalog downloads; its limits should include JobLimits.
	Jobs *jobs.Runner
	// Relays serve file previews. Their Start must hand a key with PreviewKeyPrefix to
	// PreviewCommand.
	Relays *relay.Relays
	// Files are the slots.
	Files FileUser
	// CatalogIndexURL and CatalogBaseURL are where the catalog is published; "" takes the
	// defaults.
	CatalogIndexURL, CatalogBaseURL string
	// Client fetches the catalog and its assets; nil takes http.DefaultClient.
	Client *http.Client
	// MaxUploadBytes bounds an upload; 0 takes DefaultMaxUploadBytes.
	MaxUploadBytes int64
}

// treeMaxAge is how long a walk of the media folder answers Tree before it is walked again;
// the library's own changes walk it again at once. Files copied in by other means show within it.
const treeMaxAge = 3 * time.Second

// Library is the media library's operations. It is safe for concurrent use.
type Library struct {
	root      string
	cache     *media.Cache
	ffmpeg    string
	start     supervisor.Starter
	probe     media.Prober
	keyframes KeyframeProber
	jobs      *jobs.Runner
	relays    *relay.Relays
	files     FileUser
	client    *http.Client
	indexURL  string
	baseURL   string
	maxUpload int64
	now       func() time.Time
	// remove removes a library entry; tests replace it to see what would be removed.
	remove func(root, abs string, folder bool) error

	mu        sync.Mutex
	scan      *scanned // nil when it must be walked again
	catalog   *Catalog
	catalogAt time.Time
}

// New makes the library and sweeps the staging folders a previous run left.
func New(opts Options) (*Library, error) {
	switch {
	case opts.Root == "":
		return nil, errors.New("library: Root is required")
	case opts.Cache == nil || opts.Jobs == nil || opts.Files == nil || opts.Start == nil:
		return nil, errors.New("library: Cache, Jobs, Files and Start are required")
	}
	l := &Library{
		root:      filepath.Clean(opts.Root),
		cache:     opts.Cache,
		ffmpeg:    opts.FFmpeg,
		start:     opts.Start,
		probe:     opts.Probe,
		keyframes: opts.Keyframes,
		jobs:      opts.Jobs,
		relays:    opts.Relays,
		files:     opts.Files,
		client:    opts.Client,
		indexURL:  cmp.Or(opts.CatalogIndexURL, DefaultCatalogIndexURL),
		baseURL:   strings.TrimSuffix(cmp.Or(opts.CatalogBaseURL, DefaultCatalogBaseURL), "/") + "/",
		maxUpload: opts.MaxUploadBytes,
		now:       time.Now,
		remove:    removeEntry,
	}
	if l.probe == nil {
		l.probe = media.FFprobe(opts.FFprobe)
	}
	if l.keyframes == nil {
		l.keyframes = FFprobeKeyframes(opts.FFprobe)
	}
	if l.client == nil {
		l.client = http.DefaultClient
	}
	if l.maxUpload <= 0 {
		l.maxUpload = DefaultMaxUploadBytes
	}
	if err := sweepStages(l.root); err != nil {
		return nil, err
	}
	return l, nil
}

// changed makes the next Tree walk the media folder again.
func (l *Library) changed() {
	l.mu.Lock()
	l.scan = nil
	l.mu.Unlock()
}

// libraryPath is the library path of abs, a path below the media folder.
func (l *Library) libraryPath(abs string) string {
	rel, err := filepath.Rel(l.root, abs)
	if err != nil {
		return filepath.ToSlash(abs) // cannot happen for a path made from the root
	}
	return filepath.ToSlash(rel)
}

// abs is the path below the media folder of a library path that was checked already.
func (l *Library) abs(rel string) string {
	return filepath.Join(l.root, filepath.FromSlash(rel))
}

// stagePrefix starts the name of every staging folder.
const stagePrefix = ".staging-"

// newStage makes a staging folder in the media folder.
func (l *Library) newStage() (string, error) {
	dir, err := os.MkdirTemp(l.root, stagePrefix)
	if err != nil {
		return "", saveError("preparing the upload", err)
	}
	return dir, nil
}

// removeStage removes a staging folder newStage made, and nothing else.
func (l *Library) removeStage(dir string) {
	if err := checkStage(l.root, dir); err != nil {
		slog.Error("refused to remove a staging folder", "error", err)
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		slog.Warn("a staging folder could not be removed", "folder", dir, "error", err)
	}
}

// checkStage refuses any path that is not a staging folder's: a folder named with stagePrefix
// and more, directly in the media folder.
func checkStage(root, dir string) error {
	root = filepath.Clean(root)
	name := filepath.Base(dir)
	if !filepath.IsAbs(root) || filepath.Clean(dir) != dir || filepath.Dir(dir) != root ||
		!strings.HasPrefix(name, stagePrefix) || len(name) == len(stagePrefix) {
		return fmt.Errorf("%s is not a staging folder of %s", dir, root)
	}
	return nil
}

// sweepStages removes the staging folders in the media folder; a link with their name is left.
func sweepStages(root string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("reading the media folder: %w", err)
	}
	for _, entry := range entries {
		dir := filepath.Join(root, entry.Name())
		if !entry.IsDir() || checkStage(root, dir) != nil {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			slog.Warn("a stale staging folder could not be removed", "folder", dir, "error", err)
		}
	}
	return nil
}
