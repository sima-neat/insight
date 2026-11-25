package channels

import (
	"bytes"
	"errors"
	"testing"
)

// fakeViewer is a frameChannel that records what it is sent.
type fakeViewer struct {
	buffered uint64
	failAt   int // the 1-based send that fails; 0 never
	sent     [][]byte
	closed   int
}

func (f *fakeViewer) BufferedAmount() uint64 { return f.buffered }

func (f *fakeViewer) Send(msg []byte) error {
	if f.failAt != 0 && len(f.sent)+1 == f.failAt {
		return errors.New("channel is closing")
	}
	f.sent = append(f.sent, msg)
	return nil
}

func (f *fakeViewer) Close() error {
	f.closed++
	return nil
}

func TestAFrameIsChunkedWithItsHeaderBigEndian(t *testing.T) {
	chunks := jpegChunks(0x01020304, make([]byte, 130000))
	if len(chunks) != 3 {
		t.Fatalf("got %d messages, want 3", len(chunks))
	}
	for i, want := range [][]byte{
		{1, 2, 3, 4, 0, 0, 0, 3},
		{1, 2, 3, 4, 0, 1, 0, 3},
		{1, 2, 3, 4, 0, 2, 0, 3},
	} {
		if got := chunks[i][:jpegChunkHeaderBytes]; !bytes.Equal(got, want) {
			t.Errorf("message %d header = % x, want % x", i, got, want)
		}
	}
	if got := len(chunks[2]) - jpegChunkHeaderBytes; got != 10000 {
		t.Errorf("last chunk carries %d bytes, want 10000", got)
	}
}

func TestAFrameOfExactlyTwoChunksAndATimestampAtTheWrap(t *testing.T) {
	chunks := jpegChunks(0xFFFFFFFF, make([]byte, 120000))
	if len(chunks) != 2 {
		t.Fatalf("got %d messages, want 2", len(chunks))
	}
	for i, c := range chunks {
		if len(c) != 60008 {
			t.Errorf("message %d is %d bytes, want 60008", i, len(c))
		}
		if !bytes.Equal(c[:4], []byte{0xFF, 0xFF, 0xFF, 0xFF}) {
			t.Errorf("message %d timestamp = % x", i, c[:4])
		}
	}
}

func TestAOneByteFrameIsOneChunk(t *testing.T) {
	chunks := jpegChunks(7, []byte{0xAB})
	want := []byte{0, 0, 0, 7, 0, 0, 0, 1, 0xAB}
	if len(chunks) != 1 || !bytes.Equal(chunks[0], want) {
		t.Fatalf("chunks = % x, want [% x]", chunks, want)
	}
}

func TestChunksCarryTheFrameInOrder(t *testing.T) {
	frame := make([]byte, 130000)
	for i := range frame {
		frame[i] = byte(i * 7)
	}
	var got []byte
	for _, c := range jpegChunks(1, frame) {
		got = append(got, c[jpegChunkHeaderBytes:]...)
	}
	if !bytes.Equal(got, frame) {
		t.Error("the chunks' bytes joined are not the frame")
	}
}

func TestAViewerOverItsBufferSkipsTheWholeFrame(t *testing.T) {
	full := &fakeViewer{buffered: 600 << 10}
	other := &fakeViewer{}
	chunks := jpegChunks(1, make([]byte, 130000))

	res := sendJPEGFrame([]*fakeViewer{full, other}, chunks)

	if len(full.sent) != 0 {
		t.Errorf("the full viewer got %d messages, want 0", len(full.sent))
	}
	if len(other.sent) != 3 {
		t.Errorf("the other viewer got %d messages, want 3", len(other.sent))
	}
	if res.Took != 1 || res.Skipped != 1 || len(res.Failures) != 0 {
		t.Errorf("result = %+v, want Took 1, Skipped 1, no failures", res)
	}
}

func TestASkippingViewerGetsTheNextWholeFrameOnceItDrains(t *testing.T) {
	v := &fakeViewer{buffered: jpegMaxBufferedBytes + 1}
	first := jpegChunks(1, make([]byte, 130000))
	second := jpegChunks(2, make([]byte, 130000))

	sendJPEGFrame([]*fakeViewer{v}, first)
	v.buffered = jpegMaxBufferedBytes // at the limit is not over it
	res := sendJPEGFrame([]*fakeViewer{v}, second)

	if res.Took != 1 || res.Skipped != 0 {
		t.Errorf("result = %+v, want Took 1, Skipped 0", res)
	}
	if len(v.sent) != 3 {
		t.Fatalf("got %d messages, want the second frame's 3", len(v.sent))
	}
	for i, m := range v.sent {
		if !bytes.Equal(m, second[i]) {
			t.Errorf("message %d is not the second frame's chunk", i)
		}
	}
}

func TestAFailedSendClosesThatViewerOnly(t *testing.T) {
	bad := &fakeViewer{failAt: 2}
	good := &fakeViewer{}
	chunks := jpegChunks(1, make([]byte, 130000))

	res := sendJPEGFrame([]*fakeViewer{bad, good}, chunks)

	if len(bad.sent) != 1 || bad.closed != 1 {
		t.Errorf("failing viewer: %d sent, %d closed, want 1 and 1", len(bad.sent), bad.closed)
	}
	if len(good.sent) != 3 || good.closed != 0 {
		t.Errorf("good viewer: %d sent, %d closed, want 3 and 0", len(good.sent), good.closed)
	}
	if res.Took != 1 || res.Skipped != 0 || len(res.Failures) != 1 || res.Failures[0].Channel != bad {
		t.Errorf("result = %+v, want Took 1, Skipped 0, the failing viewer's failure", res)
	}
}

// The sets of later tasks hold the interface itself.
func TestTheInterfaceTypeIsAChannelSet(t *testing.T) {
	v := &fakeViewer{}
	res := sendJPEGFrame([]frameChannel{v}, jpegChunks(1, []byte{1}))
	if res.Took != 1 || len(v.sent) != 1 {
		t.Errorf("result = %+v, sent %d", res, len(v.sent))
	}
}
