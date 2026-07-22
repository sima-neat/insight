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

func TestParseH265NALObservationsSingleNAL(t *testing.T) {
	tests := []struct {
		name     string
		payload  []byte
		wantType uint8
	}{
		{name: "vps", payload: []byte{0x40, 0x01, 0xaa}, wantType: 32},
		{name: "sps", payload: []byte{0x42, 0x01, 0xbb}, wantType: 33},
		{name: "pps", payload: []byte{0x44, 0x01, 0xcc}, wantType: 34},
		{name: "idr", payload: []byte{0x26, 0x01, 0xdd}, wantType: 19},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseH265NALObservations(tt.payload)
			if len(got) != 1 || got[0].Type != tt.wantType || !got[0].Start || got[0].Mode != "single-nal" {
				t.Fatalf("unexpected single NAL observation: %#v", got)
			}
		})
	}
}

func TestParseH265NALObservationsAP(t *testing.T) {
	payload := []byte{
		0x60, 0x01,
		0x00, 0x03, 0x40, 0x01, 0xaa,
		0x00, 0x03, 0x42, 0x01, 0xbb,
		0x00, 0x03, 0x44, 0x01, 0xcc,
	}

	got := parseH265NALObservations(payload)
	if len(got) != 3 || got[0].Type != 32 || got[1].Type != 33 || got[2].Type != 34 {
		t.Fatalf("expected VPS/SPS/PPS observations, got %#v", got)
	}
	for _, observation := range got {
		if !observation.Start || observation.Mode != "ap" {
			t.Fatalf("unexpected aggregation observation: %#v", observation)
		}
	}
}

func TestParseH265NALObservationsFU(t *testing.T) {
	start := parseH265NALObservations([]byte{0x62, 0x01, 0x93, 0xaa})
	if len(start) != 1 || start[0].Type != 19 || !start[0].Start || start[0].Mode != "fu" {
		t.Fatalf("unexpected FU start observation: %#v", start)
	}

	middle := parseH265NALObservations([]byte{0x62, 0x01, 0x13, 0xbb})
	if len(middle) != 1 || middle[0].Type != 19 || middle[0].Start || middle[0].Mode != "fu" {
		t.Fatalf("unexpected FU middle observation: %#v", middle)
	}
}

func TestIngestStatsReportsH265ParameterSetsAndKeyframes(t *testing.T) {
	stats := NewIngestStats(0, 9000, 9100)
	packets := [][]byte{
		{
			0x60, 0x01,
			0x00, 0x03, 0x40, 0x01, 0xaa,
			0x00, 0x03, 0x42, 0x01, 0xbb,
			0x00, 0x03, 0x44, 0x01, 0xcc,
		},
		{0x62, 0x01, 0x93, 0xdd},
		{0x2a, 0x01, 0xee},
	}
	for sequence, payload := range packets {
		stats.RecordRTPPacket(&rtp.Packet{
			Header:  rtp.Header{PayloadType: h265RTPPayloadType, SequenceNumber: uint16(sequence)},
			Payload: payload,
		}, len(payload)+12, nil)
	}

	snapshot := stats.Snapshot(true, false, time.Now())
	if snapshot.Media.Codec != "H265" || !snapshot.Media.SeenVPS || !snapshot.Media.SeenSPS || !snapshot.Media.SeenPPS {
		t.Fatalf("unexpected H.265 parameter-set diagnostics: %#v", snapshot.Media)
	}
	if snapshot.Media.IDRCount != 1 || snapshot.Media.KeyframeCount != 2 {
		t.Fatalf("unexpected H.265 keyframe diagnostics: %#v", snapshot.Media)
	}
	if snapshot.Media.LastVPSAt == "" || snapshot.Media.LastKeyframeAt == "" {
		t.Fatalf("expected H.265 parameter-set and keyframe timestamps: %#v", snapshot.Media)
	}
	if snapshot.Diagnostics.PacketizationModesSeen["ap"] != 3 || snapshot.Diagnostics.PacketizationModesSeen["fu"] != 1 {
		t.Fatalf("unexpected H.265 packetization diagnostics: %#v", snapshot.Diagnostics)
	}
}

func TestIngestStatsPreservesH264MediaDiagnostics(t *testing.T) {
	stats := NewIngestStats(0, 9000, 9100)
	for sequence, payload := range [][]byte{{0x67, 0x42}, {0x68, 0xce}, {0x65, 0x88}} {
		stats.RecordRTPPacket(&rtp.Packet{
			Header:  rtp.Header{PayloadType: h264RTPPayloadType, SequenceNumber: uint16(sequence)},
			Payload: payload,
		}, len(payload)+12, nil)
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
