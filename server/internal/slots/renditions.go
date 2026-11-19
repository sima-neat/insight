package slots

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"insight/internal/apierr"
	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/supervisor"
)

// A rendition is a copy of a library file encoded at another constant frame rate (media.Encode),
// so that a slot with an FPS override still streams with stream copy. Renditions are kept in the media folder's
// hidden .renditions folder, one file each, named after what they are of:
//
//	<stem>_<path hash>_<version hash>_<fps>fps_<codec>.mp4
//
// The path hash is of the file's library path and the version hash of its size and modification
// time, so a file that is replaced gets new renditions and its old ones can be told stale without
// any index. An encode writes ".<name>.tmp" beside them and renames it into place when done.

const renditionsDir = ".renditions"

// renditionFile matches the names of the renditions Insight makes, and nothing else in the
// folder: only such files are ever removed.
var renditionFile = regexp.MustCompile(`^[A-Za-z0-9._-]+_([0-9a-f]{16})_([0-9a-f]{16})_[1-9][0-9]*fps_(h264|h265)\.mp4$`)

// renditionTemp matches an encode's unfinished output.
var renditionTemp = regexp.MustCompile(`^\.([A-Za-z0-9._-]+_[0-9a-f]{16}_[0-9a-f]{16}_[1-9][0-9]*fps_(h264|h265)\.mp4)\.tmp$`)

// freeSpaceMargin is the room an encode leaves on the disk beside its expected size.
const freeSpaceMargin = 1 << 30

// rendition is one rendition of a library file.
type rendition struct {
	source   string // the library path
	abs      string // the source's absolute path
	stamp    stamp
	fps      int
	codec    string
	width    int
	height   int
	duration time.Duration
	name     string // the file name in .renditions
	out      string // its absolute path
}

func (r rendition) rel() string { return renditionsDir + "/" + r.name }

// renditionOf is the rendition of the library file source (at abs, in its version st, probed
// as info) at fps; an error when it cannot have one.
func (m *Manager) renditionOf(source, abs string, st stamp, info media.Info, fps int) (rendition, error) {
	if err := checkRendition(source, info, fps); err != nil {
		return rendition{}, err
	}
	name := renditionName(source, st, fps, info.Codec)
	return rendition{
		source: source, abs: abs, stamp: st, fps: fps, codec: info.Codec,
		width: info.Width, height: info.Height, duration: info.Duration,
		name: name, out: filepath.Join(m.root, renditionsDir, name),
	}, nil
}

// checkRendition refuses an FPS override the file cannot have.
func checkRendition(source string, info media.Info, fps int) error {
	switch {
	case info.Codec == media.CodecMJPEG:
		return newError(http.StatusBadRequest, CodeFPSNotSupported, "An MJPEG file plays at its own frame rate; %s cannot change it.", source)
	case info.Codec != media.CodecH264 && info.Codec != media.CodecH265:
		return notStreamable(source, info)
	case info.Width <= 0 || info.Height <= 0:
		return newError(http.StatusBadRequest, CodeFPSNotSupported, "The size of %s is unknown, so it cannot change its frame rate.", source)
	}
	return nil
}

func renditionName(source string, st stamp, fps int, codec string) string {
	base := path.Base(source)
	stem := strings.TrimSuffix(base, path.Ext(base))
	return fmt.Sprintf("%s_%s_%s_%dfps_%s.mp4", safeStem(stem), shortHash(source), st.hash(), fps, codec)
}

// hash is the version hash of a rendition's name.
func (st stamp) hash() string { return shortHash(fmt.Sprintf("%d:%d", st.size, st.mtime)) }

// safeStem keeps a file name's stem readable in a rendition's name: letters, digits, '.', '-'
// and '_', at most 48 of them, never empty or starting with a dot.
func safeStem(stem string) string {
	var b strings.Builder
	for _, r := range stem {
		if b.Len() >= 48 {
			break
		}
		if r < 0x80 && (r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-' || r == '_') {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	out := strings.TrimLeft(b.String(), ".")
	if out == "" {
		return "video"
	}
	return out
}

func shortHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
}

// encodeJob is a rendition's running encode, which every slot that needs it waits for.
type encodeJob struct {
	job *jobs.Job
	r   rendition
}

// startEncodeLocked submits r's encode and follows it to its end; m.mu is held.
func (m *Manager) startEncodeLocked(r rendition) {
	title := fmt.Sprintf("Encode %s at %d fps", path.Base(r.source), r.fps)
	e := &encodeJob{r: r}
	e.job = m.opts.Jobs.Submit(RenditionJob, title, m.encodeWork(r))
	m.encodes[r.name] = e
	go m.finishEncode(e)
}

// releaseEncodeLocked cancels the encode of the rendition name when no slot waits for it any
// more; m.mu is held.
func (m *Manager) releaseEncodeLocked(name string) {
	e := m.encodes[name]
	if e == nil {
		return
	}
	for _, rt := range m.rt {
		if rt.rendition == name {
			return
		}
	}
	e.job.Cancel()
}

// finishEncode waits for an encode to end and tells the slots that waited for it: a done one
// lets them start, a failed one stops them trying with its error. One is cancelled only once no
// slot waits for it, or as Insight stops; a slot that wants the rendition again starts a new one.
func (m *Manager) finishEncode(e *encodeJob) {
	<-e.job.Done()
	result := e.job.Snapshot()
	var woken []int
	m.mu.Lock()
	if m.encodes[e.r.name] == e {
		delete(m.encodes, e.r.name)
	}
	for i, rt := range m.rt {
		if rt.rendition != e.r.name {
			continue
		}
		n := i + 1
		if result.State == jobs.Failed {
			rt.blocked = result.Error
		}
		rt.rendition = ""
		woken = append(woken, n)
	}
	m.mu.Unlock()
	for _, n := range woken {
		m.wake(n)
	}
	if result.State == jobs.Done && m.ctx.Err() == nil {
		if err := m.PruneRenditions(); err != nil {
			slog.Warn("pruning renditions", "error", err)
		}
	}
}

// encodeWork is the job that makes r: it checks the disk has room, encodes into a temporary
// file, and renames it into place if the source is still the version it was encoded from.
func (m *Manager) encodeWork(r rendition) jobs.Work {
	return func(ctx context.Context, progress *jobs.Progress) (any, error) {
		progress.Set(jobs.ProgressValue{Phase: "encode", Detail: encoderName(r.codec)})
		dir := filepath.Dir(r.out)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("The renditions folder could not be made: %v", err)
		}
		encode := media.Encode{Codec: r.codec, Width: r.width, Height: r.height, FPS: float64(r.fps), Resample: true}
		expected := int64(float64(media.VideoBitrate(r.width, r.height, encode.FPS)) * r.duration.Seconds() / 8)
		if err := checkFreeSpace(dir, expected); err != nil {
			return nil, err
		}
		tmp := filepath.Join(dir, "."+r.name+".tmp")
		run := encodeRun{name: "encode-" + shortHash(r.name), args: encode.Args(r.abs, tmp, "mp4"), output: tmp, duration: r.duration}
		if err := m.opts.encode(ctx, run, progress); err != nil {
			_ = os.Remove(tmp) // this encode's own output
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("Encoding %s at %d fps failed: %v", r.source, r.fps, err)
		}
		if st, ok := stampOf(r.abs); !ok || st != r.stamp {
			_ = os.Remove(tmp)
			return nil, fmt.Errorf("%s was removed or replaced while its rendition was encoded.", r.source)
		}
		if err := os.Rename(tmp, r.out); err != nil {
			_ = os.Remove(tmp)
			return nil, fmt.Errorf("The rendition could not be saved: %v", err)
		}
		return map[string]string{"rendition": r.rel()}, nil
	}
}

func encoderName(codec string) string {
	if codec == media.CodecH265 {
		return "libx265 main"
	}
	return "libx264 baseline"
}

func checkFreeSpace(dir string, expected int64) error {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(dir, &fs); err != nil {
		return nil // nothing to check against; the encode itself fails on a full disk
	}
	free := int64(fs.Bavail) * fs.Bsize
	needed := expected + freeSpaceMargin
	if free < needed {
		return fmt.Errorf("There is not enough free disk space for this rendition: it needs about %s free (%s for the file and %s to spare), and %s is free. Clear renditions or free some space, then try again.",
			formatBytes(needed), formatBytes(expected), formatBytes(freeSpaceMargin), formatBytes(free))
	}
	return nil
}

func formatBytes(n int64) string {
	switch {
	case n >= 1_000_000_000:
		return fmt.Sprintf("%.1f GB", float64(n)/1e9)
	case n >= 1_000_000:
		return fmt.Sprintf("%.1f MB", float64(n)/1e6)
	}
	return fmt.Sprintf("%.0f kB", float64(max(n, 0))/1e3)
}

// encodeRun is one encode's ffmpeg run.
type encodeRun struct {
	name     string // the child's name
	args     []string
	output   string // the file it writes
	duration time.Duration
}

// encoder runs an encode and returns once it has ended; ctx cancels it.
type encoder func(ctx context.Context, run encodeRun, progress *jobs.Progress) error

// runEncode runs ffmpeg under the supervisor, following its progress, and stops it when ctx
// ends.
func (m *Manager) runEncode(ctx context.Context, run encodeRun, progress *jobs.Progress) error {
	return jobs.RunFFmpeg(ctx, m.opts.Start, supervisor.Spec{
		Name: run.name, Path: m.opts.FFmpeg, Args: run.args, Grace: publisherGrace,
	}, run.duration, progress.Follow)
}

// RenditionUsage is what the renditions take on the disk.
type RenditionUsage struct {
	Count int   `json:"count"`
	Bytes int64 `json:"bytes"`
	// InUse counts those a slot streams or is about to.
	InUse int `json:"in_use"`
}

// RenditionsCleared is what ClearRenditions did.
type RenditionsCleared struct {
	Removed    int   `json:"removed"`
	FreedBytes int64 `json:"freed_bytes"`
	// Kept counts the renditions kept because a slot streams them or is about to.
	Kept int `json:"kept"`
}

type renditionEntry struct {
	name                string
	size                int64
	pathHash, stampHash string
}

// listRenditions lists the renditions in the media folder; none when there is no folder.
func (m *Manager) listRenditions() ([]renditionEntry, error) {
	entries, err := os.ReadDir(filepath.Join(m.root, renditionsDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading the renditions: %w", err)
	}
	var out []renditionEntry
	for _, entry := range entries {
		match := renditionFile.FindStringSubmatch(entry.Name())
		if match == nil || !entry.Type().IsRegular() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		out = append(out, renditionEntry{name: entry.Name(), size: info.Size(), pathHash: match[1], stampHash: match[2]})
	}
	return out, nil
}

// renditionsInUseLocked are the renditions a slot streams, or will stream once it starts;
// m.mu is held.
func (m *Manager) renditionsInUseLocked() map[string]bool {
	used := map[string]bool{}
	for _, rt := range m.rt {
		if name, ok := strings.CutPrefix(rt.procActive, renditionsDir+"/"); ok {
			used[name] = true
		}
		if rt.needs != "" {
			used[rt.needs] = true
		}
	}
	return used
}

// RenditionUsage counts the renditions and their bytes.
func (m *Manager) RenditionUsage() (RenditionUsage, error) {
	list, err := m.listRenditions()
	if err != nil {
		return RenditionUsage{}, &apierr.Error{Status: http.StatusInternalServerError, Code: CodeRenditionsFailed, Message: err.Error()}
	}
	m.mu.Lock()
	used := m.renditionsInUseLocked()
	m.mu.Unlock()
	var usage RenditionUsage
	for _, r := range list {
		usage.Count++
		usage.Bytes += r.size
		if used[r.name] {
			usage.InUse++
		}
	}
	return usage, nil
}

// ClearRenditions removes every rendition but those a slot streams or is about to.
func (m *Manager) ClearRenditions() (RenditionsCleared, error) {
	return m.removeRenditions(func(renditionEntry) bool { return true })
}

// PruneRenditions removes the renditions of files that are gone from the library or were
// replaced, but those a slot still streams. It runs at start and after each encode; the media
// library calls it after it deletes or replaces files.
func (m *Manager) PruneRenditions() error {
	current, err := m.libraryVersions()
	if err != nil {
		return err
	}
	_, err = m.removeRenditions(func(r renditionEntry) bool { return !current[r.pathHash][r.stampHash] })
	return err
}

// removeRenditions removes the renditions stale says to, unless one is in use.
func (m *Manager) removeRenditions(stale func(renditionEntry) bool) (RenditionsCleared, error) {
	list, err := m.listRenditions()
	if err != nil {
		return RenditionsCleared{}, &apierr.Error{Status: http.StatusInternalServerError, Code: CodeRenditionsFailed, Message: err.Error()}
	}
	m.mu.Lock()
	used := m.renditionsInUseLocked()
	m.mu.Unlock()
	var result RenditionsCleared
	var problems []error
	for _, r := range list {
		if !stale(r) {
			continue
		}
		if used[r.name] {
			result.Kept++
			continue
		}
		// The name matched renditionFile, so it is one of Insight's renditions and a plain
		// name inside the folder.
		if err := os.Remove(filepath.Join(m.root, renditionsDir, r.name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			problems = append(problems, err)
			continue
		}
		result.Removed++
		result.FreedBytes += r.size
	}
	if err := errors.Join(problems...); err != nil {
		return result, &apierr.Error{Status: http.StatusInternalServerError, Code: CodeRenditionsFailed,
			Message: fmt.Sprintf("Some renditions could not be removed: %v", err)}
	}
	return result, nil
}

// libraryVersions are the library's files, by the hash of their path, with the hashes of their
// current versions.
func (m *Manager) libraryVersions() (map[string]map[string]bool, error) {
	tree, err := media.Tree(m.root)
	if err != nil {
		return nil, err
	}
	current := map[string]map[string]bool{}
	var walk func(media.Node)
	walk = func(node media.Node) {
		for _, child := range node.Children {
			if child.Folder {
				walk(child)
				continue
			}
			abs, err := media.Resolve(m.root, child.Path)
			if err != nil {
				continue
			}
			st, ok := stampOf(abs)
			if !ok {
				continue
			}
			key := shortHash(child.Path)
			if current[key] == nil {
				current[key] = map[string]bool{}
			}
			current[key][st.hash()] = true
		}
	}
	walk(tree)
	return current, nil
}

// removeUnfinishedRenditions removes what encodes of an earlier run left unfinished; at start,
// before any encode of this run.
func (m *Manager) removeUnfinishedRenditions() {
	dir := filepath.Join(m.root, renditionsDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if renditionTemp.MatchString(entry.Name()) && entry.Type().IsRegular() {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
}
