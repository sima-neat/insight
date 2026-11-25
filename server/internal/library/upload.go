package library

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"insight/internal/apierr"
	"insight/internal/jobs"
	"insight/internal/media"
)

// UploadResult is how an upload ended: in the library already (Saved, 201), or re-encoded first
// by a job (Job, 202) whose result is a *Saved.
type UploadResult struct {
	Saved *Saved
	Job   *jobs.Job
}

// formSlack is what an upload's request may hold beyond its file: the boundaries, the part
// headers and the on_conflict field.
const formSlack = 1 << 20

// received is an upload as it was read from its request.
type received struct {
	name   string // the file's usable name (safeName)
	staged string // where it is, in the stage
	mode   ConflictMode
}

// Upload takes an upload from a multipart/form-data request: its file in the field "file" (one
// per request) and the optional field "on_conflict" (Ask, KeepBoth or Replace; Ask unless
// said). The file is streamed into a staging folder, never held in memory, up to the library's
// size limit.
//
// A file the board streams well is moved into the library at once; one it would stream badly
// (planEncode) is re-encoded by a job first, and saved when it is done. An archive (ZIP, tar,
// gzipped tar) is unpacked into a folder named after it, its videos held to the same rule. A
// taken name answers name_taken with Ask, before any work: nothing is saved. Replacing restarts
// the slots that streamed what was replaced, and unassigns those whose file a replaced folder
// lacks.
func (l *Library) Upload(w http.ResponseWriter, r *http.Request) (UploadResult, error) {
	if r.ContentLength > l.maxUpload+formSlack {
		return UploadResult{}, tooLarge(l.maxUpload)
	}
	if err := l.checkRoom(r.ContentLength); err != nil {
		return UploadResult{}, err
	}
	r.Body = http.MaxBytesReader(w, r.Body, l.maxUpload+formSlack)
	form, err := r.MultipartReader()
	if err != nil {
		return UploadResult{}, invalidRequest("An upload is sent as multipart/form-data.")
	}
	stage, err := l.newStage()
	if err != nil {
		return UploadResult{}, err
	}
	result, err := l.upload(r.Context(), form, stage)
	if result.Job == nil {
		l.removeStage(stage)
	} else {
		go func() {
			<-result.Job.Done() // also when it is cancelled before it ran
			l.removeStage(stage)
		}()
	}
	return result, err
}

func (l *Library) upload(ctx context.Context, form *multipart.Reader, stage string) (UploadResult, error) {
	up, err := l.receive(form, stage)
	if err != nil {
		return UploadResult{}, err
	}
	if folder, isZip, ok := archiveOf(up.name); ok {
		return l.uploadArchive(ctx, up, folder, isZip, stage)
	}
	return l.uploadFile(ctx, up, stage)
}

// checkRoom refuses an upload whose request of length bytes (-1 when it does not say: up to the
// limit) would not fit on the media folder's disk with media.FreeSpaceMargin to spare, before
// anything of it is written. A disk that fills meanwhile is still answered by the write
// (saveError).
func (l *Library) checkRoom(length int64) error {
	if length < 0 {
		length = l.maxUpload
	}
	free, known := l.freeSpace(l.root)
	if !known || free >= length+media.FreeSpaceMargin {
		return nil
	}
	return noRoom("The upload", length, free)
}

// noRoom refuses what needs bytes on the media folder's disk, beside media.FreeSpaceMargin, when
// only free is free.
func noRoom(what string, bytes, free int64) error {
	return &apierr.Error{
		Status: http.StatusInsufficientStorage, Code: CodeNoSpace,
		Message: fmt.Sprintf("%s needs about %s free on the media folder's disk (%s for it and %s to spare), and %s is free.",
			what, sizeText(bytes+media.FreeSpaceMargin), sizeText(bytes), sizeText(media.FreeSpaceMargin), sizeText(free)),
		Hint: "Delete media you no longer need, then try again.",
	}
}

// receive reads the request's fields, streaming the file into stage.
func (l *Library) receive(form *multipart.Reader, stage string) (received, error) {
	var up received
	mode := ""
	for {
		part, err := form.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return up, readError(err, l.maxUpload)
		}
		switch part.FormName() {
		case "on_conflict":
			text, err := io.ReadAll(io.LimitReader(part, 64))
			if err != nil {
				return up, readError(err, l.maxUpload)
			}
			mode = string(text)
		case "file":
			if up.staged != "" {
				return up, invalidRequest("An upload holds one file; send each in a request of its own.")
			}
			if up.name = safeName(part.FileName()); up.name == "" {
				return up, invalidRequest("The file's name %q has nothing usable in it.", part.FileName())
			}
			up.staged = filepath.Join(stage, up.name)
			if err := l.stageFile(part, up.staged); err != nil {
				return up, err
			}
		default:
			if _, err := io.Copy(io.Discard, part); err != nil {
				return up, readError(err, l.maxUpload)
			}
		}
		part.Close()
	}
	if up.staged == "" {
		return up, invalidRequest("The upload holds no file (the form field \"file\").")
	}
	switch ConflictMode(mode) {
	case "", Ask:
		up.mode = Ask
	case KeepBoth, Replace:
		up.mode = ConflictMode(mode)
	default:
		return up, invalidRequest("on_conflict is %q; it must be ask, keep_both or replace.", mode)
	}
	return up, nil
}

// stageFile copies the upload's file part to dst, up to the size limit.
func (l *Library) stageFile(part io.Reader, dst string) error {
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return saveError("staging the upload", err)
	}
	n, err := io.Copy(f, io.LimitReader(part, l.maxUpload+1))
	if closeErr := f.Close(); err == nil && closeErr != nil {
		return saveError("staging the upload", closeErr)
	}
	if n > l.maxUpload {
		return tooLarge(l.maxUpload)
	}
	if err != nil {
		var pathErr *fs.PathError
		if errors.As(err, &pathErr) {
			return saveError("staging the upload", err)
		}
		return readError(err, l.maxUpload)
	}
	return nil
}

// readError says why the request could not be read: too large, or broken off.
func readError(err error, limit int64) error {
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		return tooLarge(limit)
	}
	return invalidRequest("The upload could not be read: %v.", err)
}

// uploadFile saves an uploaded file, at once or after a re-encode.
func (l *Library) uploadFile(ctx context.Context, up received, stage string) (UploadResult, error) {
	plan, encode, err := l.planEncode(ctx, up.staged)
	if err != nil {
		return UploadResult{}, invalidRequest("%s is a playlist, which names other files; the media library takes none.", up.name)
	}
	var warnings []string
	if encode && l.ffmpeg == "" {
		encode = false
		warnings = append(warnings, fmt.Sprintf(
			"%s was saved as it came: it has %s, which a board streams badly, and FFmpeg, which would re-encode it, is not installed.",
			up.name, strings.Join(plan.reasons, ", ")))
	}
	name := up.name
	if encode {
		name = encodedName(up.name)
	}
	if err := l.checkTarget(name, up.mode, false); err != nil {
		return UploadResult{}, err
	}
	if !encode {
		saved, err := l.place(ctx, up.staged, name, false, up.mode, stage)
		if saved != nil {
			saved.Warnings = append(warnings, saved.Warnings...)
		}
		return UploadResult{Saved: saved}, err
	}

	job := l.jobs.Submit(KindUpload, "Prepare "+up.name+" for streaming", func(ctx context.Context, p *jobs.Progress) (any, error) {
		p.Set(jobs.ProgressValue{Phase: "encode", Detail: strings.Join(plan.reasons, ", ")})
		out := filepath.Join(stage, "encoded", name)
		err := os.Mkdir(filepath.Dir(out), 0o755)
		if err == nil {
			err = l.encode(ctx, up.staged, out, plan, p.Follow)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err() // cancelled: nothing is saved
		}
		src, final := out, name
		if err != nil {
			src, final = up.staged, up.name
			warnings = append(warnings, fmt.Sprintf("%s was saved as it came: %v", up.name, err))
		}
		p.Set(jobs.ProgressValue{Phase: "save"})
		saved, err := l.place(ctx, src, final, false, up.mode, stage)
		if err != nil {
			return nil, err
		}
		if src == out {
			saved.Reencoded = []string{saved.Path}
		}
		saved.Warnings = append(warnings, saved.Warnings...)
		return saved, nil
	})
	return UploadResult{Job: job}, nil
}

// uploadArchive unpacks an uploaded archive into a folder, re-encodes what needs it (by a job)
// and saves the folder.
func (l *Library) uploadArchive(ctx context.Context, up received, folder string, isZip bool, stage string) (UploadResult, error) {
	if folder == "" {
		return UploadResult{}, invalidRequest("The archive's name %q leaves no usable folder name.", up.name)
	}
	if err := l.checkTarget(folder, up.mode, true); err != nil {
		return UploadResult{}, err
	}
	unpacked := filepath.Join(stage, "unpacked")
	free, known := l.freeSpace(l.root)
	if !known {
		free = math.MaxInt64
	}
	if err := unpack(up.staged, unpacked, isZip, l.maxUpload, free); err != nil {
		return UploadResult{}, err
	}
	_ = os.Remove(up.staged) // the archive itself, in the stage; its room is better free

	type pending struct {
		abs  string
		plan encodePlan
	}
	var work []pending
	var refused error
	_ = filepath.WalkDir(unpacked, func(p string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() {
			return nil
		}
		plan, encode, err := l.planEncode(ctx, p)
		if err != nil {
			below, _ := filepath.Rel(unpacked, p)
			refused = invalidArchive("The archive holds %s, a playlist, which names other files; the media library takes none.", filepath.ToSlash(below))
			return filepath.SkipAll
		}
		if encode {
			work = append(work, pending{p, plan})
		}
		return nil
	})
	if refused != nil {
		return UploadResult{}, refused
	}
	var warnings []string
	if len(work) > 0 && l.ffmpeg == "" {
		warnings = append(warnings, fmt.Sprintf(
			"%d of the archive's videos were saved as they came: a board streams them badly, and FFmpeg, which would re-encode them, is not installed.",
			len(work)))
		work = nil
	}
	if len(work) == 0 {
		saved, err := l.place(ctx, unpacked, folder, true, up.mode, stage)
		if saved != nil {
			saved.Warnings = append(warnings, saved.Warnings...)
		}
		return UploadResult{Saved: saved}, err
	}

	job := l.jobs.Submit(KindUpload, "Prepare "+up.name+" for streaming", func(ctx context.Context, p *jobs.Progress) (any, error) {
		var encoded []string // below the folder
		for i, w := range work {
			below, _ := filepath.Rel(unpacked, w.abs)
			label := fmt.Sprintf("%s (%d of %d)", filepath.ToSlash(below), i+1, len(work))
			p.Set(jobs.ProgressValue{Phase: "encode", Detail: label})
			done, err := l.encodeInPlace(ctx, unpacked, w.abs, w.plan, func(f *jobs.FFmpegProgress) {
				share, _ := f.Percent()
				p.SetPercent((float64(i) + share/100) * 100 / float64(len(work)))
				p.SetDetail(label + " " + f.Detail())
			})
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if err != nil {
				warnings = append(warnings, fmt.Sprintf("%s was saved as it came: %v", filepath.ToSlash(below), err))
				continue
			}
			rel, _ := filepath.Rel(unpacked, done)
			encoded = append(encoded, filepath.ToSlash(rel))
		}
		p.Set(jobs.ProgressValue{Phase: "save"})
		saved, err := l.place(ctx, unpacked, folder, true, up.mode, stage)
		if err != nil {
			return nil, err
		}
		for _, rel := range encoded {
			saved.Reencoded = append(saved.Reencoded, saved.Path+"/"+rel)
		}
		saved.Warnings = append(warnings, saved.Warnings...)
		return saved, nil
	})
	return UploadResult{Job: job}, nil
}

// encodeInPlace re-encodes the file at abs, below the unpacked archive's folder unpacked, and
// puts the result in its place under its encodedName (numbered if a file of the archive has
// that name); it returns where.
func (l *Library) encodeInPlace(ctx context.Context, unpacked, abs string, plan encodePlan, moved func(*jobs.FFmpegProgress)) (string, error) {
	if below, err := filepath.Rel(unpacked, abs); err != nil || below == "." || !filepath.IsLocal(below) {
		return "", fmt.Errorf("refusing to re-encode %s: not in the unpacked archive", abs)
	}
	dir, name := filepath.Split(abs)
	out, err := os.CreateTemp(dir, ".encoding-*"+filepath.Ext(encodedName(name)))
	if err != nil {
		return "", err
	}
	tmp := out.Name()
	out.Close()
	defer os.Remove(tmp) // the temporary file made above; gone already once it is renamed
	if err := l.encode(ctx, abs, tmp, plan, moved); err != nil {
		return "", err
	}
	target := filepath.Join(dir, encodedName(name))
	if target == abs {
		return target, os.Rename(tmp, abs)
	}
	if target, err = moveUnique(tmp, target, false); err != nil {
		return "", err
	}
	return target, os.Remove(abs) // checked above to lie in the unpacked archive
}

// safeName makes the name a browser or the catalog gave a usable library name: its last element
// (after any "/" or "\"), without control characters and without leading dots and spaces (which
// would hide it), at most 255 bytes with its extension kept; "" when nothing usable is left.
func safeName(name string) string {
	name = name[strings.LastIndexAny(name, `/\`)+1:]
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == utf8.RuneError {
			return -1
		}
		return r
	}, name)
	name = strings.TrimLeft(strings.TrimSpace(name), ". ")
	if name == "__MACOSX" {
		return ""
	}
	const maxBytes = 255
	if len(name) > maxBytes {
		ext := filepath.Ext(name)
		if len(ext) > 16 {
			ext = ""
		}
		stem := name[:len(name)-len(ext)]
		cut := maxBytes - len(ext)
		for cut > 0 && !utf8.RuneStart(stem[cut]) {
			cut--
		}
		name = stem[:cut] + ext
	}
	return name
}
