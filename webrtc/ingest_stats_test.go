package main

import "testing"

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
