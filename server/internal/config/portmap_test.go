package config

import (
	"path/filepath"
	"slices"
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

func TestPublishedPorts(t *testing.T) {
	// What sima-cli writes (sima_cli/sdk/neat.py), the other entries left out.
	sdk := `{"rtsp": {"tcp": {"host": 18554, "container": 8554}},
		"webrtcWhip": {"protocol": "tcp", "host": 18889, "container": 8889},
		"webrtcWhipIce": {"protocol": "udp", "host": 18189, "container": 18189}}`
	cases := []struct {
		name, portMap string // "" writes no file
		want          PublishedPorts
	}{
		{"no port map", "", PublishedPorts{}},
		{"the SDK's", sdk, PublishedPorts{RTSP: 18554, WHIP: 18889, WHIPICE: 18189}},
		{"none named", `{"insightVideoChannels": 48}`, PublishedPorts{}},
		{"rtsp without tcp", `{"rtsp": {"udp": {"host": 18554}}}`, PublishedPorts{}},
		{"rtsp not an object", `{"rtsp": 18554, "webrtcWhip": {"host": 18889}}`, PublishedPorts{WHIP: 18889}},
		{"a string", `{"webrtcWhip": {"host": "18889"}, "webrtcWhipIce": {"host": 18189}}`, PublishedPorts{WHIPICE: 18189}},
		{"a fraction", `{"webrtcWhip": {"host": 18889.5}}`, PublishedPorts{}},
		{"zero", `{"webrtcWhipIce": {"host": 0}}`, PublishedPorts{}},
		{"too large", `{"rtsp": {"tcp": {"host": 65536}}}`, PublishedPorts{}},
		{"null", `{"webrtcWhip": null}`, PublishedPorts{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			paths := testPaths(t)
			if c.portMap != "" {
				write(t, filepath.Join(paths.ConfigDir, "neat-port-map.json"), c.portMap)
			}
			cfg, err := Load(9900, paths, envOf(nil), noAddresses)
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Published != c.want {
				t.Fatalf("published %+v, want %+v", cfg.Published, c.want)
			}
		})
	}
}

func TestAMalformedPublishedPortKeepsTheRestOfTheMap(t *testing.T) {
	paths := testPaths(t)
	write(t, filepath.Join(paths.ConfigDir, "neat-port-map.json"), `{"insightVideoChannels": 8, "rtsp": [1]}`)
	cfg, err := Load(9900, paths, envOf(nil), noAddresses)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Channels.Count != 8 || cfg.Published.RTSP != 0 {
		t.Fatalf("channels %+v, published %+v", cfg.Channels, cfg.Published)
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

func TestExposedPorts(t *testing.T) {
	paths := testPaths(t)
	write(t, filepath.Join(paths.ConfigDir, "neat-port-map.json"), `{
		"schema": "sima.neat.port-map.v1", "insightVideoChannels": 4,
		"mainUI": {"tcp": {"host": 19900, "container": 9900}},
		"webrtcWhipIce": {"protocol": "udp", "host": 18189, "container": 18189},
		"webRTC": {"protocol": "udp", "hostStart": 40000, "hostEnd": 40200, "containerStart": 40000, "containerEnd": 40200},
		"rtsp": {"tcp": {"host": "18554"}}
	}`)
	cfg, err := Load(9900, paths, envOf(nil), noAddresses)
	if err != nil {
		t.Fatal(err)
	}
	want := []ExposedPort{
		{Name: "mainUI.tcp", Protocol: "tcp", Start: 19900},
		{Name: "rtsp.tcp", Protocol: "tcp"},
		{Name: "webRTC", Protocol: "udp", Start: 40000, End: 40200},
		{Name: "webrtcWhipIce", Protocol: "udp", Start: 18189},
	}
	if !slices.Equal(cfg.ExposedPorts, want) {
		t.Fatalf("exposed %+v, want %+v", cfg.ExposedPorts, want)
	}
}
