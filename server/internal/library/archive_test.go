package library

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"insight/internal/media"
)

// entry is one member of a test archive: a file with content, a folder (a name ending in "/"),
// or with link set a symbolic link (typeflag for tar's other kinds).
type entry struct {
	name, content, link string
	typeflag            byte
}

func zipOf(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range entries {
		header := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		switch {
		case e.link != "":
			header.SetMode(fs.ModeSymlink | 0o777)
		case e.name[len(e.name)-1] == '/':
			header.SetMode(fs.ModeDir | 0o755)
		default:
			header.SetMode(0o644)
		}
		out, err := w.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		out.Write([]byte(e.content + e.link))
	}
	w.Close()
	return buf.Bytes()
}

func tarOf(t *testing.T, gzipped bool, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	var w *tar.Writer
	var gz *gzip.Writer
	if gzipped {
		gz = gzip.NewWriter(&buf)
		w = tar.NewWriter(gz)
	} else {
		w = tar.NewWriter(&buf)
	}
	for _, e := range entries {
		header := &tar.Header{Name: e.name, Mode: 0o644, Size: int64(len(e.content)), ModTime: time.Now(), Typeflag: tar.TypeReg}
		switch {
		case e.typeflag != 0:
			header.Typeflag, header.Size, header.Linkname = e.typeflag, 0, e.link
		case e.link != "":
			header.Typeflag, header.Size, header.Linkname = tar.TypeSymlink, 0, e.link
		case e.name[len(e.name)-1] == '/':
			header.Typeflag, header.Size, header.Mode = tar.TypeDir, 0, 0o755
		}
		if err := w.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(e.content))
	}
	w.Close()
	if gz != nil {
		gz.Close()
	}
	return buf.Bytes()
}

// contents are the library's files below folder, with their contents.
func (f *fixture) contents(t *testing.T, folder string) map[string]string {
	t.Helper()
	out := map[string]string{}
	dir := filepath.Join(f.root, folder)
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			data, _ := os.ReadFile(p)
			out[filepath.ToSlash(rel)] = string(data)
		}
		return nil
	})
	return out
}

func sameFiles(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func TestUploadUnpacksArchivesIntoAFolder(t *testing.T) {
	members := []entry{
		{name: "clips/"}, {name: "clips/a.mp4", content: "a"}, {name: "b.mp4", content: "b"},
		{name: "./c.mp4", content: "c"},
		{name: "__MACOSX/._a.mp4", content: "junk"}, {name: "clips/.DS_Store", content: "junk"},
	}
	want := map[string]string{"clips/a.mp4": "a", "b.mp4": "b", "c.mp4": "c"}
	for name, archive := range map[string][]byte{
		"set.zip":    zipOf(t, members...),
		"set.tar":    tarOf(t, false, members...),
		"set.tar.gz": tarOf(t, true, members...),
		"set.tgz":    tarOf(t, true, members...),
		"set.gz":     tarOf(t, true, members...),
		"SET.ZIP":    zipOf(t, members...),
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, nil)
			s := f.save(t, name, archive, "")
			folder := name[:3]
			if s.Path != folder || !s.Folder || !sameFiles(f.contents(t, folder), want) {
				t.Fatalf("saved %+v with %v", s, f.contents(t, folder))
			}
			f.noStages(t)
		})
	}
}

func TestUploadRefusesUnsafeArchives(t *testing.T) {
	for name, archive := range map[string][]byte{
		"up a folder":         zipOf(t, entry{name: "../evil.mp4", content: "x"}),
		"up further":          tarOf(t, false, entry{name: "a/../../evil.mp4", content: "x"}),
		"absolute":            tarOf(t, false, entry{name: "/tmp/evil.mp4", content: "x"}),
		"backslashes":         zipOf(t, entry{name: `..\evil.mp4`, content: "x"}),
		"a zip link":          zipOf(t, entry{name: "link", link: "/etc/passwd"}),
		"a tar link":          tarOf(t, false, entry{name: "link", link: "/etc"}),
		"a link then a file":  tarOf(t, false, entry{name: "dir", link: "/tmp"}, entry{name: "dir/evil.mp4", content: "x"}),
		"a hard link":         tarOf(t, false, entry{name: "hard", link: "/etc/passwd", typeflag: tar.TypeLink}),
		"a device":            tarOf(t, false, entry{name: "dev", typeflag: tar.TypeChar}),
		"a pipe":              tarOf(t, false, entry{name: "pipe", typeflag: tar.TypeFifo}),
		"a file twice":        tarOf(t, false, entry{name: "a.mp4", content: "1"}, entry{name: "a.mp4", content: "2"}),
		"a file and a folder": tarOf(t, false, entry{name: "a", content: "1"}, entry{name: "a/b.mp4", content: "2"}),
		"not a zip":           []byte("not a zip at all"),
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, nil)
			upload := "set.tar"
			if archive[0] == 'P' || name == "not a zip" { // a zip starts with "PK"
				upload = "set.zip"
			}
			_, err := f.upload(t, upload, archive, "")
			if code(err) != CodeInvalidArchive {
				t.Fatalf("%v, want invalid_archive", err)
			}
			entries, _ := os.ReadDir(f.root)
			if len(entries) != 0 {
				t.Fatalf("a refused archive left %v", entries)
			}
			if _, err := os.Lstat(filepath.Join(filepath.Dir(f.root), "evil.mp4")); err == nil {
				t.Fatal("an entry landed outside the media folder")
			}
		})
	}
}

func TestUploadRefusesAnArchiveWithAPlaylist(t *testing.T) {
	f := newFixture(t, nil)
	f.probes.fail("list.m3u8", fmt.Errorf("probing list.m3u8: %w", media.ErrPlaylist))
	archive := zipOf(t, entry{name: "a.mp4", content: "a"}, entry{name: "list.m3u8", content: "#EXTM3U"})
	_, err := f.upload(t, "set.zip", archive, "")
	if code(err) != CodeInvalidArchive || !strings.Contains(err.Error(), "list.m3u8") {
		t.Fatalf("%v, want invalid_archive naming the playlist", err)
	}
	if entries, _ := os.ReadDir(f.root); len(entries) != 0 {
		t.Fatalf("a refused archive left %v", entries)
	}
}

// An archive is checked for room for what it says it unpacks to, before anything of it is
// written: a ZIP by its directory, a tar by each entry's header.
func TestAnArchiveThatWouldNotFitUnpackedIsRefused(t *testing.T) {
	content := string(make([]byte, 256<<10)) // zeros: the archive is small, its content is not
	for name, archive := range map[string][]byte{
		"set.zip": zipOf(t, entry{name: "a.mp4", content: content}, entry{name: "b.mp4", content: content}),
		"set.tgz": tarOf(t, true, entry{name: "a.mp4", content: content}, entry{name: "b.mp4", content: content}),
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, nil)
			// Room for the request (the archive and the form around it) and one entry, with the
			// margin, but not for both entries.
			f.lib.freeSpace = func(string) (int64, bool) {
				return int64(len(archive)) + 4096 + int64(len(content)) + media.FreeSpaceMargin, true
			}
			_, err := f.upload(t, name, archive, "")
			if code(err) != CodeNoSpace {
				t.Fatalf("%v, want no_space", err)
			}
			f.noStages(t)
			if entries, _ := os.ReadDir(f.root); len(entries) != 0 {
				t.Fatalf("a refused archive left %v", entries)
			}
		})
	}
}

func TestUploadLimitsWhatAnArchiveUnpacksTo(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.MaxUploadBytes = 64 << 10 })
	// Zeros compress to almost nothing: the archive is small, its content is not.
	archive := zipOf(t, entry{name: "big.mp4", content: string(make([]byte, 128<<10))})
	if len(archive) > 64<<10 {
		t.Fatalf("the archive is %d bytes", len(archive))
	}
	if _, err := f.upload(t, "bomb.zip", archive, ""); code(err) != CodeTooLarge {
		t.Fatalf("%v, want too_large", err)
	}
	f.noStages(t)
}

func TestUploadArchiveConflictsAndReplace(t *testing.T) {
	f := newFixture(t, nil)
	f.write(t, "set/kept.mp4", "old kept")
	f.write(t, "set/gone.mp4", "old gone")
	f.write(t, "file", "a file")
	f.files.use("set/kept.mp4", 2)
	f.files.use("set/gone.mp4", 7)
	archive := zipOf(t, entry{name: "kept.mp4", content: "new kept"}, entry{name: "added.mp4", content: "added"})

	if _, err := f.upload(t, "set.zip", archive, ""); code(err) != CodeNameTaken {
		t.Fatalf("an archive whose folder exists: %v", err)
	}
	if s := f.save(t, "set.zip", archive, "keep_both"); s.Path != "set_2" {
		t.Fatalf("keep_both saved %s", s.Path)
	}
	if _, err := f.upload(t, "file.zip", archive, "replace"); code(err) != CodeInvalidRequest {
		t.Fatalf("an archive replacing a file: %v", err)
	}

	s := f.save(t, "set.zip", archive, "replace")
	if want := map[string]string{"kept.mp4": "new kept", "added.mp4": "added"}; !sameFiles(f.contents(t, "set"), want) {
		t.Fatalf("the replaced folder holds %v", f.contents(t, "set"))
	}
	restarted, unassigned := f.files.calls()
	if !slices.Equal(s.Restarted, []int{2}) || !slices.Equal(restarted, []int{2}) ||
		!slices.Equal(s.Unassigned, []int{7}) || !slices.Equal(unassigned, []int{7}) {
		t.Fatalf("saved %+v; restarted %v, unassigned %v", s, restarted, unassigned)
	}
	f.noStages(t)
}

func TestUploadArchiveReencodesItsVideosInAJob(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.FFmpeg = fakeFFmpeg(t, "") })
	f.probes.set("bad.mp4", bframes())
	f.probes.set("old.avi", bframes())
	f.probes.set("good.mp4", h264())
	archive := zipOf(t, entry{name: "bad.mp4", content: "bad"}, entry{name: "sub/old.avi", content: "avi"},
		entry{name: "good.mp4", content: "good"})

	result, err := f.upload(t, "set.zip", archive, "")
	if err != nil || result.Job == nil {
		t.Fatalf("%+v, %v", result, err)
	}
	s := saved(t, result, err)
	want := map[string]string{"bad.mp4": "bad+encoded", "sub/old.mp4": "avi+encoded", "good.mp4": "good"}
	if !sameFiles(f.contents(t, "set"), want) {
		t.Fatalf("the folder holds %v", f.contents(t, "set"))
	}
	slices.Sort(s.Reencoded)
	if !slices.Equal(s.Reencoded, []string{"set/bad.mp4", "set/sub/old.mp4"}) {
		t.Fatalf("reencoded %v", s.Reencoded)
	}
	f.noStages(t)
}

func TestArchiveOf(t *testing.T) {
	for name, want := range map[string]string{
		"set.zip": "set", "my.clips.tar.gz": "my.clips", "a.tgz": "a", "b.TAR": "b", "c.gz": "c",
		".zip": "", "x.mp4": "", "tar": "",
	} {
		folder, _, ok := archiveOf(name)
		if folder != want || ok != (want != "") {
			t.Errorf("archiveOf(%q) = %q, %v", name, folder, ok)
		}
	}
}
