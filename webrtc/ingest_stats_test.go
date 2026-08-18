package main

import (
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
)

func TestParseH264NALObservationsSingleNAL(t *testing.T) {
	tests := []struct {
		name     string
		payload  []byte
		wantType uint8
	}{
		{name: "sps", payload: []byte{0x67, 0x42, 0x00, 0x1f}, wantType: 7},
		{name: "pps", payload: []byte{0x68, 0xce, 0x06, 0xe2}, wantType: 8},
		{name: "idr", payload: []byte{0x65, 0x88, 0x84}, wantType: 5},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseH264NALObservations(tt.payload)
			if len(got) != 1 {
				t.Fatalf("expected one observation, got %d", len(got))
			}
			if got[0].Type != tt.wantType {
				t.Fatalf("expected NAL type %d, got %d", tt.wantType, got[0].Type)
			}
			if !got[0].Start {
				t.Fatalf("expected single NAL observation to mark Start")
			}
			if got[0].Mode != "single-nal" {
				t.Fatalf("expected single-nal mode, got %q", got[0].Mode)
			}
		})
	}
}

func TestParseH264NALObservationsSTAPA(t *testing.T) {
	payload := []byte{
		0x78,
		0x00, 0x02, 0x67, 0x42,
		0x00, 0x02, 0x68, 0xce,
	}

	got := parseH264NALObservations(payload)
	if len(got) != 2 {
		t.Fatalf("expected two observations, got %d", len(got))
	}
	if got[0].Type != 7 || got[1].Type != 8 {
		t.Fatalf("expected SPS/PPS observations, got %#v", got)
	}
	for _, obs := range got {
		if !obs.Start {
			t.Fatalf("expected STAP-A observations to mark Start")
		}
		if obs.Mode != "stap-a" {
			t.Fatalf("expected stap-a mode, got %q", obs.Mode)
		}
	}
}

func TestParseH264NALObservationsFUA(t *testing.T) {
	startPayload := []byte{0x7c, 0x85, 0xaa}
	middlePayload := []byte{0x7c, 0x05, 0xbb}

	got := parseH264NALObservations(startPayload)
	if len(got) != 1 {
		t.Fatalf("expected one start observation, got %d", len(got))
	}
	if got[0].Type != 5 || !got[0].Start || got[0].Mode != "fu-a" {
		t.Fatalf("unexpected FU-A start observation: %#v", got[0])
	}

	got = parseH264NALObservations(middlePayload)
	if len(got) != 1 {
		t.Fatalf("expected one middle observation, got %d", len(got))
	}
	if got[0].Type != 5 || got[0].Start || got[0].Mode != "fu-a" {
		t.Fatalf("unexpected FU-A middle observation: %#v", got[0])
	}
}

func TestIngestStatsReportsH265ParameterSetsAndKeyframes(t *testing.T) {
	stats := NewIngestStats(0, 9000, 9100)
	packets := []struct {
		payload   []byte
		timestamp uint32
	}{
		{
			payload: []byte{
				0x60, 0x01,
				0x00, 0x03, 0x40, 0x01, 0xaa,
				0x00, 0x03, 0x42, 0x01, 0xbb,
				0x00, 0x03, 0x44, 0x01, 0xcc,
			},
		},
		{payload: []byte{0x62, 0x01, 0x93, 0xdd}, timestamp: 3000},
		{payload: []byte{0x62, 0x01, 0x13, 0xee}, timestamp: 3000},
		{payload: []byte{0x2a, 0x01, 0xff}, timestamp: 6000},
	}
	for sequence, packet := range packets {
		recordTestRTPPacket(stats, h265RTPPayloadType, uint16(sequence), packet.timestamp, packet.payload)
	}

	snapshot := stats.Snapshot(true, false, time.Now())
	if snapshot.Media.Codec != "H265" || !snapshot.Media.SeenVPS || !snapshot.Media.SeenSPS || !snapshot.Media.SeenPPS {
		t.Fatalf("unexpected H.265 parameter-set diagnostics: %#v", snapshot.Media)
	}
	if snapshot.Media.IDRCount != 0 || snapshot.Media.KeyframeCount != 2 {
		t.Fatalf("unexpected H.265 keyframe diagnostics: %#v", snapshot.Media)
	}
	if snapshot.Media.LastVPSAt == "" || snapshot.Media.LastKeyframeAt == "" || snapshot.Media.LastIDRAt != "" {
		t.Fatalf("expected H.265 parameter-set and keyframe timestamps: %#v", snapshot.Media)
	}
	modes := snapshot.Diagnostics.PacketizationModesSeen
	if modes["ap"] != 3 || modes["fu"] != 2 || modes["single-nal"] != 1 {
		t.Fatalf("unexpected H.265 packetization diagnostics: %#v", snapshot.Diagnostics)
	}
}

func TestIngestStatsResetsMediaDiagnosticsOnCodecTransition(t *testing.T) {
	stats := NewIngestStats(0, 9000, 9100)
	for sequence, payload := range [][]byte{{0x67, 0x42}, {0x68, 0xce}, {0x65, 0x88}} {
		recordTestRTPPacket(stats, h264RTPPayloadType, uint16(sequence), 0, payload)
	}
	recordTestRTPPacket(stats, h265RTPPayloadType, 3, 0, []byte{0x02, 0x01, 0xaa})

	h265Snapshot := stats.Snapshot(true, false, time.Now())
	if h265Snapshot.Media.Codec != "H265" || h265Snapshot.Media.SeenSPS || h265Snapshot.Media.SeenPPS || h265Snapshot.Media.IDRCount != 0 {
		t.Fatalf("H.265 snapshot retained H.264 media diagnostics: %#v", h265Snapshot.Media)
	}
	if h265Snapshot.RTP.PacketsReceived != 4 {
		t.Fatalf("codec transition reset transport counters: %#v", h265Snapshot.RTP)
	}
	if counts := h265Snapshot.Diagnostics.NALTypeCounts; len(counts) != 1 || counts["1"] != 1 {
		t.Fatalf("H.265 snapshot retained H.264 NAL counts: %#v", h265Snapshot.Diagnostics.NALTypeCounts)
	}

	recordTestRTPPacket(stats, h265RTPPayloadType, 4, 3000, []byte{
		0x60, 0x01,
		0x00, 0x02, 0x40, 0x01,
		0x00, 0x02, 0x42, 0x01,
		0x00, 0x02, 0x44, 0x01,
	})
	recordTestRTPPacket(stats, h265RTPPayloadType, 5, 3000, []byte{0x26, 0x01})
	recordTestRTPPacket(stats, h264RTPPayloadType, 6, 0, []byte{0x61, 0xaa})

	h264Snapshot := stats.Snapshot(true, false, time.Now())
	if h264Snapshot.Media.Codec != "H264" || h264Snapshot.Media.SeenSPS || h264Snapshot.Media.SeenPPS || h264Snapshot.Media.IDRCount != 0 {
		t.Fatalf("H.264 snapshot retained H.265 media diagnostics: %#v", h264Snapshot.Media)
	}
	if h264Snapshot.RTP.PacketsReceived != 7 {
		t.Fatalf("codec transition reset transport counters: %#v", h264Snapshot.RTP)
	}
	if counts := h264Snapshot.Diagnostics.NALTypeCounts; len(counts) != 1 || counts["1"] != 1 {
		t.Fatalf("H.264 snapshot retained H.265 NAL counts: %#v", h264Snapshot.Diagnostics.NALTypeCounts)
	}
}

func TestIngestStatsCountsH265KeyframeOncePerRTPTimestamp(t *testing.T) {
	stats := NewIngestStats(0, 9000, 9100)
	for sequence, timestamp := range []uint32{3000, 3000, 6000} {
		recordTestRTPPacket(stats, h265RTPPayloadType, uint16(sequence), timestamp, []byte{0x26, 0x01, byte(sequence)})
	}

	media := stats.Snapshot(false, false, time.Now()).Media
	if media.KeyframeCount != 2 {
		t.Fatalf("expected two H.265 keyframe access units, got %#v", media)
	}
}

func TestIngestStatsReportsUnsupportedPayloadWithoutDisturbingMediaState(t *testing.T) {
	stats := NewIngestStats(0, 9000, 9100)
	recordTestRTPPacket(stats, h265RTPPayloadType, 10, 3000, []byte{0x26, 0x01})
	recordTestRTPPacket(stats, 72, 0, 1, []byte{0xc8, 0x00})
	recordTestRTPPacket(stats, h265RTPPayloadType, 11, 6000, []byte{0x02, 0x01})

	snapshot := stats.Snapshot(true, false, time.Now())
	if snapshot.Diagnostics.EstimatedSequenceGaps != 0 {
		t.Fatalf("unsupported payload disturbed media sequence tracking: %#v", snapshot.Diagnostics)
	}
	if snapshot.RTP.PayloadType != h265RTPPayloadType || snapshot.Media.Codec != "H265" {
		t.Fatalf("unsupported payload replaced current media state: %#v", snapshot)
	}
	if snapshot.Diagnostics.PayloadTypesSeen["72"] != 1 {
		t.Fatalf("unsupported payload type was not recorded: %#v", snapshot.Diagnostics)
	}
	diagnostics, err := json.Marshal(snapshot.Diagnostics)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(diagnostics), "unsupported_payload_packets") {
		t.Fatalf("diagnostics duplicated the payload type history: %s", diagnostics)
	}
}

func TestIngestStatsPreservesH264MediaDiagnostics(t *testing.T) {
	stats := NewIngestStats(0, 9000, 9100)
	for sequence, payload := range [][]byte{{0x67, 0x42}, {0x68, 0xce}, {0x65, 0x88}} {
		recordTestRTPPacket(stats, h264RTPPayloadType, uint16(sequence), 0, payload)
	}

	media := stats.Snapshot(true, false, time.Now()).Media
	if media.Codec != "H264" || !media.SeenSPS || !media.SeenPPS || media.IDRCount != 1 {
		t.Fatalf("unexpected H.264 diagnostics: %#v", media)
	}
	payload, err := json.Marshal(media)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "seen_vps") || strings.Contains(string(payload), "keyframe_count") {
		t.Fatalf("H.264 JSON unexpectedly contains H.265-only fields: %s", payload)
	}
}

func recordTestRTPPacket(stats *IngestStats, payloadType uint8, sequence uint16, timestamp uint32, payload []byte) {
	stats.RecordRTPPacket(&rtp.Packet{
		Header:  rtp.Header{PayloadType: payloadType, SequenceNumber: sequence, Timestamp: timestamp},
		Payload: payload,
	}, len(payload)+12, nil)
}

func TestIngestStatsRecordsMetadataReassembly(t *testing.T) {
	stats := NewIngestStats(0, 9000, 9100)
	reassembler := newMetadataReassembler()
	source := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 5000}
	now := time.Unix(1, 0)

	stats.RecordMetadataReassembly(reassembler.accept(metadataChunk(61, 0, 2, []byte(`{"value":`)), source, now))
	stats.RecordMetadataReassembly(reassembler.accept(metadataChunk(61, 1, 2, []byte(`1}`)), source, now))
	stats.RecordMetadataReassembly(reassembler.accept([]byte{metadataChunkMagic, metadataChunkVersion}, source, now))

	snapshot := stats.Snapshot(false, false, now).Metadata
	if snapshot.ChunkDatagramsReceived != 3 || snapshot.MessagesReassembled != 1 || snapshot.ReassemblyDrops != 1 {
		t.Fatalf("unexpected metadata reassembly counters: %#v", snapshot)
	}
}
