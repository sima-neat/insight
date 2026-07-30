package main

import (
	"encoding/json"
	"sync"
	"time"
)

const rtpTimestampTolerance = uint32(videoRTPClockRate / 1000)

// Bounds what a producer can echo into the stats response; payloads arrive over
// UDP from outside the process.
const maxReportedFrameIDBytes = 64

type arrival interface {
	arrivedAt() time.Time
}

// retentionBuffer holds one side of the correlator, oldest arrival first. The
// invariant the accounting rests on: an entry leaving this buffer either matched
// or lands in expired or evicted, never neither.
type retentionBuffer[T arrival] struct {
	capacity  int
	retention time.Duration
	items     []T

	// expired aged past retention; evicted was dropped while still inside it, by
	// capacity overflow or a source-restart reset.
	expired uint64
	evicted uint64
}

func newRetentionBuffer[T arrival](capacity int, retention time.Duration) *retentionBuffer[T] {
	return &retentionBuffer[T]{capacity: capacity, retention: retention}
}

func (b *retentionBuffer[T]) add(item T) {
	b.items = append(b.items, item)
	overflow := len(b.items) - b.capacity
	if overflow <= 0 {
		return
	}
	b.evicted += uint64(overflow)
	b.items = append(b.items[:0], b.items[overflow:]...)
}

// Arrivals are held in arrival order, so the expired ones are always a prefix.
func (b *retentionBuffer[T]) prune(now time.Time) {
	first := 0
	for first < len(b.items) && now.Sub(b.items[first].arrivedAt()) > b.retention {
		first++
	}
	if first == 0 {
		return
	}
	b.expired += uint64(first)
	b.items = append(b.items[:0], b.items[first:]...)
}

// Discarded entries count as evicted, not expired: they are still inside their
// retention window and are lost to the reset rather than to age.
func (b *retentionBuffer[T]) reset() {
	b.evicted += uint64(len(b.items))
	b.items = b.items[:0]
}

func (b *retentionBuffer[T]) depth() uint64 {
	return uint64(len(b.items))
}

// Unresolved arrivals stay in the buffer so a later frame can still match them.
// A resolved arrival is counted by the caller as a match, not as a loss.
func takeResolved[T arrival, U any](b *retentionBuffer[T], resolve func(T) (U, bool)) []U {
	var resolved []U
	kept := b.items[:0]
	for _, item := range b.items {
		value, ok := resolve(item)
		if !ok {
			kept = append(kept, item)
			continue
		}
		resolved = append(resolved, value)
	}
	b.items = kept
	return resolved
}

type rtpTimestampMapping struct {
	source   uint32
	outgoing uint32
	recorded time.Time
}

func (m rtpTimestampMapping) arrivedAt() time.Time { return m.recorded }

type pendingMetadata struct {
	payload  []byte
	source   uint32
	recorded time.Time
}

func (p pendingMetadata) arrivedAt() time.Time { return p.recorded }

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

// metadataTimestampCorrelator pairs a metadata message with the outgoing RTP
// timestamp of the video frame it describes, in whichever order the two arrive.
// Both sides share one capacity, one retention window, and one reset, and every
// disposal is counted.
type metadataTimestampCorrelator struct {
	mu       sync.Mutex
	ssrc     uint32
	haveSSRC bool

	frames  *retentionBuffer[rtpTimestampMapping]
	pending *retentionBuffer[pendingMetadata]

	matchedVideoFirst    uint64
	matchedMetadataFirst uint64
	lastFrameID          json.RawMessage
}

func newMetadataTimestampCorrelator(capacity int, retention time.Duration) *metadataTimestampCorrelator {
	return &metadataTimestampCorrelator{
		frames:  newRetentionBuffer[rtpTimestampMapping](capacity, retention),
		pending: newRetentionBuffer[pendingMetadata](capacity, retention),
	}
}

func (c *metadataTimestampCorrelator) addVideoFrame(
	ssrc uint32,
	source uint32,
	outgoing uint32,
	now time.Time,
) []correlatedMetadata {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Ageing before the reset is what keeps reset() an eviction: a restart after a
	// gap longer than retention has already lost its entries to expiry, and
	// reporting those as restart loss would read as capacity, not as timing.
	c.frames.prune(now)
	c.pending.prune(now)
	if c.haveSSRC && c.ssrc != ssrc {
		// Neither side carries a source generation, so keeping entries across a
		// restart would let a repeated source timestamp match the wrong frame.
		c.frames.reset()
		c.pending.reset()
	}
	c.ssrc = ssrc
	c.haveSSRC = true
	c.frames.add(rtpTimestampMapping{source: source, outgoing: outgoing, recorded: now})

	ready := takeResolved(c.pending, func(metadata pendingMetadata) (correlatedMetadata, bool) {
		matched, ok := c.findOutgoingTimestamp(metadata.source)
		if !ok {
			return correlatedMetadata{}, false
		}
		return correlatedMetadata{payload: metadata.payload, outgoing: matched, correlated: true}, true
	})
	c.matchedMetadataFirst += uint64(len(ready))
	return ready
}

func (c *metadataTimestampCorrelator) addMetadata(payload []byte, now time.Time) []correlatedMetadata {
	envelope := parseMetadataEnvelope(payload)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.recordFrameID(envelope.FrameID)

	if envelope.Timestamp == nil {
		// Nothing to correlate against, so this is not a correlation outcome.
		return []correlatedMetadata{{payload: append([]byte(nil), payload...)}}
	}

	c.frames.prune(now)
	c.pending.prune(now)
	source := uint32(uint64(*envelope.Timestamp) * 90)
	outgoing, ok := c.findOutgoingTimestamp(source)
	if !ok {
		c.pending.add(pendingMetadata{
			payload:  append([]byte(nil), payload...),
			source:   source,
			recorded: now,
		})
		return nil
	}
	c.matchedVideoFirst++
	return []correlatedMetadata{{
		payload: append([]byte(nil), payload...), outgoing: outgoing, correlated: true,
	}}
}

// Ages both sides before reading. An entry past retention is expired whether or
// not a packet arrived to notice it, so a stalled stream reports its losses
// rather than holding them as pending until the next arrival.
func (c *metadataTimestampCorrelator) pruneAndSnapshot(now time.Time) MetadataCorrelationSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frames.prune(now)
	c.pending.prune(now)
	return MetadataCorrelationSnapshot{
		MatchedVideoFirst:    c.matchedVideoFirst,
		MatchedMetadataFirst: c.matchedMetadataFirst,
		PendingVideo:         c.frames.depth(),
		PendingMetadata:      c.pending.depth(),
		ExpiredVideo:         c.frames.expired,
		ExpiredMetadata:      c.pending.expired,
		EvictedVideo:         c.frames.evicted,
		EvictedMetadata:      c.pending.evicted,
		FrameID:              append(json.RawMessage(nil), c.lastFrameID...),
	}
}

// An oversized value is ignored rather than truncated: half a JSON value is not
// reportable.
func (c *metadataTimestampCorrelator) recordFrameID(frameID json.RawMessage) {
	if len(frameID) == 0 || len(frameID) > maxReportedFrameIDBytes {
		return
	}
	c.lastFrameID = append(c.lastFrameID[:0], frameID...)
}

func (c *metadataTimestampCorrelator) findOutgoingTimestamp(source uint32) (uint32, bool) {
	var (
		bestDistance = rtpTimestampTolerance + 1
		outgoing     uint32
		found        bool
	)
	for i := len(c.frames.items) - 1; i >= 0; i-- {
		distance := rtpTimestampDistance(c.frames.items[i].source, source)
		if distance <= rtpTimestampTolerance && distance < bestDistance {
			bestDistance = distance
			outgoing = c.frames.items[i].outgoing
			found = true
		}
	}
	return outgoing, found
}

func rtpTimestampDistance(a, b uint32) uint32 {
	delta := int64(int32(a - b))
	if delta < 0 {
		delta = -delta
	}
	return uint32(delta)
}

type metadataEnvelope struct {
	// Nil when the message carries no usable timestamp, which is the only case
	// where the correlator forwards without correlating.
	Timestamp *int64 `json:"timestamp"`
	// Raw JSON so a producer sending a string or an object cannot cost the
	// message its timestamp by failing the decode.
	FrameID json.RawMessage `json:"frame_id"`
}

func parseMetadataEnvelope(payload []byte) metadataEnvelope {
	var envelope metadataEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return metadataEnvelope{}
	}
	if envelope.Timestamp != nil && *envelope.Timestamp < 0 {
		envelope.Timestamp = nil
	}
	return envelope
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
