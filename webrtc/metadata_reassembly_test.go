package main

import (
	"bytes"
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func metadataChunk(messageID uint64, index, count byte, payload []byte) []byte {
	datagram := make([]byte, metadataChunkHeaderSize+len(payload))
	datagram[0] = metadataChunkMagic
	datagram[1] = metadataChunkVersion
	binary.BigEndian.PutUint64(datagram[2:10], messageID)
	datagram[10] = index
	datagram[11] = count
	copy(datagram[metadataChunkHeaderSize:], payload)
	return datagram
}

func TestMetadataReassemblerPassesLegacyJSONUnchanged(t *testing.T) {
	reassembler := newMetadataReassembler()
	payload := []byte(`{"type":"object-detection","data":{"objects":[]}}`)

	result := reassembler.accept(payload, &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}, time.Unix(1, 0))

	if !result.complete {
		t.Fatal("expected a legacy datagram to produce a complete message")
	}
	if result.chunked || result.reassembled || result.dropped != 0 {
		t.Fatalf("expected no chunk activity for legacy JSON, got %#v", result)
	}
	if !bytes.Equal(result.message, payload) {
		t.Fatalf("expected legacy JSON to pass through unchanged, got %q", result.message)
	}
}

func TestMetadataReassemblerJoinsOrderedChunks(t *testing.T) {
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	now := time.Unix(1, 0)

	first := reassembler.accept(metadataChunk(7, 0, 2, []byte(`{"type":"tracking",`)), source, now)
	if first.complete || !first.chunked || first.reassembled || first.dropped != 0 {
		t.Fatalf("expected the first chunk to wait, got %#v", first)
	}

	second := reassembler.accept(metadataChunk(7, 1, 2, []byte(`"data":{"tracks":[]}}`)), source, now)
	if !second.complete || !second.chunked || !second.reassembled || second.dropped != 0 {
		t.Fatalf("expected the second chunk to complete reassembly, got %#v", second)
	}
	want := []byte(`{"type":"tracking","data":{"tracks":[]}}`)
	if !bytes.Equal(second.message, want) {
		t.Fatalf("expected %q, got %q", want, second.message)
	}
}

func TestMetadataReassemblerJoinsOutOfOrderChunks(t *testing.T) {
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	now := time.Unix(1, 0)

	last := reassembler.accept(metadataChunk(9, 1, 2, []byte(`"data":{"tracks":[]}}`)), source, now)
	if last.complete {
		t.Fatal("expected an out-of-order final chunk to wait")
	}
	first := reassembler.accept(metadataChunk(9, 0, 2, []byte(`{"type":"tracking",`)), source, now)

	want := []byte(`{"type":"tracking","data":{"tracks":[]}}`)
	if !first.complete || !first.reassembled || !bytes.Equal(first.message, want) {
		t.Fatalf("expected out-of-order chunks to reconstruct %q, got %#v", want, first)
	}
}

func TestMetadataReassemblerIgnoresIdenticalDuplicateChunks(t *testing.T) {
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	now := time.Unix(1, 0)
	first := metadataChunk(11, 0, 2, []byte(`{"value":`))

	if result := reassembler.accept(first, source, now); result.complete {
		t.Fatal("expected the first chunk to wait")
	}
	duplicate := reassembler.accept(first, source, now)
	if duplicate.complete || duplicate.dropped != 0 {
		t.Fatalf("expected an identical duplicate to be ignored, got %#v", duplicate)
	}
	complete := reassembler.accept(metadataChunk(11, 1, 2, []byte(`42}`)), source, now)
	if !complete.complete || !bytes.Equal(complete.message, []byte(`{"value":42}`)) {
		t.Fatalf("expected one complete message after the duplicate, got %#v", complete)
	}
}

func TestMetadataReassemblerExpiresIncompleteMessages(t *testing.T) {
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	now := time.Unix(1, 0)

	reassembler.accept(metadataChunk(21, 0, 2, []byte(`{"old":`)), source, now)
	trigger := reassembler.accept(
		metadataChunk(22, 0, 2, []byte(`{"new":`)),
		source,
		now.Add(metadataReassemblyMaxAge+time.Nanosecond),
	)
	if trigger.dropped != 1 {
		t.Fatalf("expected one expired message to be dropped, got %#v", trigger)
	}

	late := reassembler.accept(metadataChunk(21, 1, 2, []byte(`1}`)), source, now.Add(time.Second))
	if late.complete {
		t.Fatal("expected a late chunk not to revive the expired message")
	}
}

func TestMetadataReassemblerEvictsOldestMessageAtCapacity(t *testing.T) {
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	now := time.Unix(1, 0)

	for messageID := uint64(1); messageID <= metadataReassemblyCapacity; messageID++ {
		result := reassembler.accept(
			metadataChunk(messageID, 0, 2, []byte(`{"value":`)),
			source,
			now.Add(time.Duration(messageID)*time.Millisecond),
		)
		if result.dropped != 0 {
			t.Fatalf("expected message %d to fit, got %#v", messageID, result)
		}
	}

	overflow := reassembler.accept(
		metadataChunk(metadataReassemblyCapacity+1, 0, 2, []byte(`{"value":`)),
		source,
		now.Add(10*time.Millisecond),
	)
	if overflow.dropped != 1 {
		t.Fatalf("expected capacity overflow to evict one message, got %#v", overflow)
	}

	oldTail := reassembler.accept(metadataChunk(1, 1, 2, []byte(`1}`)), source, now.Add(11*time.Millisecond))
	if oldTail.complete {
		t.Fatal("expected the evicted oldest message not to complete")
	}
}

func TestMetadataReassemblerRejectsMalformedChunks(t *testing.T) {
	valid := metadataChunk(31, 0, 2, []byte(`{"value":`))
	unknownVersion := append([]byte(nil), valid...)
	unknownVersion[1]++
	zeroCount := append([]byte(nil), valid...)
	zeroCount[11] = 0
	invalidIndex := append([]byte(nil), valid...)
	invalidIndex[10] = invalidIndex[11]
	emptyFragment := metadataChunk(31, 0, 2, nil)
	tooManyChunks := metadataChunk(31, 0, metadataMaxChunkCount+1, []byte(`{`))
	oversizedDatagram := metadataChunk(31, 0, 2, make([]byte, metadataChunkPayloadSize+1))

	tests := []struct {
		name     string
		datagram []byte
	}{
		{name: "short header", datagram: []byte{metadataChunkMagic, metadataChunkVersion}},
		{name: "unknown version", datagram: unknownVersion},
		{name: "zero count", datagram: zeroCount},
		{name: "index outside count", datagram: invalidIndex},
		{name: "empty fragment", datagram: emptyFragment},
		{name: "too many chunks", datagram: tooManyChunks},
		{name: "oversized datagram", datagram: oversizedDatagram},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := newMetadataReassembler().accept(tt.datagram, nil, time.Unix(1, 0))
			if !result.chunked || result.complete || result.dropped != 1 {
				t.Fatalf("expected malformed chunk to be dropped, got %#v", result)
			}
		})
	}
}

func TestMetadataReassemblerDropsConflictingChunkCount(t *testing.T) {
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	now := time.Unix(1, 0)
	reassembler.accept(metadataChunk(41, 0, 2, []byte(`{"value":`)), source, now)

	conflict := reassembler.accept(metadataChunk(41, 1, 3, []byte(`1}`)), source, now)
	if conflict.complete || conflict.dropped != 1 {
		t.Fatalf("expected conflicting chunk counts to drop the assembly, got %#v", conflict)
	}
}

func TestMetadataReassemblerDropsConflictingDuplicate(t *testing.T) {
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	now := time.Unix(1, 0)
	reassembler.accept(metadataChunk(42, 0, 2, []byte(`{"value":`)), source, now)

	conflict := reassembler.accept(metadataChunk(42, 0, 2, []byte(`{"other":`)), source, now)
	if conflict.complete || conflict.dropped != 1 {
		t.Fatalf("expected conflicting duplicate data to drop the assembly, got %#v", conflict)
	}
}

func TestMetadataReassemblerRejectsOversizedLogicalMessage(t *testing.T) {
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	payload := bytes.Repeat([]byte{'x'}, metadataMaxLogicalMessageSize+1)
	count := byte((len(payload) + metadataChunkPayloadSize - 1) / metadataChunkPayloadSize)
	var result metadataReassemblyResult

	for index, offset := byte(0), 0; offset < len(payload); index, offset = index+1, offset+metadataChunkPayloadSize {
		end := min(offset+metadataChunkPayloadSize, len(payload))
		result = reassembler.accept(metadataChunk(51, index, count, payload[offset:end]), source, time.Unix(1, 0))
	}

	if result.complete || result.dropped != 1 {
		t.Fatalf("expected an oversized logical message to be dropped, got %#v", result)
	}
}

func TestMetadataReassemblerAcceptsMaximumLogicalMessage(t *testing.T) {
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	payload := bytes.Repeat([]byte{'x'}, metadataMaxLogicalMessageSize)
	count := byte((len(payload) + metadataChunkPayloadSize - 1) / metadataChunkPayloadSize)
	var result metadataReassemblyResult

	for index, offset := byte(0), 0; offset < len(payload); index, offset = index+1, offset+metadataChunkPayloadSize {
		end := min(offset+metadataChunkPayloadSize, len(payload))
		result = reassembler.accept(metadataChunk(52, index, count, payload[offset:end]), source, time.Unix(1, 0))
	}

	if !result.complete || !result.reassembled || !bytes.Equal(result.message, payload) {
		t.Fatalf("expected a %d-byte logical message to be reassembled", len(payload))
	}
}

func BenchmarkMetadataReassemblerLegacy(b *testing.B) {
	reassembler := newMetadataReassembler()
	payload := []byte(`{"type":"object-detection","data":{"objects":[]}}`)
	b.ReportAllocs()
	for b.Loop() {
		result := reassembler.accept(payload, nil, time.Time{})
		if !result.complete {
			b.Fatal("expected a complete legacy message")
		}
	}
}

func BenchmarkMetadataReassemblerTwoChunks(b *testing.B) {
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	first := metadataChunk(71, 0, 2, bytes.Repeat([]byte{'x'}, metadataChunkPayloadSize))
	second := metadataChunk(71, 1, 2, bytes.Repeat([]byte{'x'}, 500))
	b.ReportAllocs()
	for b.Loop() {
		reassembler.accept(first, source, time.Time{})
		result := reassembler.accept(second, source, time.Time{})
		if !result.complete {
			b.Fatal("expected a complete chunked message")
		}
	}
}
