package channels

import (
	"bytes"
	"encoding/binary"
	"net/netip"
	"time"
)

// The metadata chunk format of the contract (docs/contracts.md, "Metadata datagrams"), which
// Neat's MetadataSender writes for messages over 1,200 bytes.
const (
	chunkMagic          = byte(0x4e) // no JSON text starts with it
	chunkVersion        = byte(0x01)
	chunkHeaderSize     = 12
	maxChunkDatagram    = 1200
	chunkPayloadSize    = maxChunkDatagram - chunkHeaderSize
	maxMessageSize      = 65507
	maxChunkCount       = 56
	reassemblyMaxAge    = 250 * time.Millisecond
	reassemblyPerSource = 4 // messages being joined at once per channel
)

// reassembled is what one datagram led to.
type reassembled struct {
	message     []byte // a whole message, when complete
	complete    bool
	chunked     bool   // the datagram was a chunk
	reassembled bool   // and it completed a message
	dropped     uint64 // messages given up (malformed, expired, evicted, conflicting)
}

type assemblyKey struct {
	source    netip.AddrPort
	messageID uint64
}

type assembly struct {
	chunks   [][]byte
	received int
	size     int
	started  time.Time
}

// reassembler joins chunked messages. A datagram that is no chunk is a whole message already.
// Used by one goroutine, the channel's metadata reader.
type reassembler struct {
	assemblies map[assemblyKey]*assembly
}

func newReassembler() *reassembler {
	return &reassembler{assemblies: map[assemblyKey]*assembly{}}
}

func (r *reassembler) accept(datagram []byte, source netip.AddrPort, now time.Time) reassembled {
	dropped := r.dropExpired(now)
	if len(datagram) == 0 || datagram[0] != chunkMagic {
		return reassembled{message: datagram, complete: true, dropped: dropped}
	}
	result := reassembled{chunked: true, dropped: dropped}
	if len(datagram) <= chunkHeaderSize || len(datagram) > maxChunkDatagram || datagram[1] != chunkVersion {
		result.dropped++
		return result
	}
	index, count := int(datagram[10]), int(datagram[11])
	if count == 0 || count > maxChunkCount || index >= count {
		result.dropped++
		return result
	}

	key := assemblyKey{source: source, messageID: binary.BigEndian.Uint64(datagram[2:10])}
	a := r.assemblies[key]
	if a == nil {
		if len(r.assemblies) == reassemblyPerSource && r.dropOldest() {
			result.dropped++
		}
		a = &assembly{chunks: make([][]byte, count), started: now}
		r.assemblies[key] = a
	}
	if len(a.chunks) != count {
		delete(r.assemblies, key)
		result.dropped++
		return result
	}
	fragment := datagram[chunkHeaderSize:]
	switch {
	case a.chunks[index] == nil:
		if a.size+len(fragment) > maxMessageSize {
			delete(r.assemblies, key)
			result.dropped++
			return result
		}
		a.chunks[index] = append([]byte(nil), fragment...)
		a.received++
		a.size += len(fragment)
	case !bytes.Equal(a.chunks[index], fragment):
		// The same chunk twice with different content: one of them is wrong.
		delete(r.assemblies, key)
		result.dropped++
		return result
	}
	if a.received != len(a.chunks) {
		return result
	}
	message := make([]byte, 0, a.size)
	for _, chunk := range a.chunks {
		message = append(message, chunk...)
	}
	delete(r.assemblies, key)
	result.message, result.complete, result.reassembled = message, true, true
	return result
}

func (r *reassembler) dropOldest() bool {
	var (
		oldest assemblyKey
		at     time.Time
		found  bool
	)
	for key, a := range r.assemblies {
		if !found || a.started.Before(at) {
			oldest, at, found = key, a.started, true
		}
	}
	if found {
		delete(r.assemblies, oldest)
	}
	return found
}

func (r *reassembler) dropExpired(now time.Time) uint64 {
	var dropped uint64
	for key, a := range r.assemblies {
		if now.Sub(a.started) > reassemblyMaxAge {
			delete(r.assemblies, key)
			dropped++
		}
	}
	return dropped
}
