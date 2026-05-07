package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/pion/rtp"
)

func TestLoadEphemeralUDPPortRangeUsesWebRTCContainerRange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "neat-port-map.json")
	content := []byte(`{
  "schema": "sima.neat.port-map.v1",
  "webRTC": {
    "containerEnd": 40237,
    "containerStart": 40038,
    "hostEnd": 49999,
    "hostStart": 49800,
    "protocol": "udp"
  }
}`)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}

	gotStart, gotEnd, err := loadEphemeralUDPPortRange(path)
	if err != nil {
		t.Fatalf("expected port range to load: %v", err)
	}
	if gotStart != 40038 || gotEnd != 40237 {
		t.Fatalf("expected container range 40038-40237, got %d-%d", gotStart, gotEnd)
	}
}

func TestLoadEphemeralUDPPortRangeRejectsMissingWebRTC(t *testing.T) {
	path := filepath.Join(t.TempDir(), "neat-port-map.json")
	if err := os.WriteFile(path, []byte(`{"schema":"sima.neat.port-map.v1"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, _, err := loadEphemeralUDPPortRange(path); err == nil {
		t.Fatalf("expected missing webRTC section to fail")
	}
}

func TestValidateEphemeralUDPPortRangeRejectsInvalidRange(t *testing.T) {
	if _, _, err := validateEphemeralUDPPortRange(40200, 40000); err == nil {
		t.Fatalf("expected descending port range to fail")
	}
	if _, _, err := validateEphemeralUDPPortRange(0, 40000); err == nil {
		t.Fatalf("expected zero start port to fail")
	}
	if _, _, err := validateEphemeralUDPPortRange(40000, 65536); err == nil {
		t.Fatalf("expected port above 65535 to fail")
	}
}

func TestConfiguredNAT1To1HostIPsIncludesLoopback(t *testing.T) {
	got := configuredNAT1To1HostIPs("10.0.0.22")
	want := []string{"10.0.0.22", "127.0.0.1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected NAT 1:1 host IPs %v, got %v", want, got)
	}
}

func TestConfiguredNAT1To1HostIPsRejectsInternalHosts(t *testing.T) {
	for _, hostIP := range []string{"", "127.0.0.1", "0.0.0.0", "not-an-ip"} {
		if got := configuredNAT1To1HostIPs(hostIP); got != nil {
			t.Fatalf("expected %q to be rejected, got %v", hostIP, got)
		}
	}
}

func TestRTPTimestampRewriterAdvancesPerFrame(t *testing.T) {
	rewriter := newRTPTimestampRewriter()
	start := time.Unix(100, 0)

	first := rewriter.timestampForFrame(start)
	second := rewriter.timestampForFrame(start.Add(33 * time.Millisecond))
	third := rewriter.timestampForFrame(start.Add(66 * time.Millisecond))

	if first != initialRTPTimestamp {
		t.Fatalf("expected first timestamp %d, got %d", initialRTPTimestamp, first)
	}
	if second <= first {
		t.Fatalf("expected second timestamp to advance, got first=%d second=%d", first, second)
	}
	if third <= second {
		t.Fatalf("expected third timestamp to advance, got second=%d third=%d", second, third)
	}
}

func TestRewriteRTPPacketTimestamp(t *testing.T) {
	original := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    96,
			SequenceNumber: 7,
			Timestamp:      1234,
			SSRC:           99,
			Marker:         true,
		},
		Payload: []byte{0x65, 0x88, 0x84},
	}
	raw, err := original.Marshal()
	if err != nil {
		t.Fatal(err)
	}

	rewritten, err := rewriteRTPPacketTimestamp(raw, 5678)
	if err != nil {
		t.Fatalf("expected timestamp rewrite to succeed: %v", err)
	}

	var got rtp.Packet
	if err := got.Unmarshal(rewritten); err != nil {
		t.Fatalf("expected rewritten packet to unmarshal: %v", err)
	}
	if got.Timestamp != 5678 {
		t.Fatalf("expected rewritten timestamp 5678, got %d", got.Timestamp)
	}
	if got.SequenceNumber != original.SequenceNumber || got.SSRC != original.SSRC ||
		got.PayloadType != original.PayloadType || !got.Marker {
		t.Fatalf("expected non-timestamp RTP header fields to be preserved: %#v", got.Header)
	}
}
