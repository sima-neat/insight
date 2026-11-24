package library

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/supervisor"
)

func TestUploadSavesAFileAsItCame(t *testing.T) {
	f := newFixture(t, nil)
	s := f.save(t, "clip.mp4", []byte("video"), "")
	if s.Path != "clip.mp4" || f.read(t, "clip.mp4") != "video" || len(s.Warnings) != 0 {
		t.Fatalf("saved %+v, content %q", s, f.read(t, "clip.mp4"))
	}
	f.noStages(t)
}

func TestUploadRefusals(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.MaxUploadBytes = 10 })
	for name, test := range map[string]struct {
		req  *http.Request
		code string
	}{
		"no file":              {uploadRequest(t, "", nil, "on_conflict", "ask"), CodeInvalidRequest},
		"a name with nothing":  {uploadRequest(t, "...", []byte("x")), CodeInvalidRequest},
		"unknown on_conflict":  {uploadRequest(t, "clip.mp4", []byte("x"), "on_conflict", "overwrite"), CodeInvalidRequest},
		"too large":            {uploadRequest(t, "clip.mp4", []byte("12345678901")), CodeTooLarge},
		"not multipart":        {httptest.NewRequest(http.MethodPost, "/", strings.NewReader("x")), CodeInvalidRequest},
		"a hidden folder name": {uploadRequest(t, "__MACOSX", []byte("x")), CodeInvalidRequest},
	} {
		if _, err := f.lib.Upload(httptest.NewRecorder(), test.req); code(err) != test.code {
			t.Errorf("%s: %v, want %s", name, err, test.code)
		}
	}
	if _, err := f.lib.Upload(httptest.NewRecorder(), twoFiles(t)); code(err) != CodeInvalidRequest {
		t.Errorf("two files: %v", err)
	}
	// A request that says it is too large is refused before it is read.
	big := uploadRequest(t, "clip.mp4", []byte("x"))
	big.ContentLength = 10 + formSlack + 1
	if _, err := f.lib.Upload(httptest.NewRecorder(), big); code(err) != CodeTooLarge {
		t.Errorf("a large Content-Length: %v", err)
	}
	entries, _ := os.ReadDir(f.root)
	if len(entries) != 0 {
		t.Fatalf("refused uploads left %v", entries)
	}
}

func TestUploadRefusesAPlaylist(t *testing.T) {
	f := newFixture(t, nil)
	f.probes.fail("list.m3u8", fmt.Errorf("probing list.m3u8: %w", media.ErrPlaylist))
	_, err := f.upload(t, "list.m3u8", []byte("#EXTM3U"), "")
	if code(err) != CodeInvalidRequest || !strings.Contains(err.Error(), "playlist") {
		t.Fatalf("%v, want invalid_request about the playlist", err)
	}
	if entries, _ := os.ReadDir(f.root); len(entries) != 0 {
		t.Fatalf("the refused upload left %v", entries)
	}
}

func TestAnUploadThatWouldNotFitIsRefusedBeforeItIsWritten(t *testing.T) {
	f := newFixture(t, nil)
	var free int64
	known := true
	asked := ""
	f.lib.freeSpace = func(dir string) (int64, bool) { asked = dir; return free, known }

	req := uploadRequest(t, "clip.mp4", []byte("video"))
	free = req.ContentLength + media.FreeSpaceMargin - 1
	_, err := f.lib.Upload(httptest.NewRecorder(), req)
	var refusal *apierr.Error
	if !errors.As(err, &refusal) || refusal.Code != CodeNoSpace || refusal.Status != http.StatusInsufficientStorage {
		t.Fatalf("one byte short: %v", err)
	}
	if asked != f.root {
		t.Errorf("asked about %q, want the media folder %q", asked, f.root)
	}
	if entries, _ := os.ReadDir(f.root); len(entries) != 0 {
		t.Fatalf("the refused upload left %v", entries)
	}

	req = uploadRequest(t, "clip.mp4", []byte("video"))
	free = req.ContentLength + media.FreeSpaceMargin
	f.save(t, "clip.mp4", []byte("video"), "")

	// A request that does not say its length may be as long as the limit.
	chunked := uploadRequest(t, "chunked.mp4", []byte("video"))
	chunked.ContentLength = -1
	free = f.lib.maxUpload + media.FreeSpaceMargin - 1
	if _, err := f.lib.Upload(httptest.NewRecorder(), chunked); code(err) != CodeNoSpace {
		t.Fatalf("a request of unknown length: %v", err)
	}

	known = false // a file system that does not say: the write itself answers a full disk
	free = 0
	f.save(t, "other.mp4", []byte("video"), "")
}

func twoFiles(t *testing.T) *http.Request {
	t.Helper()
	req := uploadRequest(t, "a.mp4", []byte("x"))
	body := new(strings.Builder)
	boundary := strings.TrimPrefix(req.Header.Get("Content-Type"), "multipart/form-data; boundary=")
	for _, name := range []string{"a.mp4", "b.mp4"} {
		body.WriteString("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + name + "\"\r\n\r\nx\r\n")
	}
	body.WriteString("--" + boundary + "--\r\n")
	two := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body.String()))
	two.Header.Set("Content-Type", req.Header.Get("Content-Type"))
	return two
}

func TestSafeName(t *testing.T) {
	long := strings.Repeat("é", 200) + ".mp4"
	for in, want := range map[string]string{
		"clip.mp4":          "clip.mp4",
		"Café clip.mp4":     "Café clip.mp4",
		"../../etc/passwd":  "passwd",
		`C:\Users\me\a.mp4`: "a.mp4",
		".bashrc":           "bashrc",
		"  . . hidden.mp4 ": "hidden.mp4",
		"a\x00b\nc.mp4":     "abc.mp4",
		"...":               "",
		"dir/":              "",
		"__MACOSX":          "",
		long:                strings.Repeat("é", 125) + ".mp4", // 255 bytes at most, cut between runes
	} {
		if got := safeName(in); got != want {
			t.Errorf("safeName(%q) = %q, want %q", in, safeName(in), want)
		}
	}
}

func TestUploadConflicts(t *testing.T) {
	f := newFixture(t, nil)
	f.write(t, "clip.mp4", "old")
	f.write(t, "clip_2.mp4", "taken too")

	for _, mode := range []string{"", "ask"} {
		_, err := f.upload(t, "clip.mp4", []byte("new"), mode)
		var e *apierr.Error
		if !errors.As(err, &e) || e.Code != CodeNameTaken || e.Conflict == nil ||
			*e.Conflict != (api.MediaConflict{Existing: "clip.mp4", Suggested: "clip_3.mp4"}) {
			t.Fatalf("on_conflict %q: %v", mode, err)
		}
	}
	if f.read(t, "clip.mp4") != "old" {
		t.Fatal("a refused upload changed the file")
	}

	s := f.save(t, "clip.mp4", []byte("new"), "keep_both")
	if s.Path != "clip_3.mp4" || f.read(t, "clip_3.mp4") != "new" || f.read(t, "clip.mp4") != "old" {
		t.Fatalf("keep_both saved %+v", s)
	}
	if s := f.save(t, "fresh.mp4", []byte("x"), "keep_both"); s.Path != "fresh.mp4" {
		t.Fatalf("keep_both without a clash saved %s", s.Path)
	}

	if err := os.Mkdir(filepath.Join(f.root, "folder.mp4"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := f.upload(t, "folder.mp4", []byte("x"), "replace"); code(err) != CodeInvalidRequest {
		t.Fatalf("a file replacing a folder: %v", err)
	}
	f.noStages(t)
}

func TestPlaceNeverOverwritesANameTakenMeanwhile(t *testing.T) {
	f := newFixture(t, nil)
	stage, err := f.lib.newStage()
	if err != nil {
		t.Fatal(err)
	}
	defer f.lib.removeStage(stage)
	staged := filepath.Join(stage, "clip.mp4")
	os.WriteFile(staged, []byte("mine"), 0o644)
	f.write(t, "clip.mp4", "theirs") // after checkTarget, before place

	if _, err := f.lib.place(t.Context(), staged, "clip.mp4", false, Ask, stage); code(err) != CodeNameTaken {
		t.Fatalf("Ask over a name taken meanwhile: %v", err)
	}
	s, err := f.lib.place(t.Context(), staged, "clip.mp4", false, KeepBoth, stage)
	if err != nil || s.Path != "clip_2.mp4" {
		t.Fatalf("KeepBoth over a name taken meanwhile: %+v, %v", s, err)
	}
	if f.read(t, "clip.mp4") != "theirs" || f.read(t, "clip_2.mp4") != "mine" {
		t.Fatal("a file was overwritten")
	}
}

func TestUploadReplaceRestartsTheSlotsOnTheNewFile(t *testing.T) {
	f := newFixture(t, nil)
	f.write(t, "clip.mp4", "old")
	f.files.use("clip.mp4", 3, 9)
	f.files.restartErr[9] = errors.New("MediaMTX is not running")
	var atRestart string
	f.files.atRestart = func([]int) { atRestart = f.read(t, "clip.mp4") }

	s := f.save(t, "clip.mp4", []byte("new"), "replace")
	if f.read(t, "clip.mp4") != "new" || atRestart != "new" {
		t.Fatalf("content %q, at the restart %q", f.read(t, "clip.mp4"), atRestart)
	}
	if !slices.Equal(s.Restarted, []int{3}) || len(s.Warnings) != 1 ||
		s.Warnings[0] != "Could not restart src9: MediaMTX is not running" {
		t.Fatalf("saved %+v", s)
	}

	// Keep both never touches the slots.
	f2 := newFixture(t, nil)
	f2.write(t, "clip.mp4", "old")
	f2.files.use("clip.mp4", 3)
	f2.save(t, "clip.mp4", []byte("new"), "keep_both")
	if restarted, _ := f2.files.calls(); len(restarted) != 0 {
		t.Fatalf("keep_both restarted %v", restarted)
	}
}

func TestUploadReencodesWhatTheBoardStreamsBadly(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.FFmpeg = fakeFFmpeg(t, "") })
	f.probes.set("clip.mp4", bframes())
	f.probes.set("good.mp4", h264())
	for _, name := range []string{"clip.webm", "other.webm"} {
		f.probes.set(name, media.Info{Kind: media.KindVideo, Codec: "vp9", CodecName: "vp9", Width: 640, Height: 360})
	}

	if result, err := f.upload(t, "good.mp4", []byte("good"), ""); err != nil || result.Job != nil {
		t.Fatalf("a good file went to a job: %+v, %v", result, err)
	}

	result, err := f.upload(t, "clip.mp4", []byte("bad"), "")
	if err != nil || result.Job == nil {
		t.Fatalf("a file with B-frames was not re-encoded: %+v, %v", result, err)
	}
	if kind := result.Job.Snapshot().Kind; kind != KindUpload {
		t.Fatalf("the job's kind is %s", kind)
	}
	s := saved(t, result, err)
	if s.Path != "clip.mp4" || !slices.Equal(s.Reencoded, []string{"clip.mp4"}) || f.read(t, "clip.mp4") != "bad+encoded" {
		t.Fatalf("saved %+v, content %q", s, f.read(t, "clip.mp4"))
	}

	// WebM cannot carry H.264: the file is saved as MP4.
	s = f.save(t, "other.webm", []byte("vp9"), "")
	if s.Path != "other.mp4" || f.read(t, "other.mp4") != "vp9+encoded" {
		t.Fatalf("the WebM upload was saved as %s", s.Path)
	}
	// Its new name clashes like any other.
	if _, err := f.upload(t, "clip.webm", []byte("vp9"), ""); code(err) != CodeNameTaken {
		t.Fatalf("a WebM upload whose MP4 name is taken: %v", err)
	}
	f.noStages(t)
}

func TestAReencodeThatFailsSavesTheFileAsItCame(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.FFmpeg = fakeFFmpeg(t, "fail") })
	f.probes.set("clip.mp4", bframes())
	s := f.save(t, "clip.mp4", []byte("bad"), "")
	if f.read(t, "clip.mp4") != "bad" || len(s.Reencoded) != 0 || len(s.Warnings) != 1 ||
		!strings.Contains(s.Warnings[0], "Error while opening encoder") {
		t.Fatalf("saved %+v", s)
	}
}

func TestWithoutFFmpegAnUploadIsSavedAsItCameWithAWarning(t *testing.T) {
	f := newFixture(t, nil)
	f.probes.set("clip.mp4", bframes())
	result, err := f.upload(t, "clip.mp4", []byte("bad"), "")
	if err != nil || result.Saved == nil || len(result.Saved.Warnings) != 1 ||
		!strings.Contains(result.Saved.Warnings[0], "B-frames") {
		t.Fatalf("%+v, %v", result.Saved, err)
	}
}

func TestACancelledReencodeSavesNothingAndLeavesTheSlotsAlone(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.FFmpeg = fakeFFmpeg(t, "hang") })
	f.probes.set("clip.mp4", bframes())
	f.write(t, "clip.mp4", "old")
	f.files.use("clip.mp4", 4)

	result, err := f.upload(t, "clip.mp4", []byte("new"), "replace")
	if err != nil || result.Job == nil {
		t.Fatalf("%+v, %v", result, err)
	}
	events, unsubscribe, _ := f.jobs.Subscribe(result.Job.ID())
	defer unsubscribe()
	// The stand-in reports half of the clip's second, then waits to be killed.
	for s := range events {
		if s.Progress.Phase == "encode" && s.Progress.Percent != nil && *s.Progress.Percent == 50 &&
			s.Progress.Detail == "00:00 / 00:01" {
			break
		}
	}
	result.Job.Cancel()
	if s := waitJob(t, result.Job); s.State != jobs.Cancelled {
		t.Fatalf("the job ended %s: %s", s.State, s.Error)
	}
	if restarted, _ := f.files.calls(); f.read(t, "clip.mp4") != "old" || len(restarted) != 0 {
		t.Fatalf("content %q, restarted %v", f.read(t, "clip.mp4"), restarted)
	}
	f.noStages(t)
}

func TestNewSweepsStaleStagingFoldersAndNothingElse(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "media")
	keep := []string{".staging-", ".upload-1", "staging-1", "clip.mp4", ".staging-file"}
	for _, name := range []string{".staging-1/clip.mp4", ".staging-abc/x/y", ".staging-/x", ".upload-1/x", "staging-1/x", "clip.mp4"} {
		abs := filepath.Join(root, name)
		os.MkdirAll(filepath.Dir(abs), 0o755)
		os.WriteFile(abs, []byte("x"), 0o644)
	}
	os.WriteFile(filepath.Join(root, ".staging-file"), []byte("x"), 0o644)
	outside := filepath.Join(dir, "outside")
	os.MkdirAll(outside, 0o755)
	os.WriteFile(filepath.Join(outside, "keep"), []byte("x"), 0o644)
	if err := os.Symlink(outside, filepath.Join(root, ".staging-link")); err != nil {
		t.Fatal(err)
	}
	keep = append(keep, ".staging-link")

	f := &fixture{root: root, files: newFakeFiles(), probes: newFakeProbes(), jobs: jobs.New(nil)}
	if _, err := New(Options{Root: root, Cache: media.NewCache(t.Context(), f.probes.probe), Jobs: f.jobs, Files: f.files,
		Start: func(supervisor.Spec) (supervisor.Child, error) { return nil, errors.New("nothing runs here") }}); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(root)
	var left []string
	for _, e := range entries {
		left = append(left, e.Name())
	}
	slices.Sort(left)
	slices.Sort(keep)
	if !slices.Equal(left, keep) {
		t.Fatalf("left %v, want %v", left, keep)
	}
	if _, err := os.Stat(filepath.Join(outside, "keep")); err != nil {
		t.Fatal("the sweep followed a link")
	}
}

func TestCheckStage(t *testing.T) {
	root := "/data/media"
	if err := checkStage(root, "/data/media/.staging-123"); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"/data/media", "/data/media/.staging-", "/data/media/sub/.staging-1",
		"/data/.staging-1", "/data/media/.upload-1", "/data/media/.staging-1/..", "/", "", ".staging-1"} {
		if checkStage(root, dir) == nil {
			t.Errorf("checkStage(%q) allowed it", dir)
		}
	}
	if checkStage("relative", "relative/.staging-1") == nil {
		t.Error("a relative root was allowed")
	}
}
