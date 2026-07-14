package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestMetadataTimestampCorrelatorMatchesTruncatedMilliseconds(t *testing.T) {
	correlator := newMetadataTimestampCorrelator(8, 5*time.Second)
	now := time.Unix(100, 0)
	const (
		metadataTimestampMS  = int64(1234)
		sourceRTPTimestamp   = uint32(metadataTimestampMS*90 + 87)
		outgoingRTPTimestamp = uint32(5678)
	)

	correlator.addVideoFrame(99, sourceRTPTimestamp, outgoingRTPTimestamp, now)
	ready := correlator.addMetadata(
		[]byte(`{"type":"object-detection","timestamp":1234,"data":{"objects":[]}}`),
		now,
	)

	if len(ready) != 1 {
		t.Fatalf("expected one matched metadata message, got %d", len(ready))
	}
	var message struct {
		Insight struct {
			RTPTimestamp uint32 `json:"rtp_timestamp"`
		} `json:"_insight"`
	}
	encoded, err := ready[0].encode()
	if err != nil {
		t.Fatalf("expected metadata enrichment to succeed: %v", err)
	}
	if err := json.Unmarshal(encoded, &message); err != nil {
		t.Fatalf("expected valid enriched metadata: %v", err)
	}
	if message.Insight.RTPTimestamp != outgoingRTPTimestamp {
		t.Fatalf("expected outgoing RTP timestamp %d, got %d", outgoingRTPTimestamp, message.Insight.RTPTimestamp)
	}
}

func TestMetadataTimestampCorrelatorReleasesMetadataWhenVideoArrivesLater(t *testing.T) {
	correlator := newMetadataTimestampCorrelator(8, 5*time.Second)
	now := time.Unix(100, 0)
	payload := []byte(`{"type":"tracking","timestamp":2000,"data":{"tracks":[]}}`)

	if ready := correlator.addMetadata(payload, now); len(ready) != 0 {
		t.Fatalf("expected timestamped metadata to wait for its video frame")
	}
	ready := correlator.addVideoFrame(7, 180034, 8765, now.Add(time.Millisecond))

	if len(ready) != 1 {
		t.Fatalf("expected pending metadata to be released, got %d messages", len(ready))
	}
	var message struct {
		Insight struct {
			RTPTimestamp uint32 `json:"rtp_timestamp"`
		} `json:"_insight"`
	}
	encoded, err := ready[0].encode()
	if err != nil {
		t.Fatalf("expected metadata enrichment to succeed: %v", err)
	}
	if err := json.Unmarshal(encoded, &message); err != nil {
		t.Fatalf("expected valid enriched metadata: %v", err)
	}
	if message.Insight.RTPTimestamp != 8765 {
		t.Fatalf("expected outgoing RTP timestamp 8765, got %d", message.Insight.RTPTimestamp)
	}
}

func TestMetadataTimestampCorrelatorMatchesAcrossRTPWraparound(t *testing.T) {
	correlator := newMetadataTimestampCorrelator(8, 5*time.Second)
	now := time.Unix(100, 0)
	correlator.addVideoFrame(7, 11, 9001, now)

	ready := correlator.addMetadata(
		[]byte(`{"type":"object-detection","timestamp":47721858,"data":{"objects":[]}}`),
		now,
	)

	if len(ready) != 1 {
		t.Fatalf("expected wraparound timestamp to match, got %d messages", len(ready))
	}
}

func TestMetadataTimestampCorrelatorDoesNotReleaseExpiredMetadata(t *testing.T) {
	correlator := newMetadataTimestampCorrelator(8, 5*time.Second)
	now := time.Unix(100, 0)
	payload := []byte(`{"type":"tracking","timestamp":2000,"data":{"tracks":[]}}`)

	if ready := correlator.addMetadata(payload, now); len(ready) != 0 {
		t.Fatalf("expected timestamped metadata to wait for its video frame")
	}
	ready := correlator.addVideoFrame(7, 180034, 8765, now.Add(6*time.Second))

	if len(ready) != 0 {
		t.Fatalf("expected expired metadata to be discarded, got %d messages", len(ready))
	}
}

func TestMetadataPeerRegistryRemovesOnlyClosingPeer(t *testing.T) {
	registry := metadataPeerRegistry{}
	first := new(webrtc.DataChannel)
	second := new(webrtc.DataChannel)
	registry.add(1, first)
	registry.add(2, second)

	registry.remove(1, first)
	peers := registry.snapshot()

	if len(peers) != 1 {
		t.Fatalf("expected one remaining metadata peer, got %d", len(peers))
	}
	if peers[0].id != 2 || peers[0].channel != second {
		t.Fatalf("expected the second peer to remain, got %#v", peers[0])
	}
}

func BenchmarkMetadataTimestampCorrelatorBoundedLookup(b *testing.B) {
	correlator := newMetadataTimestampCorrelator(256, 5*time.Second)
	now := time.Unix(100, 0)
	correlator.addVideoFrame(7, 90087, 7000, now)
	for i := uint32(1); i < 256; i++ {
		correlator.addVideoFrame(7, 1_000_000+i*3000, 7000+i, now)
	}
	payload := []byte(
		`{"type":"object-detection","timestamp":1000,"data":{"objects":[{"x":10,"y":20,"width":30,"height":40,"confidence":0.9,"label":"person"}]}}`,
	)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if ready := correlator.addMetadata(payload, now); len(ready) != 1 {
			b.Fatalf("expected one matched metadata message, got %d", len(ready))
		}
	}
}

func BenchmarkMetadataTimestampCorrelatorVideoFrame(b *testing.B) {
	correlator := newMetadataTimestampCorrelator(256, 5*time.Second)
	now := time.Unix(100, 0)

	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		timestamp := uint32(i) * 3000
		correlator.addVideoFrame(7, timestamp, timestamp, now)
	}
}
