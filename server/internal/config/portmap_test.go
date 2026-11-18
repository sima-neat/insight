package config

import (
	"path/filepath"
	"testing"
)

func TestChannels(t *testing.T) {
	cases := []struct {
		name    string
		portMap string // "" writes no file
		board   bool
		want    Channels
	}{
		{"no port map", "", false, Channels{80, "legacy-default", false}},
		{"the SDK publishes 48", `{"insightVideoChannels": 48}`, false, Channels{48, "sdk-port-map", true}},
		{"the SDK publishes all", `{"insightVideoChannels": 80}`, false, Channels{80, "sdk-port-map", false}},
		{"a board serves all, whatever a file says", `{"insightVideoChannels": 4}`, true, Channels{80, "devkit", false}},
		{"no count in the map", `{"webRTC": {}}`, false, Channels{80, "legacy-default", false}},
		{"zero", `{"insightVideoChannels": 0}`, false, Channels{80, "legacy-default", false}},
		{"too many", `{"insightVideoChannels": 81}`, false, Channels{80, "legacy-default", false}},
		{"a fraction", `{"insightVideoChannels": 4.5}`, false, Channels{80, "legacy-default", false}},
		{"a string", `{"insightVideoChannels": "4"}`, false, Channels{80, "legacy-default", false}},
		{"a boolean", `{"insightVideoChannels": true}`, false, Channels{80, "legacy-default", false}},
		{"broken JSON", `{"insightVideoChannels": `, false, Channels{80, "legacy-default", false}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			paths := testPaths(t)
			if c.board {
				write(t, paths.BuildFiles[0], "SIMA_BUILD_VERSION = 2\n")
			}
			if c.portMap != "" {
				write(t, filepath.Join(paths.ConfigDir, "neat-port-map.json"), c.portMap)
			}
			cfg, err := Load(9900, paths, envOf(nil), noAddresses)
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Channels != c.want {
				t.Fatalf("channels %+v, want %+v", cfg.Channels, c.want)
			}
		})
	}
}

func TestWebRTCPorts(t *testing.T) {
	cases := map[string]PortRange{
		``: DefaultWebRTCPorts,
		`{"webRTC": {"containerStart": 40000, "containerEnd": 40095, "hostStart": 50000}}`: {40000, 40095},
		`{"webRTC": {"containerStart": 40095, "containerEnd": 40000}}`:                     DefaultWebRTCPorts,
		`{"webRTC": {"containerStart": 0, "containerEnd": 10}}`:                            DefaultWebRTCPorts,
		`{"webRTC": {"containerStart": 1, "containerEnd": 70000}}`:                         DefaultWebRTCPorts,
	}
	for portMap, want := range cases {
		t.Run(portMap, func(t *testing.T) {
			paths := testPaths(t)
			if portMap != "" {
				write(t, filepath.Join(paths.ConfigDir, "neat-port-map.json"), portMap)
			}
			cfg, err := Load(9900, paths, envOf(nil), noAddresses)
			if err != nil {
				t.Fatal(err)
			}
			if cfg.WebRTCPorts != want {
				t.Fatalf("ports %+v, want %+v", cfg.WebRTCPorts, want)
			}
		})
	}
}

func TestNEATPortMapFileOverridesTheFolder(t *testing.T) {
	paths := testPaths(t)
	write(t, filepath.Join(paths.ConfigDir, "neat-port-map.json"), `{"insightVideoChannels": 4}`)
	other := filepath.Join(t.TempDir(), "map.json")
	write(t, other, `{"insightVideoChannels": 8}`)
	cfg, err := Load(9900, paths, envOf(map[string]string{"NEAT_PORT_MAP_FILE": other}), noAddresses)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Channels.Count != 8 {
		t.Fatalf("count %d", cfg.Channels.Count)
	}
}
