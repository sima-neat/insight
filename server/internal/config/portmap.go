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

// PublishedPorts are the host ports the SDK container publishes MediaMTX's listeners on, as the
// port map names them; 0 where it names none, and everywhere outside the SDK.
type PublishedPorts struct {
	// RTSP is where apps read the sources (rtsp.tcp).
	RTSP int
	// WHIP is where browsers post a webcam's WHIP offer (webrtcWhip).
	WHIP int
	// WHIPICE is the UDP port of a webcam's media (webrtcWhipIce). The SDK publishes it
	// identity-mapped, so MediaMTX binds this number inside the container too.
	WHIPICE int
}

// portMap is the part of sima-cli's port map (schema sima.neat.port-map.v1) Insight reads. The
// published ports stay raw until they are read, so that one malformed entry costs only itself.
type portMap struct {
	VideoChannels *json.RawMessage `json:"insightVideoChannels"`
	WebRTC        *struct {
		ContainerStart int `json:"containerStart"`
		ContainerEnd   int `json:"containerEnd"`
	} `json:"webRTC"`
	RTSP    *json.RawMessage `json:"rtsp"`
	WHIP    *json.RawMessage `json:"webrtcWhip"`
	WHIPICE *json.RawMessage `json:"webrtcWhipIce"`
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

func resolvePublishedPorts(ports portMap, havePorts bool) PublishedPorts {
	if !havePorts {
		return PublishedPorts{}
	}
	return PublishedPorts{
		RTSP:    hostPort("rtsp.tcp", ports.RTSP, "tcp", "host"),
		WHIP:    hostPort("webrtcWhip", ports.WHIP, "host"),
		WHIPICE: hostPort("webrtcWhipIce", ports.WHIPICE, "host"),
	}
}

// hostPort reads the port at keys inside a port map entry (`{"tcp": {"host": 18554}}` with keys
// tcp, host): 0 when the entry or a key is absent, and, logged, when what it holds is no port.
func hostPort(name string, entry *json.RawMessage, keys ...string) int {
	if entry == nil {
		return 0
	}
	value := *entry
	for _, key := range keys {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(value, &object); err != nil {
			slog.Warn("ignoring the port map's "+name, "value", string(*entry))
			return 0
		}
		if value = object[key]; value == nil {
			return 0
		}
	}
	var port int
	// A whole number only: "8554", 8554.5 or true are not a port.
	if err := json.Unmarshal(value, &port); err != nil || port < 1 || port > 65535 {
		slog.Warn("ignoring the port map's "+name, "value", string(*entry))
		return 0
	}
	return port
}
