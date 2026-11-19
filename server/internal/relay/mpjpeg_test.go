package relay

import (
	"bytes"
	"errors"
	"io"
	"mime/multipart"
	"strconv"
	"strings"
	"testing"
)

// mpjpeg writes pictures as ffmpeg's mpjpeg muxer does.
func mpjpeg(pictures ...string) string {
	var out strings.Builder
	out.WriteString("--ffmpeg\r\n")
	for _, picture := range pictures {
		out.WriteString("Content-type: image/jpeg\r\nContent-length: " + strconv.Itoa(len(picture)) + "\r\n\r\n")
		out.WriteString(picture)
		out.WriteString("\r\n--ffmpeg\r\n")
	}
	return out.String()
}

func readAll(t *testing.T, stream string) ([]string, error) {
	t.Helper()
	var pictures []string
	err := ReadFrames(strings.NewReader(stream), func(jpeg []byte) { pictures = append(pictures, string(jpeg)) })
	return pictures, err
}

func TestReadFramesTakesEachPictureByItsLength(t *testing.T) {
	// The second picture holds an end-of-image marker and a line that looks like a boundary,
	// as an EXIF thumbnail may: the length decides, not the bytes.
	first := "\xff\xd8one\xff\xd9"
	second := "\xff\xd8\xff\xd9\r\n--ffmpeg\r\nmore\xff\xd9"
	pictures, err := readAll(t, mpjpeg(first, second))
	if err != nil {
		t.Fatal(err)
	}
	if len(pictures) != 2 || pictures[0] != first || pictures[1] != second {
		t.Fatalf("pictures %q", pictures)
	}
}

func TestReadFramesEndsQuietlyAtTheEndOfOutput(t *testing.T) {
	whole := mpjpeg("\xff\xd8abcd\xff\xd9")
	for name, stream := range map[string]string{
		"empty":            "",
		"after a boundary": whole,
		"inside headers":   whole + "Content-type: image/jpeg\r\n",
		"inside a picture": whole + "Content-length: 100\r\n\r\n\xff\xd8abc",
	} {
		pictures, err := readAll(t, stream)
		if err != nil {
			t.Errorf("%s: %v", name, err)
		}
		if want := min(len(stream), 1); len(pictures) != want {
			t.Errorf("%s: %d pictures", name, len(pictures))
		}
	}
}

func TestReadFramesRefusesWhatIsNotMpjpeg(t *testing.T) {
	for name, stream := range map[string]string{
		"raw JPEG":       "\xff\xd8\xff\xe0 a raw picture without parts\n",
		"no length":      "--ffmpeg\r\nContent-type: image/jpeg\r\n\r\n\xff\xd8\xff\xd9",
		"a bad length":   "--ffmpeg\r\nContent-length: twelve\r\n\r\n",
		"too long":       "--ffmpeg\r\nContent-length: 999999999\r\n\r\n",
		"a header w/o :": "--ffmpeg\r\nnonsense\r\n\r\n",
		"a long line":    "--" + strings.Repeat("x", 70<<10),
	} {
		if _, err := readAll(t, stream); !errors.Is(err, errMalformed) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := readAll(t, mpjpeg("PNG?")); !errors.Is(err, errNotJPEG) {
		t.Errorf("a picture that is no JPEG: %v", err)
	}
}

func TestAppendPartIsAMultipartPart(t *testing.T) {
	pictures := []string{"\xff\xd8one\xff\xd9", "\xff\xd8\r\ntwo\r\n\xff\xd9"}
	body := []byte(OpeningBoundary)
	for _, picture := range pictures {
		body = AppendPart(body, []byte(picture))
	}
	reader := multipart.NewReader(bytes.NewReader(body), Boundary)
	for _, want := range pictures {
		part, err := reader.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		if part.Header.Get("Content-Type") != "image/jpeg" || part.Header.Get("Content-Length") != strconv.Itoa(len(want)) {
			t.Errorf("headers %v", part.Header)
		}
		got, _ := io.ReadAll(part)
		if string(got) != want {
			t.Errorf("picture %q, want %q", got, want)
		}
	}
}
