package media

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
)

// ErrInvalidPath is the error of every library path Resolve refuses.
var ErrInvalidPath = errors.New("invalid library path")

// Resolve turns a library path from the UI into the file's path under root, or refuses it with
// ErrInvalidPath: an absolute path, a ".." component, a NUL, a hidden entry, the media folder
// itself, or a path that leads out of the media folder through a symbolic link. The path need
// not exist (an upload's target), but as far as it exists every link on it is followed, and
// must stay inside.
//
// The result is root joined with the cleaned path, not the link's target, so a link stays a
// link for whoever removes or replaces it.
func Resolve(root, rel string) (string, error) {
	clean, err := cleanPath(rel)
	if err != nil {
		return "", err
	}
	root = filepath.Clean(root)
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolving the media folder: %w", err)
	}
	full := filepath.Join(root, clean)

	// The longest part of the path that exists; what lies beyond it cannot be a link yet.
	existing := full
	for existing != root {
		_, err := os.Lstat(existing)
		if err == nil {
			break
		}
		if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, syscall.ENOTDIR) {
			return "", fmt.Errorf("checking %s: %w", rel, err)
		}
		existing = filepath.Dir(existing)
	}
	real, err := filepath.EvalSymlinks(existing)
	if err != nil {
		// A link whose target is missing or loops: where it would lead cannot be checked.
		return "", fmt.Errorf("%w: %s leads through a link that cannot be followed", ErrInvalidPath, rel)
	}
	if !within(realRoot, real) || (existing == full && real == realRoot) {
		return "", fmt.Errorf("%w: %s leads out of the media folder", ErrInvalidPath, rel)
	}
	return full, nil
}

// ResolveEntry is Resolve for a path whose last entry is acted on itself, removed or replaced,
// rather than read through: the path is checked as Resolve checks it, and every link before
// the last entry must stay inside the media folder, but the entry may be a link that leads
// anywhere or nowhere, since removing or replacing a link never touches its target.
func ResolveEntry(root, rel string) (string, error) {
	clean, err := cleanPath(rel)
	if err != nil {
		return "", err
	}
	if dir := path.Dir(clean); dir != "." {
		if _, err := Resolve(root, dir); err != nil {
			return "", err
		}
	}
	return filepath.Join(filepath.Clean(root), filepath.FromSlash(clean)), nil
}

// cleanPath checks a library path's text and returns it without empty and "." components.
func cleanPath(rel string) (string, error) {
	if strings.ContainsRune(rel, 0) {
		return "", fmt.Errorf("%w: %q contains a NUL", ErrInvalidPath, rel)
	}
	if strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("%w: %s is absolute", ErrInvalidPath, rel)
	}
	var kept []string
	for _, part := range strings.Split(rel, "/") {
		switch {
		case part == "" || part == ".":
			continue
		case part == "..":
			return "", fmt.Errorf("%w: %s goes up a folder", ErrInvalidPath, rel)
		case hidden(part):
			return "", fmt.Errorf("%w: %s names a hidden entry", ErrInvalidPath, rel)
		}
		kept = append(kept, part)
	}
	if len(kept) == 0 {
		return "", fmt.Errorf("%w: %q names the media folder itself", ErrInvalidPath, rel)
	}
	return strings.Join(kept, "/"), nil
}

// within says whether path is dir or lies below it; both are cleaned, symlink-free paths.
func within(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}
