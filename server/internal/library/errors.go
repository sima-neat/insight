package library

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"syscall"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/media"
)

// The codes of the library's errors, for the API's error shape.
const (
	CodeInvalidRequest     = "invalid_request"     // 400: a malformed request
	CodeInvalidPath        = "invalid_path"        // 400: a path outside the library, hidden, or the library itself
	CodeInvalidArchive     = "invalid_archive"     // 400: an archive that cannot be read or holds what the library refuses
	CodeNotFound           = "not_found"           // 404: no such file, folder or catalog asset
	CodeInUse              = "in_use"              // 409: slots use the file; Error.Slots names them
	CodeNameTaken          = "name_taken"          // 409: the name is taken; Error.Conflict says by what
	CodeTooLarge           = "too_large"           // 413: the upload, or what an archive unpacks to, is too large
	CodeNoSpace            = "no_space"            // 507: the media folder's disk is full
	CodeCatalogUnavailable = "catalog_unavailable" // 502: the catalog could not be fetched or read
	CodeFFmpegMissing      = "ffmpeg_missing"      // 503: the work needs FFmpeg, which is not installed
	CodeInternal           = "internal"            // 500: anything else, said in the message
)

// Error is a refusal or failure of a library operation, as the API answers it.
type Error struct {
	Status  int
	Code    string
	Message string // a sentence the UI may show as it is
	Hint    string // what to do about it, or ""
	// Conflict is set with CodeNameTaken.
	Conflict *Conflict
	// Slots are set with CodeInUse.
	Slots []int
	err   error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.err }

// Conflict is what an upload's name clashes with.
type Conflict struct {
	// Existing is the library path that is taken.
	Existing string `json:"existing"`
	// Suggested is the free name Keep both would save under.
	Suggested string `json:"suggested"`
}

// errorBody is the API's error shape with the library's additions beside "error".
type errorBody struct {
	api.Error
	Conflict *Conflict `json:"conflict,omitempty"`
	Slots    []int     `json:"slots,omitempty"`
}

// WriteError answers with err in the API's error shape: an *Error as it says, anything else as
// a 500 whose message is err's.
func WriteError(w http.ResponseWriter, err error) {
	var e *Error
	if !errors.As(err, &e) {
		slog.Warn("a media library operation failed", "error", err)
		e = &Error{Status: http.StatusInternalServerError, Code: CodeInternal, Message: err.Error()}
	}
	apierr.WriteJSON(w, e.Status, errorBody{
		Error:    apierr.New(e.Code, e.Message, e.Hint),
		Conflict: e.Conflict,
		Slots:    e.Slots,
	})
}

func invalidRequest(format string, args ...any) *Error {
	return &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: fmt.Sprintf(format, args...)}
}

func invalidArchive(format string, args ...any) *Error {
	return &Error{Status: http.StatusBadRequest, Code: CodeInvalidArchive, Message: fmt.Sprintf(format, args...)}
}

func notFound(format string, args ...any) *Error {
	return &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: fmt.Sprintf(format, args...)}
}

func tooLarge(limit int64) *Error {
	return &Error{
		Status: http.StatusRequestEntityTooLarge, Code: CodeTooLarge,
		Message: fmt.Sprintf("The upload is larger than %s.", sizeText(limit)),
	}
}

// pathError turns a refusal of media.Resolve into invalid_path; other errors (the media folder
// cannot be read) stay as they are.
func pathError(rel string, err error) error {
	if errors.Is(err, media.ErrInvalidPath) {
		return &Error{
			Status: http.StatusBadRequest, Code: CodeInvalidPath, err: err,
			Message: fmt.Sprintf("%q is not a path in the media library.", rel),
		}
	}
	return err
}

// saveError says that writing to the media folder failed while doing what, as no_space when
// its disk is full.
func saveError(doing string, err error) error {
	if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) {
		return &Error{
			Status: http.StatusInsufficientStorage, Code: CodeNoSpace, err: err,
			Message: "The media folder's disk is full.", Hint: "Delete media you no longer need, then try again.",
		}
	}
	return fmt.Errorf("%s: %w", doing, err)
}

// sizeText writes a size as the UI does: "8 GiB", "1.5 MiB".
func sizeText(bytes int64) string {
	units := []string{"bytes", "KiB", "MiB", "GiB", "TiB"}
	value, unit := float64(bytes), 0
	for value >= 1024 && unit < len(units)-1 {
		value /= 1024
		unit++
	}
	if unit == 0 || value == float64(int64(value)) {
		return fmt.Sprintf("%d %s", int64(value), units[unit])
	}
	return fmt.Sprintf("%.1f %s", value, units[unit])
}
