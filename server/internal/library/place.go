package library

import (
	"context"
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
	"time"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/media"
)

// ConflictMode says what an upload does when its name is taken.
type ConflictMode string

const (
	// Ask refuses the upload with name_taken and a suggested free name; nothing is saved.
	Ask ConflictMode = "ask"
	// KeepBoth saves under the first free name: clip_2.mp4, a folder clips_2.
	KeepBoth ConflictMode = "keep_both"
	// Replace puts the upload in the place of what has its name: a file of a file, an
	// archive's folder of a folder.
	Replace ConflictMode = "replace"
)

// Saved is a file or folder that joined the library.
type Saved struct {
	// Path is its library path.
	Path   string `json:"path"`
	Folder bool   `json:"folder,omitempty"`
	// Reencoded are the library paths of the files that were re-encoded before they were saved.
	Reencoded []string `json:"reencoded,omitempty"`
	// Restarted are the slots that streamed what it replaced and were restarted on it.
	Restarted []int `json:"restarted,omitempty"`
	// Unassigned are the slots whose file a replaced folder no longer has.
	Unassigned []int `json:"unassigned,omitempty"`
	// Warnings are what went wrong without failing: a slot that could not restart, a re-encode
	// that failed, so the file was saved as it came.
	Warnings []string `json:"warnings,omitempty"`
}

// restartTimeout bounds the restart of the slots that streamed a replaced file. The restart
// does not end with the request or job that replaced it: a slot left stopped halfway would be
// worse than a slow answer.
const restartTimeout = 30 * time.Second

// maxUnique is how many numbered names (name_2 to name_999) a clash tries.
const maxUnique = 999

// checkTarget checks, before an upload's work starts, that the library path rel may take it:
// a taken name is name_taken with Ask, and must hold what replaces it with Replace. place checks
// again when it moves the work in.
func (l *Library) checkTarget(rel string, mode ConflictMode, folder bool) error {
	abs, err := media.ResolveEntry(l.root, rel)
	if err != nil {
		return pathError(rel, err)
	}
	info, err := os.Lstat(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	switch mode {
	case Replace:
		return kindMismatch(rel, info.IsDir(), folder)
	case KeepBoth:
		return nil
	}
	return l.nameTaken(abs, folder, "")
}

func kindMismatch(rel string, existingFolder, folder bool) error {
	switch {
	case existingFolder && !folder:
		return invalidRequest("%s is a folder; only an archive can replace it.", rel)
	case !existingFolder && folder:
		return invalidRequest("%s is a file; an archive's folder cannot replace it.", rel)
	}
	return nil
}

// nameTaken is the name_taken error for abs, with the free name Keep both would take.
func (l *Library) nameTaken(abs string, folder bool, meanwhile string) error {
	rel := l.libraryPath(abs)
	suggested := ""
	for i := 2; i <= maxUnique; i++ {
		candidate := numbered(abs, i, folder)
		if _, err := os.Lstat(candidate); errors.Is(err, fs.ErrNotExist) {
			suggested = l.libraryPath(candidate)
			break
		}
	}
	return &apierr.Error{
		Status: http.StatusConflict, Code: CodeNameTaken,
		Message:  fmt.Sprintf("%s already exists%s.", rel, meanwhile),
		Hint:     "Replace it, or keep both under another name.",
		Conflict: &api.MediaConflict{Existing: rel, Suggested: suggested},
	}
}

// numbered is abs with _i before its extension (a folder's whole name): clip_2.mp4, clips_2.
func numbered(abs string, i int, folder bool) string {
	dir, name := filepath.Split(abs)
	ext := ""
	if !folder {
		ext = filepath.Ext(name)
	}
	return filepath.Join(dir, fmt.Sprintf("%s_%d%s", strings.TrimSuffix(name, ext), i, ext))
}

// place moves src, a file or folder in stage, into the library at rel by mode, and restarts
// or unassigns the slots that used what it replaced. Unless it replaces, it never overwrites:
// a name that was taken meanwhile is name_taken with Ask, and the next free one with KeepBoth.
func (l *Library) place(ctx context.Context, src, rel string, folder bool, mode ConflictMode, stage string) (*Saved, error) {
	abs, err := media.ResolveEntry(l.root, rel)
	if err != nil {
		return nil, pathError(rel, err)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, saveError("making the folder for "+rel, err)
	}
	defer l.changed()

	var previous string // a replaced folder, moved into the stage
	replaced := false
	switch mode {
	case Replace:
		info, err := os.Lstat(abs)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			err = moveNew(src, abs, folder)
		case err != nil:
		default:
			if err = kindMismatch(rel, info.IsDir(), folder); err != nil {
				return nil, err
			}
			replaced = true
			if folder {
				previous = filepath.Join(stage, "previous")
				err = swapFolder(l.root, src, abs, previous)
			} else if err = checkRemoval(l.root, abs); err == nil {
				err = os.Rename(src, abs) // atomic: a slot reading the old file reads it to its end
			}
		}
		if err != nil {
			return nil, saveError("saving "+rel, err)
		}
	case KeepBoth:
		if abs, err = moveUnique(src, abs, folder); err != nil {
			return nil, saveError("saving "+rel, err)
		}
	default:
		err := moveNew(src, abs, folder)
		if errors.Is(err, fs.ErrExist) {
			return nil, l.nameTaken(abs, folder, " (it was added meanwhile)")
		}
		if err != nil {
			return nil, saveError("saving "+rel, err)
		}
	}

	saved := &Saved{Path: l.libraryPath(abs), Folder: folder}
	l.want(abs, folder)
	if replaced {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), restartTimeout)
		defer cancel()
		l.replacedSlots(ctx, saved, abs, previous)
	}
	return saved, nil
}

// replacedSlots restarts the slots that used a replaced file on its new content and, for a
// replaced folder, unassigns the slots whose file the new folder lacks.
func (l *Library) replacedSlots(ctx context.Context, saved *Saved, abs, previous string) {
	kept := []string{saved.Path}
	var gone []string
	if previous != "" {
		now := filesBelow(abs, saved.Path)
		kept = kept[:0]
		for _, file := range filesBelow(previous, saved.Path) {
			if slices.Contains(now, file) {
				kept = append(kept, file)
			} else {
				gone = append(gone, file)
			}
		}
	}
	if slots := l.slotsUsing(gone); len(slots) > 0 {
		l.files.Unassign(slots)
		saved.Unassigned = slots
	}
	slots := l.slotsUsing(kept)
	if len(slots) == 0 {
		return
	}
	errs := l.files.Restart(ctx, slots)
	for i, n := range slots {
		if i < len(errs) && errs[i] != nil {
			saved.Warnings = append(saved.Warnings, fmt.Sprintf("Could not restart src%d: %v", n, errs[i]))
		} else {
			saved.Restarted = append(saved.Restarted, n)
		}
	}
}

// slotsUsing are the slots that use any of the files, sorted, each once.
func (l *Library) slotsUsing(files []string) []int {
	var slots []int
	for _, file := range files {
		slots = append(slots, l.files.SlotsUsing(file)...)
	}
	slices.Sort(slots)
	return slices.Compact(slots)
}

// filesBelow are the library paths of the files below the folder dir, named as below the
// library path rel.
func filesBelow(dir, rel string) []string {
	var files []string
	_ = filepath.WalkDir(dir, func(p string, entry fs.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			if below, err := filepath.Rel(dir, p); err == nil {
				files = append(files, path.Join(rel, filepath.ToSlash(below)))
			}
		}
		return nil
	})
	return files
}

// want queues probes of the file at abs, or of the files below the folder.
func (l *Library) want(abs string, folder bool) {
	if !folder {
		l.cache.Want(abs)
		return
	}
	_ = filepath.WalkDir(abs, func(p string, entry fs.DirEntry, err error) error {
		if err == nil && entry.Type().IsRegular() {
			l.cache.Want(p)
		}
		return nil
	})
}

// moveNew moves src to dst only if dst does not exist, fs.ErrExist if it does, so a name another
// upload took in between is never overwritten. A file's dst is reserved with an exclusive create
// and src renamed over the reservation. A folder needs none: os.Rename refuses a folder that
// exists, and the system refuses to rename a folder over a file.
func moveNew(src, dst string, folder bool) error {
	if folder {
		err := os.Rename(src, dst)
		if errors.Is(err, syscall.ENOTDIR) {
			return fmt.Errorf("%w: %s is a file", fs.ErrExist, dst)
		}
		return err
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		_ = os.Remove(dst) // the empty reservation this call made a moment ago
		return err
	}
	return nil
}

// moveUnique moves src to dst, or to the first free numbered name beside it, and returns where.
func moveUnique(src, dst string, folder bool) (string, error) {
	candidate := dst
	for i := 2; ; i++ {
		err := moveNew(src, candidate, folder)
		if !errors.Is(err, fs.ErrExist) {
			return candidate, err
		}
		if i > maxUnique {
			return "", fmt.Errorf("no free name like %s", filepath.Base(dst))
		}
		candidate = numbered(dst, i, folder)
	}
}

// swapFolder puts the folder src in the place of the folder dst, which moves to previous; if
// the second rename fails, dst is put back.
func swapFolder(root, src, dst, previous string) error {
	if err := checkRemoval(root, dst); err != nil {
		return err
	}
	if err := os.Rename(dst, previous); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		if back := os.Rename(previous, dst); back != nil {
			return fmt.Errorf("%w (and the old folder could not be put back: %v)", err, back)
		}
		return err
	}
	return nil
}
