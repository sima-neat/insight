package channels

import (
	"bytes"
	"encoding/binary"
	"net/netip"
	"testing"
	"time"
)

// Carried over from vf's tests (webrtc/metadata_reassembly_test.go).

var sender = netip.MustParseAddrPort("192.0.2.1:5000")

func chunk(messageID uint64, index, count byte, payload []byte) []byte {
	datagram := make([]byte, chunkHeaderSize+len(payload))
	datagram[0], datagram[1] = chunkMagic, chunkVersion
	binary.BigEndian.PutUint64(datagram[2:10], messageID)
	datagram[10], datagram[11] = index, count
	copy(datagram[chunkHeaderSize:], payload)
	return datagram
}

var t0 = time.Unix(1, 0)

func TestAWholeMessagePassesUnchanged(t *testing.T) {
	payload := []byte(`{"type":"object-detection","data":{"objects":[]}}`)
	got := newReassembler().accept(payload, sender, t0)
	if !got.complete || got.chunked || got.reassembled || got.dropped != 0 || !bytes.Equal(got.message, payload) {
		t.Fatalf("%+v", got)
	}
}

func TestChunksAreJoinedInAnyOrder(t *testing.T) {
	want := []byte(`{"type":"tracking","data":{"tracks":[]}}`)
	first, second := []byte(`{"type":"tracking",`), []byte(`"data":{"tracks":[]}}`)

	r := newReassembler()
	if got := r.accept(chunk(7, 0, 2, first), sender, t0); got.complete || !got.chunked {
		t.Fatalf("first: %+v", got)
	}
	if got := r.accept(chunk(7, 1, 2, second), sender, t0); !got.complete || !got.reassembled || !bytes.Equal(got.message, want) {
		t.Fatalf("second: %+v", got)
	}

	r = newReassembler()
	r.accept(chunk(9, 1, 2, second), sender, t0)
	if got := r.accept(chunk(9, 0, 2, first), sender, t0); !got.complete || !bytes.Equal(got.message, want) {
		t.Fatalf("out of order: %+v", got)
	}
}

func TestAnIdenticalDuplicateChunkIsIgnored(t *testing.T) {
	r := newReassembler()
	first := chunk(11, 0, 2, []byte(`{"value":`))
	r.accept(first, sender, t0)
	if got := r.accept(first, sender, t0); got.complete || got.dropped != 0 {
		t.Fatalf("duplicate: %+v", got)
	}
	if got := r.accept(chunk(11, 1, 2, []byte(`42}`)), sender, t0); !got.complete || string(got.message) != `{"value":42}` {
		t.Fatalf("%+v", got)
	}
}

func TestAnIncompleteMessageExpires(t *testing.T) {
	r := newReassembler()
	r.accept(chunk(21, 0, 2, []byte(`{"old":`)), sender, t0)
	if got := r.accept(chunk(22, 0, 2, []byte(`{"new":`)), sender, t0.Add(reassemblyMaxAge+time.Nanosecond)); got.dropped != 1 {
		t.Fatalf("%+v", got)
	}
	if got := r.accept(chunk(21, 1, 2, []byte(`1}`)), sender, t0.Add(time.Second)); got.complete {
		t.Fatal("a late chunk revived an expired message")
	}
}

func TestTheOldestMessageGoesAtCapacity(t *testing.T) {
	r := newReassembler()
	for id := uint64(1); id <= reassemblyPerSource; id++ {
		if got := r.accept(chunk(id, 0, 2, []byte(`{"v":`)), sender, t0.Add(time.Duration(id)*time.Millisecond)); got.dropped != 0 {
			t.Fatalf("message %d: %+v", id, got)
		}
	}
	if got := r.accept(chunk(reassemblyPerSource+1, 0, 2, []byte(`{"v":`)), sender, t0.Add(10*time.Millisecond)); got.dropped != 1 {
		t.Fatalf("%+v", got)
	}
	if got := r.accept(chunk(1, 1, 2, []byte(`1}`)), sender, t0.Add(11*time.Millisecond)); got.complete {
		t.Fatal("the evicted message completed")
	}
}

func TestMalformedChunksAreDropped(t *testing.T) {
	valid := chunk(31, 0, 2, []byte(`{"value":`))
	mutate := func(at int, value byte) []byte {
		bad := append([]byte(nil), valid...)
		bad[at] = value
		return bad
	}
	cases := map[string][]byte{
		"a short header":       {chunkMagic, chunkVersion},
		"another version":      mutate(1, chunkVersion+1),
		"no chunks":            mutate(11, 0),
		"an index past them":   mutate(10, 2),
		"an empty fragment":    chunk(31, 0, 2, nil),
		"too many chunks":      chunk(31, 0, maxChunkCount+1, []byte(`{`)),
		"an oversize datagram": chunk(31, 0, 2, make([]byte, chunkPayloadSize+1)),
	}
	for name, datagram := range cases {
		t.Run(name, func(t *testing.T) {
			if got := newReassembler().accept(datagram, sender, t0); !got.chunked || got.complete || got.dropped != 1 {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestConflictingChunksDropTheMessage(t *testing.T) {
	r := newReassembler()
	r.accept(chunk(41, 0, 2, []byte(`{"value":`)), sender, t0)
	if got := r.accept(chunk(41, 1, 3, []byte(`1}`)), sender, t0); got.complete || got.dropped != 1 {
		t.Fatalf("another count: %+v", got)
	}
	r.accept(chunk(42, 0, 2, []byte(`{"value":`)), sender, t0)
	if got := r.accept(chunk(42, 0, 2, []byte(`{"other":`)), sender, t0); got.complete || got.dropped != 1 {
		t.Fatalf("another content: %+v", got)
	}
}

func TestTheLargestMessageFitsAndOneByteMoreDoesNot(t *testing.T) {
	send := func(id uint64, size int) reassembled {
		payload := bytes.Repeat([]byte{'x'}, size)
		count := byte((size + chunkPayloadSize - 1) / chunkPayloadSize)
		r := newReassembler()
		var got reassembled
		for index, offset := byte(0), 0; offset < size; index, offset = index+1, offset+chunkPayloadSize {
			got = r.accept(chunk(id, index, count, payload[offset:min(offset+chunkPayloadSize, size)]), sender, t0)
		}
		return got
	}
	if got := send(52, maxMessageSize); !got.complete || len(got.message) != maxMessageSize {
		t.Fatalf("the largest message: complete %v, %d bytes", got.complete, len(got.message))
	}
	if got := send(51, maxMessageSize+1); got.complete || got.dropped != 1 {
		t.Fatalf("one byte more: %+v", got)
	}
}
