package main

import (
	"bytes"
	"encoding/binary"
	"net"
	"time"
)

const (
	metadataChunkMagic            = byte(0x4e)
	metadataChunkVersion          = byte(0x01)
	metadataChunkHeaderSize       = 12
	metadataMaxDatagramSize       = 1200
	metadataChunkPayloadSize      = metadataMaxDatagramSize - metadataChunkHeaderSize
	metadataMaxLogicalMessageSize = 65507
	metadataMaxChunkCount         = 56
	metadataReassemblyMaxAge      = 250 * time.Millisecond
	metadataReassemblyCapacity    = 4
)

type metadataReassemblyResult struct {
	message     []byte
	complete    bool
	chunked     bool
	reassembled bool
	dropped     uint64
}

type metadataAssemblyKey struct {
	source    string
	messageID uint64
}

type metadataAssembly struct {
	chunks   [][]byte
	received int
	size     int
	started  time.Time
}

type metadataReassembler struct {
	assemblies map[metadataAssemblyKey]*metadataAssembly
}

func newMetadataReassembler() *metadataReassembler {
	return &metadataReassembler{assemblies: make(map[metadataAssemblyKey]*metadataAssembly)}
}

// accept returns legacy JSON immediately. Chunked messages are returned only
// after every fragment has arrived.
func (r *metadataReassembler) accept(datagram []byte, source net.Addr, now time.Time) metadataReassemblyResult {
	dropped := r.dropExpired(now)
	if len(datagram) == 0 || datagram[0] != metadataChunkMagic {
		return metadataReassemblyResult{message: datagram, complete: true, dropped: dropped}
	}
	result := metadataReassemblyResult{chunked: true, dropped: dropped}
	if len(datagram) < metadataChunkHeaderSize || len(datagram) > metadataMaxDatagramSize || datagram[1] != metadataChunkVersion {
		result.dropped++
		return result
	}

	index := int(datagram[10])
	count := int(datagram[11])
	if count == 0 || count > metadataMaxChunkCount || index >= count || len(datagram) == metadataChunkHeaderSize {
		result.dropped++
		return result
	}

	key := metadataAssemblyKey{messageID: binary.BigEndian.Uint64(datagram[2:10])}
	if source != nil {
		key.source = source.String()
	}
	assembly := r.assemblies[key]
	if assembly == nil {
		if len(r.assemblies) == metadataReassemblyCapacity && r.dropOldest() {
			result.dropped++
		}
		assembly = &metadataAssembly{chunks: make([][]byte, count), started: now}
		r.assemblies[key] = assembly
	}
	if len(assembly.chunks) != count {
		delete(r.assemblies, key)
		result.dropped++
		return result
	}
	fragment := datagram[metadataChunkHeaderSize:]
	if assembly.chunks[index] == nil {
		if assembly.size+len(fragment) > metadataMaxLogicalMessageSize {
			delete(r.assemblies, key)
			result.dropped++
			return result
		}
		assembly.chunks[index] = append([]byte(nil), fragment...)
		assembly.received++
		assembly.size += len(fragment)
	} else if !bytes.Equal(assembly.chunks[index], fragment) {
		delete(r.assemblies, key)
		result.dropped++
		return result
	}
	if assembly.received != len(assembly.chunks) {
		return result
	}

	message := make([]byte, 0, assembly.size)
	for _, chunk := range assembly.chunks {
		message = append(message, chunk...)
	}
	delete(r.assemblies, key)
	result.message = message
	result.complete = true
	result.reassembled = true
	return result
}

func (r *metadataReassembler) dropOldest() bool {
	var (
		oldestKey metadataAssemblyKey
		oldestAt  time.Time
		found     bool
	)
	for key, assembly := range r.assemblies {
		if !found || assembly.started.Before(oldestAt) {
			oldestKey = key
			oldestAt = assembly.started
			found = true
		}
	}
	if found {
		delete(r.assemblies, oldestKey)
	}
	return found
}

func (r *metadataReassembler) dropExpired(now time.Time) uint64 {
	var dropped uint64
	for key, assembly := range r.assemblies {
		if now.Sub(assembly.started) <= metadataReassemblyMaxAge {
			continue
		}
		delete(r.assemblies, key)
		dropped++
	}
	return dropped
}
