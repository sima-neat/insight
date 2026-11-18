package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

// MaxChannels is how many channels Insight can serve: video on UDP 9000+N and metadata on
// 9100+N for N below it.
const MaxChannels = 80

// Channels says how many channels Insight serves, and why.
type Channels struct {
	Count int
	// Source is "devkit" (a board serves them all), "sdk-port-map" (the SDK container
	// publishes Count of them) or "legacy-default" (no port map says).
	Source string
	// Limited is true when the port map allows fewer than MaxChannels.
	Limited bool
}

// PortRange is an inclusive range of UDP ports.
type PortRange struct{ Start, End uint16 }

// DefaultWebRTCPorts is the browser-facing WebRTC range when no port map names one.
var DefaultWebRTCPorts = PortRange{40000, 40200}

const portMapFile = "neat-port-map.json"

// portMap is the part of sima-cli's port map (schema sima.neat.port-map.v1) Insight reads.
type portMap struct {
	VideoChannels *json.RawMessage `json:"insightVideoChannels"`
	WebRTC        *struct {
		ContainerStart int `json:"containerStart"`
		ContainerEnd   int `json:"containerEnd"`
	} `json:"webRTC"`
}

// loadPortMap reads the port map sima-cli writes for the SDK container: NEAT_PORT_MAP_FILE when
// set, else neat-port-map.json in the configuration folder. A missing file is no port map; a
// broken one is logged and ignored, as the defaults then hold.
func loadPortMap(configDir string, env Env) (portMap, bool) {
	path := env("NEAT_PORT_MAP_FILE")
	if path == "" {
		path = filepath.Join(configDir, portMapFile)
	}
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return portMap{}, false
	}
	var parsed portMap
	if err == nil {
		err = json.Unmarshal(content, &parsed)
	}
	if err != nil {
		slog.Warn("ignoring the port map", "file", path, "error", err)
		return portMap{}, false
	}
	return parsed, true
}

func resolveChannels(place Place, ports portMap, havePorts bool) Channels {
	legacy := Channels{Count: MaxChannels, Source: "legacy-default"}
	if place == Board {
		return Channels{Count: MaxChannels, Source: "devkit"}
	}
	if !havePorts || ports.VideoChannels == nil {
		return legacy
	}
	var count int
	// A number only: true, 4.5 or "4" are not a count.
	if err := json.Unmarshal(*ports.VideoChannels, &count); err != nil || count < 1 || count > MaxChannels {
		slog.Warn("ignoring the port map's insightVideoChannels", "value", string(*ports.VideoChannels))
		return legacy
	}
	return Channels{Count: count, Source: "sdk-port-map", Limited: count < MaxChannels}
}

func resolveWebRTCPorts(ports portMap, havePorts bool) PortRange {
	if !havePorts || ports.WebRTC == nil {
		return DefaultWebRTCPorts
	}
	start, end := ports.WebRTC.ContainerStart, ports.WebRTC.ContainerEnd
	if start < 1 || end > 65535 || end < start {
		slog.Warn("ignoring the port map's webRTC range", "range", fmt.Sprintf("%d-%d", start, end))
		return DefaultWebRTCPorts
	}
	return PortRange{uint16(start), uint16(end)}
}
