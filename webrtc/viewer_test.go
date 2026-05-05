package main

import (
	"os"
	"path/filepath"
	"testing"
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
