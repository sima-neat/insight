package library

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"

	"insight/internal/apierr"
	"insight/internal/media"
)

// The archives an upload may be: unpacked into a folder named after the archive. A .gz is a
// gzipped tar.
var archiveSuffixes = []struct {
	suffix string
	zip    bool
}{
	{".tar.gz", false}, {".tgz", false}, {".tar", false}, {".gz", false}, {".zip", true},
}

// archiveOf says whether the upload named name is an archive, and the folder it unpacks into.
func archiveOf(name string) (folder string, isZip, ok bool) {
	lower := strings.ToLower(name)
	for _, a := range archiveSuffixes {
		if strings.HasSuffix(lower, a.suffix) && len(name) > len(a.suffix) {
			return safeName(name[:len(name)-len(a.suffix)]), a.zip, true
		}
	}
	return "", false, false
}

// maxArchiveEntries bounds the entries of an archive, folders included.
const maxArchiveEntries = 10_000

// unpacker writes an archive's entries below dest, a new folder. It never creates a link, so
// with every entry's path checked to stay below dest, no write can land outside it.
type unpacker struct {
	dest     string
	maxBytes int64
	free     int64 // free on the disk when unpacking began; math.MaxInt64 when unknown
	written  int64
	entries  int
}

// unpack unpacks the archive at archive into dest, which it creates. Links, devices and pipes
// are refused, as are entries that would land outside dest; hidden entries (a leading dot) and
// macOS metadata (__MACOSX) are skipped, since the library leaves them out anyway. What the
// archive says it holds must fit in free with media.FreeSpaceMargin to spare: a ZIP's whole
// directory before anything is written, a tar's entries one by one as their headers come.
func unpack(archive, dest string, isZip bool, maxBytes, free int64) error {
	if err := os.Mkdir(dest, 0o755); err != nil {
		return saveError("unpacking the archive", err)
	}
	u := &unpacker{dest: dest, maxBytes: maxBytes, free: free}
	if isZip {
		return u.zip(archive)
	}
	return u.tar(archive)
}

func (u *unpacker) zip(archive string) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return invalidArchive("The archive cannot be read as a ZIP file: %v.", err)
	}
	defer r.Close()
	var sizes []uint64
	for _, f := range r.File {
		if f.Mode().IsRegular() {
			sizes = append(sizes, f.UncompressedSize64)
		}
	}
	if err := u.room(saturatingSum(sizes)); err != nil {
		return err
	}
	for _, f := range r.File {
		mode := f.Mode()
		switch {
		case mode.IsDir():
			err = u.folder(f.Name)
		case mode.IsRegular():
			err = u.file(f.Name, clampInt64(f.UncompressedSize64), f.Open)
		default:
			err = refusedEntry(f.Name, mode)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (u *unpacker) tar(archive string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	in := bufio.NewReader(f)
	var stream io.Reader = in
	if magic, _ := in.Peek(2); len(magic) == 2 && magic[0] == 0x1f && magic[1] == 0x8b {
		gz, err := gzip.NewReader(in)
		if err != nil {
			return invalidArchive("The archive cannot be read as gzip: %v.", err)
		}
		defer gz.Close()
		stream = gz
	}
	r := tar.NewReader(stream)
	for {
		header, err := r.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return invalidArchive("The archive cannot be read as a tar file: %v.", err)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			err = u.folder(header.Name)
		case tar.TypeReg, tar.TypeRegA: // TypeRegA is deprecated, but old tars write it
			err = u.file(header.Name, header.Size, func() (io.ReadCloser, error) { return io.NopCloser(r), nil })
		case tar.TypeLink, tar.TypeSymlink:
			err = refusedEntry(header.Name, fs.ModeSymlink)
		default:
			err = refusedEntry(header.Name, header.FileInfo().Mode())
		}
		if err != nil {
			return err
		}
	}
}

// refusedEntry refuses an entry that is no file or folder.
func refusedEntry(name string, mode fs.FileMode) error {
	what := "an entry that is no file or folder"
	switch {
	case mode&fs.ModeSymlink != 0:
		what = "a link"
	case mode&(fs.ModeDevice|fs.ModeCharDevice) != 0:
		what = "a device"
	case mode&fs.ModeNamedPipe != 0:
		what = "a pipe"
	}
	return invalidArchive("The archive holds %s, %s, which the media library does not take.", name, what)
}

// entryPath checks an entry's name and returns where it goes below dest; skip for the archive's
// own root and hidden entries.
func (u *unpacker) entryPath(name string) (target string, skip bool, err error) {
	u.entries++
	if u.entries > maxArchiveEntries {
		return "", false, invalidArchive("The archive holds more than %d entries.", maxArchiveEntries)
	}
	clean := path.Clean(strings.ReplaceAll(name, `\`, "/"))
	if clean == "." {
		return "", true, nil
	}
	if !filepath.IsLocal(clean) || strings.ContainsRune(clean, 0) {
		return "", false, invalidArchive("The archive's entry %q would land outside its folder.", name)
	}
	for _, part := range strings.Split(clean, "/") {
		if strings.HasPrefix(part, ".") || part == "__MACOSX" {
			return "", true, nil
		}
	}
	return filepath.Join(u.dest, filepath.FromSlash(clean)), false, nil
}

func (u *unpacker) folder(name string) error {
	target, skip, err := u.entryPath(name)
	if err != nil || skip {
		return err
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return u.writeError(name, err)
	}
	return nil
}

// room refuses an archive whose content so far and the next bytes it says it holds would not
// fit on the disk with media.FreeSpaceMargin to spare.
// It compares with the room left rather than add, so a declared size near the top of int64
// cannot wrap past the check.
func (u *unpacker) room(bytes int64) error {
	bytes = max(bytes, 0)
	if bytes <= u.free-media.FreeSpaceMargin-u.written {
		return nil
	}
	need := u.written + bytes
	if need < 0 {
		need = math.MaxInt64
	}
	return noRoom("The archive's content", need, u.free)
}

func clampInt64(n uint64) int64 { return int64(min(n, math.MaxInt64)) }

// saturatingSum is the sum of a ZIP's declared sizes, math.MaxInt64 where it would be more.
func saturatingSum(sizes []uint64) int64 {
	var sum uint64
	for _, size := range sizes {
		if size > math.MaxInt64-sum {
			return math.MaxInt64
		}
		sum += size
	}
	return int64(sum)
}

// file writes the entry name, which says it holds declared bytes.
func (u *unpacker) file(name string, declared int64, open func() (io.ReadCloser, error)) error {
	target, skip, err := u.entryPath(name)
	if err != nil || skip {
		return err
	}
	if err := u.room(declared); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return u.writeError(name, err)
	}
	in, err := open()
	if err != nil {
		return invalidArchive("The archive's entry %s cannot be read: %v.", name, err)
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return u.writeError(name, err)
	}
	room := u.maxBytes - u.written
	n, err := io.Copy(out, io.LimitReader(in, room+1))
	u.written += n
	if closeErr := out.Close(); err == nil && closeErr != nil {
		return u.writeError(name, closeErr)
	}
	if n > room {
		return &apierr.Error{Status: http.StatusRequestEntityTooLarge, Code: CodeTooLarge,
			Message: fmt.Sprintf("The archive unpacks to more than %s.", sizeText(u.maxBytes))}
	}
	if err != nil {
		var pathErr *fs.PathError
		if errors.As(err, &pathErr) {
			return u.writeError(name, err) // writing failed
		}
		return invalidArchive("The archive's entry %s cannot be read: %v.", name, err)
	}
	return nil
}

// writeError says why an entry could not be written: an entry named twice (or a file where the
// archive has a folder) is the archive's fault, a full disk is no_space.
func (u *unpacker) writeError(name string, err error) error {
	if errors.Is(err, fs.ErrExist) || errors.Is(err, syscall.ENOTDIR) {
		return invalidArchive("The archive holds %s twice, or as a file and a folder.", name)
	}
	return saveError("unpacking "+name, err)
}
