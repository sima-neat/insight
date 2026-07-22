package main

import (
	"encoding/json"
	"sync"
	"time"
)

const rtpTimestampTolerance = uint32(h264ClockRate / 1000)

type rtpTimestampMapping struct {
	source   uint32
	outgoing uint32
	recorded time.Time
}

type pendingMetadata struct {
	payload  []byte
	source   uint32
	recorded time.Time
}

type correlatedMetadata struct {
	payload    []byte
	outgoing   uint32
	correlated bool
}

func (m correlatedMetadata) encode() ([]byte, error) {
	if !m.correlated {
		return m.payload, nil
	}
	return enrichMetadataTimestamp(m.payload, m.outgoing)
}

type metadataTimestampCorrelator struct {
	mu       sync.Mutex
	capacity int
	maxAge   time.Duration
	ssrc     uint32
	haveSSRC bool
	frames   []rtpTimestampMapping
	pending  []pendingMetadata
}

func newMetadataTimestampCorrelator(capacity int, maxAge time.Duration) *metadataTimestampCorrelator {
	return &metadataTimestampCorrelator{capacity: capacity, maxAge: maxAge}
}

func (c *metadataTimestampCorrelator) addVideoFrame(
	ssrc uint32,
	source uint32,
	outgoing uint32,
	now time.Time,
) []correlatedMetadata {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.haveSSRC && c.ssrc != ssrc {
		// Pending metadata has no source generation, so retaining it could match a restarted source.
		c.frames = c.frames[:0]
		c.pending = c.pending[:0]
	}
	c.ssrc = ssrc
	c.haveSSRC = true
	c.pruneFrames(now)
	c.prunePending(now)
	c.frames = append(c.frames, rtpTimestampMapping{source: source, outgoing: outgoing, recorded: now})
	if len(c.frames) > c.capacity {
		c.frames = c.frames[len(c.frames)-c.capacity:]
	}

	ready := make([]correlatedMetadata, 0)
	remaining := c.pending[:0]
	for _, pending := range c.pending {
		matched, ok := c.findOutgoingTimestamp(pending.source)
		if !ok {
			remaining = append(remaining, pending)
			continue
		}
		ready = append(ready, correlatedMetadata{
			payload: pending.payload, outgoing: matched, correlated: true,
		})
	}
	c.pending = remaining
	return ready
}

func (c *metadataTimestampCorrelator) addMetadata(payload []byte, now time.Time) []correlatedMetadata {
	timestampMS, ok := metadataTimestamp(payload)
	if !ok {
		return []correlatedMetadata{{payload: append([]byte(nil), payload...)}}
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.pruneFrames(now)
	c.prunePending(now)
	source := uint32(uint64(timestampMS) * 90)
	outgoing, ok := c.findOutgoingTimestamp(source)
	if !ok {
		c.pending = append(c.pending, pendingMetadata{
			payload:  append([]byte(nil), payload...),
			source:   source,
			recorded: now,
		})
		if len(c.pending) > c.capacity {
			c.pending = c.pending[len(c.pending)-c.capacity:]
		}
		return nil
	}
	return []correlatedMetadata{{
		payload: append([]byte(nil), payload...), outgoing: outgoing, correlated: true,
	}}
}

func (c *metadataTimestampCorrelator) prunePending(now time.Time) {
	first := 0
	for first < len(c.pending) && now.Sub(c.pending[first].recorded) > c.maxAge {
		first++
	}
	if first > 0 {
		c.pending = append(c.pending[:0], c.pending[first:]...)
	}
}

func (c *metadataTimestampCorrelator) findOutgoingTimestamp(source uint32) (uint32, bool) {
	var (
		bestDistance = rtpTimestampTolerance + 1
		outgoing     uint32
		found        bool
	)
	for i := len(c.frames) - 1; i >= 0; i-- {
		distance := rtpTimestampDistance(c.frames[i].source, source)
		if distance <= rtpTimestampTolerance && distance < bestDistance {
			bestDistance = distance
			outgoing = c.frames[i].outgoing
			found = true
		}
	}
	return outgoing, found
}

func (c *metadataTimestampCorrelator) pruneFrames(now time.Time) {
	first := 0
	for first < len(c.frames) && now.Sub(c.frames[first].recorded) > c.maxAge {
		first++
	}
	if first > 0 {
		c.frames = append(c.frames[:0], c.frames[first:]...)
	}
}

func rtpTimestampDistance(a, b uint32) uint32 {
	delta := int64(int32(a - b))
	if delta < 0 {
		delta = -delta
	}
	return uint32(delta)
}

func metadataTimestamp(payload []byte) (int64, bool) {
	var envelope struct {
		Timestamp *int64 `json:"timestamp"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil || envelope.Timestamp == nil || *envelope.Timestamp < 0 {
		return 0, false
	}
	return *envelope.Timestamp, true
}

func enrichMetadataTimestamp(payload []byte, outgoing uint32) ([]byte, error) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, err
	}
	insight, err := json.Marshal(struct {
		RTPTimestamp uint32 `json:"rtp_timestamp"`
	}{RTPTimestamp: outgoing})
	if err != nil {
		return nil, err
	}
	envelope["_insight"] = insight
	return json.Marshal(envelope)
}
