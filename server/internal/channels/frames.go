package channels

import (
	"encoding/binary"
	"fmt"
)

// The sending side of the jpeg data channel (docs/contracts.md, "What a viewer's connection
// carries"). A JPEG channel's frames, each a complete baseline JFIF, travel to the browser as
// messages of the viewer's `jpeg` channel: one message is one chunk of one frame, an 8 byte header
// (the RTP timestamp, u32 big-endian; the chunk's index from 0, u16 big-endian; the chunk count,
// at least 1, u16 big-endian) and up to 60,000 bytes of the frame. A frame's chunks go out in index
// order before any chunk of the next frame. Before each frame the viewer's buffered amount is
// checked, and a viewer over 512 KiB skips the whole frame, never part of one. A failed send closes
// that viewer's channel, which makes the browser rebuild its connection.

const (
	jpegChunkHeaderBytes = 8
	jpegChunkBytes       = 60000
	jpegMaxBufferedBytes = 512 << 10
)

// jpegChunks cuts a frame into the messages of the protocol. They are built once and shared by
// every viewer. An empty frame has none.
func jpegChunks(timestamp uint32, frame []byte) [][]byte {
	count := (len(frame) + jpegChunkBytes - 1) / jpegChunkBytes
	chunks := make([][]byte, 0, count)
	for i := 0; i < count; i++ {
		part := frame[i*jpegChunkBytes : min((i+1)*jpegChunkBytes, len(frame))]
		msg := make([]byte, jpegChunkHeaderBytes+len(part))
		binary.BigEndian.PutUint32(msg[0:], timestamp)
		binary.BigEndian.PutUint16(msg[4:], uint16(i))
		binary.BigEndian.PutUint16(msg[6:], uint16(count))
		copy(msg[jpegChunkHeaderBytes:], part)
		chunks = append(chunks, msg)
	}
	return chunks
}

// frameChannel is what a viewer's jpeg channel offers the sender; *webrtc.DataChannel has it.
type frameChannel interface {
	BufferedAmount() uint64
	Send([]byte) error
	Close() error
}

// frameSendResult says what one frame did: how many viewers took it whole, how many skipped it
// because their buffer was full, and which channels failed and why.
type frameSendResult[C frameChannel] struct {
	Took, Skipped int
	Failures      []frameFailure[C]
}

// frameFailure is a channel whose send failed, closed for it, and the reason, so that the caller
// can drop it from its set.
type frameFailure[C frameChannel] struct {
	Channel C
	Err     error
}

// sendJPEGFrame sends one frame's chunks to every channel that has room for it.
func sendJPEGFrame[C frameChannel](channels []C, chunks [][]byte) frameSendResult[C] {
	var res frameSendResult[C]
	for _, ch := range channels {
		if ch.BufferedAmount() > jpegMaxBufferedBytes {
			res.Skipped++
			continue
		}
		if err := sendChunks(ch, chunks); err != nil {
			res.Failures = append(res.Failures, frameFailure[C]{ch, err})
			_ = ch.Close()
			continue
		}
		res.Took++
	}
	return res
}

func sendChunks(ch frameChannel, chunks [][]byte) error {
	for i, msg := range chunks {
		if err := ch.Send(msg); err != nil {
			return fmt.Errorf("sending chunk %d of %d: %w", i+1, len(chunks), err)
		}
	}
	return nil
}
