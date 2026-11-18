package mediamtx

import (
	"context"
	"slices"
	"testing"
	"time"
)

func snapshot(t *testing.T, client *Client) Snapshot {
	t.Helper()
	snap, err := client.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func TestSnapshotJoinsPathsWithTheirSessions(t *testing.T) {
	_, client := newFake(t)
	before := time.Now()
	snap := snapshot(t, client)
	if snap.At.Before(before) || time.Since(snap.At) > time.Second {
		t.Errorf("At %v", snap.At)
	}
	if len(snap.Paths) != len(testPaths) {
		t.Fatalf("%d paths", len(snap.Paths))
	}
	for _, tc := range []struct {
		name                     string
		ready, external, pulled  bool
		protocol, address, codec string
		insight                  bool
	}{
		// An untagged publisher is external; Insight's tagged one is not.
		{name: "src2", ready: true, external: true, protocol: "rtsp", address: "172.19.0.1", codec: "h264"},
		{name: "src1", ready: true, protocol: "rtsp", address: "127.0.0.1", codec: "h264", insight: true},
		{name: "src3", ready: true, external: true, protocol: "srt", address: "10.0.0.5", codec: "h264"},
		{name: "src4", ready: true, external: true, protocol: "webrtc", address: "172.19.0.5", codec: "vp8"},
		// An audio-only stream has no video codec.
		{name: "src6", ready: true, external: true, protocol: "rtsp", address: "172.19.0.1", codec: ""},
		// A pull is Insight's own configuration, never a foreign publisher, ready or not.
		{name: "src7", ready: true, pulled: true, protocol: "rtspSource", codec: "h265"},
		{name: "src8", pulled: true, protocol: "rtspSource"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := snap.Paths[tc.name]
			if path.Ready != tc.ready || path.External() != tc.external || path.Pulled() != tc.pulled || path.Codec != tc.codec {
				t.Errorf("ready %v external %v pulled %v codec %q", path.Ready, path.External(), path.Pulled(), path.Codec)
			}
			if path.Source == nil {
				t.Fatal("no source")
			}
			if path.Source.Protocol != tc.protocol || path.Source.Address != tc.address || path.Source.Insight != tc.insight {
				t.Errorf("source %+v", *path.Source)
			}
		})
	}

	idle := snap.Paths["src5"]
	if idle.Ready || idle.External() || idle.Pulled() || idle.Source != nil || !idle.ReadySince.IsZero() || idle.Readers == nil || len(idle.Readers) != 0 {
		t.Errorf("idle path %+v", idle)
	}
	if want := time.Date(2026, 9, 16, 13, 10, 0, 0, time.UTC); !snap.Paths["src2"].ReadySince.Equal(want) {
		t.Errorf("ready since %v", snap.Paths["src2"].ReadySince)
	}
	if src2 := snap.Paths["src2"]; src2.Source.Type != "rtspSession" || src2.Source.ID != "pub-2" || src2.BytesReceived != 468_305 ||
		!slices.Equal(src2.Tracks, []string{"H264"}) {
		t.Errorf("src2 %+v", src2)
	}
}

func TestSnapshotReadersLeaveOutProbesAndLabelThePreview(t *testing.T) {
	_, client := newFake(t)
	got := snapshot(t, client).Paths["src1"].Readers
	want := []Reader{
		{Type: "rtspSession", ID: "read-1", Protocol: "rtsp", Address: "172.19.0.1"},
		{Type: "rtspSession", ID: "prev-1", Protocol: "rtsp", Address: "127.0.0.1", Label: PreviewLabel},
	}
	if !slices.Equal(got, want) {
		t.Errorf("readers %+v", got)
	}
}

func TestSnapshotMatchesThePublisherTagExactly(t *testing.T) {
	// The tag carries a per-run secret: neither its public prefix nor a query that merely
	// contains it passes for Insight's own stream.
	for _, query := range []string{
		"publisher=insight", "xpublisher=insightful", "x" + testPublisher, testPublisher + "x",
		testPublisher + "&" + testPublisher, "publisher=insight-0123456789abcdeF",
	} {
		t.Run(query, func(t *testing.T) {
			fake, client := newFake(t)
			fake.set(func(f *fakeMediaMTX) {
				f.sessions = map[string][]map[string]any{"rtspsessions": {{"id": "pub-2", "remoteAddr": "10.0.0.9:4000", "query": query}}}
			})
			if path := snapshot(t, client).Paths["src2"]; !path.External() || path.Source.Insight {
				t.Errorf("source %+v", *path.Source)
			}
		})
	}
	t.Run("with other parameters", func(t *testing.T) {
		fake, client := newFake(t)
		fake.set(func(f *fakeMediaMTX) {
			f.sessions = map[string][]map[string]any{"rtspsessions": {{"id": "pub-2", "remoteAddr": "10.0.0.9:4000", "query": "a=1&" + testPublisher}}}
		})
		if path := snapshot(t, client).Paths["src2"]; path.External() || !path.Source.Insight {
			t.Errorf("source %+v", *path.Source)
		}
	})
}

func TestSnapshotOfAnUnknownSourceType(t *testing.T) {
	fake, client := newFake(t)
	fake.set(func(f *fakeMediaMTX) {
		f.paths = withPath(f.paths, "src2", map[string]any{"source": map[string]any{"type": "futureConn", "id": "x"}})
	})
	path := snapshot(t, client).Paths["src2"]
	if !path.External() || path.Source.Protocol != "futureConn" || path.Source.Address != "" {
		t.Errorf("source %+v", *path.Source)
	}
}

func TestStreamKey(t *testing.T) {
	_, client := newFake(t)
	snap := snapshot(t, client)
	for name, want := range map[string]string{
		"src2": "pub-2",
		"src7": "pull:src7:2026-09-24T15:16:24.085Z",
		"src8": "",
		"src5": "",
	} {
		if got := snap.Paths[name].StreamKey(); got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
}

func TestBitrateFromTheBytesBetweenSnapshots(t *testing.T) {
	at := time.Now()
	path := func(name string, id string, ready bool, since string, received uint64) Path {
		p := Path{Name: name, Ready: ready, BytesReceived: received}
		if id == "pull" {
			p.Source = &Source{Type: "rtspSource"}
		} else if id != "" {
			p.Source = &Source{Type: "rtspSession", ID: id}
		}
		p.ReadySince, _ = time.Parse(time.RFC3339Nano, since)
		return p
	}
	snap := func(offset time.Duration, paths ...Path) Snapshot {
		s := Snapshot{At: at.Add(offset), Paths: map[string]Path{}}
		for _, p := range paths {
			s.Paths[p.Name] = p
		}
		return s
	}
	const since, later = "2026-09-24T15:16:24.085Z", "2026-09-24T15:20:00Z"
	for _, tc := range []struct {
		name       string
		prev, cur  Snapshot
		bps        float64
		measurable bool
	}{
		{"a publisher", snap(0, path("src2", "pub-2", true, since, 1_000)), snap(2*time.Second, path("src2", "pub-2", true, since, 251_000)), 1_000_000, true},
		{"a pull", snap(0, path("src2", "pull", true, since, 1_000)), snap(2*time.Second, path("src2", "pull", true, since, 251_000)), 1_000_000, true},
		{"a stalled stream", snap(0, path("src2", "pub-2", true, since, 1_000)), snap(time.Second, path("src2", "pub-2", true, since, 1_000)), 0, true},
		{"a new publisher", snap(0, path("src2", "pub-2", true, since, 1_000)), snap(time.Second, path("src2", "pub-9", true, since, 251_000)), 0, false},
		{"a pull that reconnected", snap(0, path("src2", "pull", true, since, 1_000)), snap(time.Second, path("src2", "pull", true, later, 10)), 0, false},
		{"a pull that is down", snap(0, path("src2", "pull", false, "", 0)), snap(time.Second, path("src2", "pull", false, "", 0)), 0, false},
		{"the first snapshot", Snapshot{}, snap(time.Second, path("src2", "pub-2", true, since, 1_000)), 0, false},
		{"a path that went", snap(0, path("src2", "pub-2", true, since, 1_000)), snap(time.Second), 0, false},
		{"a count that went back", snap(0, path("src2", "pub-2", true, since, 9_000)), snap(time.Second, path("src2", "pub-2", true, since, 1_000)), 0, false},
		{"snapshots in the wrong order", snap(time.Second, path("src2", "pub-2", true, since, 1_000)), snap(0, path("src2", "pub-2", true, since, 2_000)), 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bps, ok := tc.cur.Bitrate(tc.prev, "src2")
			if ok != tc.measurable || bps != tc.bps {
				t.Errorf("got %v %v, want %v %v", bps, ok, tc.bps, tc.measurable)
			}
		})
	}
}
