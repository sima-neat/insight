package media

import "syscall"

// FreeSpaceMargin is the room a write into the media folder leaves on its disk beside what it
// expects to write: an upload, a re-encode, a rendition.
const FreeSpaceMargin = 1 << 30

// FreeBytes is what this user may still write on the file system that holds dir; false when the
// file system does not say.
func FreeBytes(dir string) (int64, bool) {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(dir, &fs); err != nil {
		return 0, false
	}
	return int64(fs.Bavail) * int64(fs.Bsize), true // Bsize is int64 on Linux, uint32 on macOS
}
