package library

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"insight/internal/apierr"
	"insight/internal/media"
)

// checkRemoval is the last guard before anything in the media folder is removed or renamed
// over, run on the very path that is about to be: it must be clean, absolute, below root (not
// root itself), and a path media.ResolveEntry accepts and makes the same (nothing hidden, every
// link before the entry inside). A root of "/" is refused, since everything would be below it.
func checkRemoval(root, abs string) error {
	root = filepath.Clean(root)
	if !filepath.IsAbs(root) || root == "/" {
		return fmt.Errorf("refusing to remove anything: %q is no media folder", root)
	}
	if !filepath.IsAbs(abs) || filepath.Clean(abs) != abs {
		return fmt.Errorf("refusing to remove %q: not a clean absolute path", abs)
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == "." || !filepath.IsLocal(rel) {
		return fmt.Errorf("refusing to remove %s: not below the media folder", abs)
	}
	again, err := media.ResolveEntry(root, filepath.ToSlash(rel))
	if err != nil {
		return fmt.Errorf("refusing to remove %s: %w", abs, err)
	}
	if again != abs {
		return fmt.Errorf("refusing to remove %s: it resolves to %s", abs, again)
	}
	return nil
}

// removeEntry removes the library entry at abs once checkRemoval allows it: a folder with what
// it holds, a file, or a link as a link (never what it leads to; RemoveAll does not follow the
// links inside a folder either).
func removeEntry(root, abs string, folder bool) error {
	if err := checkRemoval(root, abs); err != nil {
		return err
	}
	if folder {
		return os.RemoveAll(abs)
	}
	return os.Remove(abs)
}

// Deleted is what Delete removed.
type Deleted struct {
	Paths []string `json:"paths"`
}

// removal is one entry Delete removes.
type removal struct {
	rel    string
	abs    string
	folder bool // a folder itself, not a link to one
}

// Delete removes the entries at the library paths: files, links (as links) and folders with
// what they hold. It refuses the whole request, removing nothing, when a path is not in the
// library or when a slot uses one of the files (in_use, naming the slots: they are cleared
// first). Folders left empty stay.
func (l *Library) Delete(paths []string) (Deleted, error) {
	if len(paths) == 0 {
		return Deleted{}, invalidRequest("Name at least one path to delete.")
	}
	var targets []removal
	for _, rel := range paths {
		target, err := l.removalTarget(rel)
		if err != nil {
			return Deleted{}, err
		}
		targets = append(targets, target)
	}
	targets = outermost(targets)

	var slots []int
	var used []string
	for _, target := range targets {
		for _, file := range l.filesUnder(target) {
			if users := l.files.SlotsUsing(file); len(users) > 0 {
				slots = append(slots, users...)
				used = append(used, file)
			}
		}
	}
	if len(slots) > 0 {
		slices.Sort(slots)
		slots = slices.Compact(slots)
		return Deleted{}, &apierr.Error{
			Status: http.StatusConflict, Code: CodeInUse, Slots: slots,
			Message: fmt.Sprintf("%s %s used by %s.", listText(used), isAre(len(used)), slotNames(slots)),
			Hint:    "Clear those slots, then delete again.",
		}
	}

	deleted := Deleted{Paths: []string{}}
	defer l.changed()
	for _, target := range targets {
		if err := l.remove(l.root, target.abs, target.folder); err != nil {
			return deleted, fmt.Errorf("deleting %s: %w", target.rel, err)
		}
		deleted.Paths = append(deleted.Paths, target.rel)
	}
	return deleted, nil
}

// removalTarget resolves a library path to remove: the entry itself, which must exist.
func (l *Library) removalTarget(rel string) (removal, error) {
	abs, err := media.ResolveEntry(l.root, rel)
	if err != nil {
		return removal{}, pathError(rel, err)
	}
	info, err := os.Lstat(abs)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return removal{}, notFound("There is nothing at %s in the media library.", rel)
	}
	if err != nil {
		return removal{}, err
	}
	return removal{rel: l.libraryPath(abs), abs: abs, folder: info.IsDir()}, nil
}

// outermost drops the targets named twice or lying inside a folder that is removed too.
func outermost(targets []removal) []removal {
	slices.SortFunc(targets, func(a, b removal) int { return strings.Compare(a.rel, b.rel) })
	var kept []removal
	for _, t := range targets {
		if n := len(kept); n > 0 {
			last := kept[n-1]
			if t.rel == last.rel || last.folder && strings.HasPrefix(t.rel, last.rel+"/") {
				continue
			}
		}
		kept = append(kept, t)
	}
	return kept
}

// filesUnder are the library paths a slot could use that go with the target: the target
// itself, and for a folder, or a link to a folder in the library, every entry below it.
func (l *Library) filesUnder(target removal) []string {
	dir := target.abs
	if !target.folder {
		real, err := media.Resolve(l.root, target.rel)
		info, statErr := os.Stat(real)
		if err != nil || statErr != nil || !info.IsDir() {
			return []string{target.rel}
		}
		// A link to a folder in the library: its files are named through the link too.
		if dir, err = filepath.EvalSymlinks(real); err != nil {
			return []string{target.rel}
		}
	}
	files := []string{target.rel}
	_ = filepath.WalkDir(dir, func(p string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil // what cannot be read is removed with the rest, or the removal says so
		}
		if rel, err := filepath.Rel(dir, p); err == nil {
			files = append(files, path.Join(target.rel, filepath.ToSlash(rel)))
		}
		return nil
	})
	return files
}

// slotNames writes slots as the UI names them: "src3, src9".
func slotNames(slots []int) string {
	names := make([]string, len(slots))
	for i, n := range slots {
		names[i] = fmt.Sprintf("src%d", n)
	}
	return strings.Join(names, ", ")
}

// listText writes up to three paths and how many more: "a.mp4, b.mp4 and 4 more".
func listText(paths []string) string {
	const shown = 3
	if len(paths) <= shown {
		return strings.Join(paths, ", ")
	}
	return fmt.Sprintf("%s and %d more", strings.Join(paths[:shown], ", "), len(paths)-shown)
}

func isAre(n int) string {
	if n == 1 {
		return "is"
	}
	return "are"
}
