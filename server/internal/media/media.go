// Package media is the media library: the folder of videos and pictures the Media page shows and
// the slots stream from, the tree of its files, the library paths the UI names them by, and what
// ffprobe says about each file.
//
// A library path is relative to the media folder and uses "/" (sub/clip.mp4). Hidden entries
// (a leading dot, which is where uploads are staged and renditions kept) and macOS archive
// metadata (__MACOSX) are not part of the library: the tree leaves them out and Resolve refuses
// them.
package media

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"insight/internal/config"
)

// sdkMediaFolder is the media folder's name inside the SDK's workspace, which the SDK keeps
// across container rebuilds; Insight's data folder there is not kept.
const sdkMediaFolder = ".insight-media"

// Root resolves the media folder and creates it. In the SDK it is <workspace>/.insight-media
// when the workspace is a folder Insight may write to, so the library outlives the container;
// everywhere else, and in an SDK without a usable workspace, it is <dataDir>/media.
func Root(place config.Place, dataDir, workspace string) (string, error) {
	dir := filepath.Join(dataDir, "media")
	if place == config.SDK {
		if err := usableWorkspace(workspace); err != nil {
			slog.Warn("the media library will not outlive the container", "reason", err)
		} else {
			dir = filepath.Join(workspace, sdkMediaFolder)
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("creating the media folder: %w", err)
	}
	return dir, nil
}

// From unistd.h; package syscall does not name them.
const (
	accessWrite   = 0x2 // W_OK
	accessExecute = 0x1 // X_OK
)

func usableWorkspace(workspace string) error {
	info, err := os.Stat(workspace)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("the SDK workspace %s does not exist", workspace)
		}
		return fmt.Errorf("checking the SDK workspace: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("the SDK workspace %s is not a folder", workspace)
	}
	if err := syscall.Access(workspace, accessWrite|accessExecute); err != nil {
		return fmt.Errorf("the SDK workspace %s is not writable: %w", workspace, err)
	}
	return nil
}

// hidden says whether an entry's name keeps it out of the library.
func hidden(name string) bool {
	return strings.HasPrefix(name, ".") || name == "__MACOSX"
}
