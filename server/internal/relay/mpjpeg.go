package relay

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
)

// A producer writes ffmpeg's mpjpeg format (`-f mpjpeg`): each JPEG as a part with a boundary
// line, headers and the picture, whose Content-Length says how long it is. The relay reads
// pictures by that length rather than by scanning for JPEG markers: a stream-copied camera
// picture may carry an EXIF thumbnail with markers of its own, and the length needs no scan.

const (
	// Boundary is the boundary of the relay's own multipart responses. It is frozen: apps
	// read /stream/http/srcN.mjpg with it.
	Boundary = "frame"
	// ContentType is the relay's response type.
	ContentType = "multipart/x-mixed-replace; boundary=" + Boundary

	maxFrameBytes  = 16 << 20 // larger than any picture a board streams
	maxLineBytes   = 4 << 10
	maxHeaderLines = 32
)

var (
	errMalformed = errors.New("not ffmpeg's mpjpeg output")
	errNotJPEG   = errors.New("a part that is not a JPEG")
)

// readFrames reads a producer's output and calls frame with each picture, a new slice each
// time. It returns nil when the output ends (a picture cut off by the end included), and an
// error when the output is not mpjpeg.
func readFrames(r io.Reader, frame func(jpeg []byte)) error {
	in := bufio.NewReaderSize(r, 64<<10)
	for {
		line, err := readLine(in)
		if err != nil {
			return endOfOutput(err)
		}
		if len(line) == 0 {
			continue
		}
		if !bytes.HasPrefix(line, []byte("--")) {
			return fmt.Errorf("%w: a line %.40q where a boundary belongs", errMalformed, line)
		}
		size, err := readPartHeader(in)
		if err != nil {
			return endOfOutput(err)
		}
		jpeg := make([]byte, size)
		if _, err := io.ReadFull(in, jpeg); err != nil {
			return endOfOutput(err)
		}
		if size < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
			return errNotJPEG
		}
		frame(jpeg)
	}
}

// readPartHeader reads a part's headers up to the blank line and returns its Content-Length.
// An end of output before the blank line, a trailing boundary for one, is io.EOF.
func readPartHeader(in *bufio.Reader) (int, error) {
	size := -1
	for range maxHeaderLines {
		line, err := readLine(in)
		if err != nil {
			return 0, err
		}
		if len(line) == 0 {
			if size < 0 {
				return 0, fmt.Errorf("%w: a part without Content-Length", errMalformed)
			}
			return size, nil
		}
		name, value, ok := bytes.Cut(line, []byte(":"))
		if !ok {
			return 0, fmt.Errorf("%w: a header line %.40q", errMalformed, line)
		}
		if !bytes.EqualFold(bytes.TrimSpace(name), []byte("Content-Length")) {
			continue
		}
		n, err := strconv.Atoi(string(bytes.TrimSpace(value)))
		if err != nil || n < 0 || n > maxFrameBytes {
			return 0, fmt.Errorf("%w: Content-Length %.40q", errMalformed, value)
		}
		size = n
	}
	return 0, fmt.Errorf("%w: more than %d header lines", errMalformed, maxHeaderLines)
}

// readLine returns the next line without its line ending. A line longer than maxLineBytes is
// not mpjpeg (whose lines are a boundary and short headers), so it is refused rather than
// buffered.
func readLine(in *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := in.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > maxLineBytes {
			return nil, fmt.Errorf("%w: a line longer than %d bytes", errMalformed, maxLineBytes)
		}
		if err == nil {
			return bytes.TrimRight(line, "\r\n"), nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

// endOfOutput says whether err is the output's end (nil) or a failure to read it. A pipe the
// relay closed once the producer exited is an end too.
func endOfOutput(err error) error {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, os.ErrClosed) {
		return nil
	}
	return err
}

// openingBoundary begins the relay's response; each part ends with the next boundary.
const openingBoundary = "--" + Boundary + "\r\n"

// appendPart appends jpeg as one part of the relay's response: its headers, the picture and the
// boundary after it. The boundary goes out with the picture, as ffmpeg's muxer writes it,
// because a reader (a browser, Go's mime/multipart) knows a part has ended only at the next
// boundary: sent with the next picture, it would hold each picture back by one.
func appendPart(dst, jpeg []byte) []byte {
	dst = append(dst, "Content-Type: image/jpeg\r\nContent-Length: "...)
	dst = strconv.AppendInt(dst, int64(len(jpeg)), 10)
	dst = append(dst, "\r\n\r\n"...)
	dst = append(dst, jpeg...)
	return append(dst, "\r\n"+openingBoundary...)
}
