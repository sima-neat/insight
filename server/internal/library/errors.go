package library

import (
	"errors"
	"fmt"
	"net/http"
	"syscall"

	"insight/internal/apierr"
	"insight/internal/media"
)

// The codes of the library's errors (apierr.Error); anything else is a 500 internal_error.
const (
	CodeInvalidRequest     = "invalid_request"     // 400: a malformed request
	CodeInvalidPath        = "invalid_path"        // 400: a path outside the library, hidden, or the library itself
	CodeInvalidArchive     = "invalid_archive"     // 400: an archive that cannot be read or holds what the library refuses
	CodeNotFound           = "not_found"           // 404: no such file, folder or catalog asset
	CodeInUse              = "in_use"              // 409: slots use the file; the error's Slots name them
	CodeNameTaken          = "name_taken"          // 409: the name is taken; the error's Conflict says by what
	CodeTooLarge           = "too_large"           // 413: the upload, or what an archive unpacks to, is too large
	CodeNoSpace            = "no_space"            // 507: the media folder's disk is full
	CodeCatalogUnavailable = "catalog_unavailable" // 502: the catalog could not be fetched or read
	CodeFFmpegMissing      = "ffmpeg_missing"      // 503: the work needs FFmpeg, which is not installed
	CodeNotPreviewable     = "not_previewable"     // 415: the probe read no video or picture in the file
)

func invalidRequest(format string, args ...any) *apierr.Error {
	return &apierr.Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: fmt.Sprintf(format, args...)}
}

func invalidArchive(format string, args ...any) *apierr.Error {
	return &apierr.Error{Status: http.StatusBadRequest, Code: CodeInvalidArchive, Message: fmt.Sprintf(format, args...)}
}

func notFound(format string, args ...any) *apierr.Error {
	return &apierr.Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: fmt.Sprintf(format, args...)}
}

func tooLarge(limit int64) *apierr.Error {
	return &apierr.Error{
		Status: http.StatusRequestEntityTooLarge, Code: CodeTooLarge,
		Message: fmt.Sprintf("The upload is larger than %s.", sizeText(limit)),
	}
}

// pathError turns a refusal of media.Resolve into invalid_path; other errors (the media folder
// cannot be read) stay as they are.
func pathError(rel string, err error) error {
	if errors.Is(err, media.ErrInvalidPath) {
		return &apierr.Error{
			Status: http.StatusBadRequest, Code: CodeInvalidPath, Err: err,
			Message: fmt.Sprintf("%q is not a path in the media library.", rel),
		}
	}
	return err
}

// saveError says that writing to the media folder failed while doing what, as no_space when
// its disk is full.
func saveError(doing string, err error) error {
	if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) {
		return &apierr.Error{
			Status: http.StatusInsufficientStorage, Code: CodeNoSpace, Err: err,
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
