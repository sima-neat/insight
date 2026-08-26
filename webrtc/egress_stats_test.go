package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/pion/rtcp"
)

func TestEgressStatsRecordsRTCPFeedback(t *testing.T) {
	stats := NewEgressStats(3)
	peerID := stats.RegisterPeer()
	stats.RecordRTCP(peerID, []rtcp.Packet{
		&rtcp.ReceiverReport{
			Reports: []rtcp.ReceptionReport{{
				SSRC:               99,
				FractionLost:       64,
				TotalLost:          7,
				LastSequenceNumber: 1234,
				Jitter:             900,
			}},
		},
		&rtcp.PictureLossIndication{},
		&rtcp.TransportLayerNack{
			Nacks: []rtcp.NackPair{{PacketID: 10, LostPackets: 0b11}},
		},
	})

	snapshot, ok := stats.Snapshot(true, false, time.Now())
	if !ok {
		t.Fatalf("expected channel snapshot")
	}
	if len(snapshot.Peers) != 1 {
		t.Fatalf("expected one peer, got %d", len(snapshot.Peers))
	}
	rtcpStats := snapshot.Peers[0].RTCP
	if rtcpStats.ReceiverReports != 1 || rtcpStats.PLICount != 1 || rtcpStats.NACKCount != 1 {
		t.Fatalf("unexpected RTCP counters: %#v", rtcpStats)
	}
	if rtcpStats.NACKPacketCount != 3 {
		t.Fatalf("expected three NACKed packets, got %d", rtcpStats.NACKPacketCount)
	}
	if rtcpStats.LastReceiverReport == nil || rtcpStats.LastReceiverReport.JitterMS != 10 {
		t.Fatalf("unexpected receiver report: %#v", rtcpStats.LastReceiverReport)
	}
}

func TestEgressStatsPreservesDecoderFieldsFromBrowser(t *testing.T) {
	stats := NewEgressStats(2)
	peerID := stats.RegisterPeer()
	// Sent as raw JSON so the test fails if the backend struct stops carrying
	// these keys, which is how they were silently discarded before.
	payload := []byte(`{
		"type": "browser_egress_stats",
		"channel": 2,
		"inbound_rtp": {
			"frames_received": 1489,
			"frames_decoded": 10,
			"decoder_implementation": "NullVideoDecoder (fallback from: ExternalDecoder (VideoToolboxVideoDecoder))",
			"power_efficient_decoder": false
		}
	}`)

	if !stats.RecordBrowserReport(peerID, payload) {
		t.Fatalf("expected browser report to be accepted")
	}
	snapshot, ok := stats.Snapshot(true, false, time.Now())
	if !ok {
		t.Fatalf("expected channel snapshot")
	}
	report := snapshot.Peers[0].Browser
	if report == nil {
		t.Fatal("expected a browser report")
	}
	if report.InboundRTP.DecoderImplementation == "" {
		t.Fatalf("decoder implementation was discarded: %#v", report.InboundRTP)
	}
	if report.InboundRTP.PowerEfficientDecoder == nil {
		t.Fatal("a reported false must stay distinguishable from an absent value")
	}
	if *report.InboundRTP.PowerEfficientDecoder {
		t.Fatalf("expected power_efficient_decoder=false to survive the round trip")
	}
}

func TestEgressStatsRecordsBrowserReport(t *testing.T) {
	stats := NewEgressStats(1)
	peerID := stats.RegisterPeer()
	payload, err := json.Marshal(BrowserEgressReport{
		Type:    "browser_egress_stats",
		Channel: 1,
		InboundRTP: BrowserInboundRTPStats{
			BytesReceived:   1024,
			FramesDecoded:   16,
			FramesPerSecond: 15.5,
		},
		Video: BrowserVideoState{
			ReadyState: 4,
			Active:     true,
		},
		Synchronization: BrowserSynchronizationStats{
			VideoSyncBufferMS:            350,
			TimestampMatches:             15,
			FrameMisses:                  1,
			SegmentationHoldMaxFrames:    5,
			SegmentationConfidenceSmooth: 42,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if !stats.RecordBrowserReport(peerID, payload) {
		t.Fatalf("expected browser report to be accepted")
	}
	snapshot, ok := stats.Snapshot(true, false, time.Now())
	if !ok {
		t.Fatalf("expected channel snapshot")
	}
	report := snapshot.Peers[0].Browser
	if report == nil || report.InboundRTP.FramesDecoded != 16 || !report.Video.Active {
		t.Fatalf("unexpected browser report: %#v", report)
	}
	if report.Synchronization.VideoSyncBufferMS != 350 || report.Synchronization.TimestampMatches != 15 {
		t.Fatalf("unexpected synchronization report: %#v", report.Synchronization)
	}
	if report.Synchronization.SegmentationHoldMaxFrames != 5 ||
		report.Synchronization.SegmentationConfidenceSmooth != 42 {
		t.Fatalf("segmentation stability counters were discarded: %#v", report.Synchronization)
	}
}

func TestEgressStatsBoundsRetiredPeers(t *testing.T) {
	stats := NewEgressStats(3)
	var live uint64
	for i := 0; i < 50; i++ {
		peerID := stats.RegisterPeer()
		if i == 25 {
			// One peer stays connected and must survive every later eviction.
			live = peerID
			stats.UpdatePeerConnectionState(peerID, "connected", "connected", "stable")
			continue
		}
		stats.UpdatePeerConnectionState(peerID, "failed", "failed", "stable")
	}

	snapshot, _ := stats.Snapshot(true, false, time.Now())
	if len(snapshot.Peers) != maxRetiredPeers+1 {
		t.Fatalf("expected %d retired peers plus the live one, got %d",
			maxRetiredPeers, len(snapshot.Peers))
	}
	found := false
	for _, peer := range snapshot.Peers {
		if peer.ID == live {
			found = true
		}
	}
	if !found {
		t.Fatalf("eviction dropped the connected peer %d", live)
	}
	// The survivors must be the most recent retirements, not the oldest.
	newest := snapshot.Peers[len(snapshot.Peers)-1].ID
	if newest != 50 {
		t.Fatalf("expected the newest peer retained, got %d", newest)
	}
}

func TestIngestStatsBoundsRetiredPeers(t *testing.T) {
	stats := NewIngestStats(3, 9003, 9103)
	for i := 0; i < 50; i++ {
		peerID := stats.RegisterPeer()
		stats.UpdatePeerState(peerID, "closed")
	}
	live := stats.RegisterPeer()
	stats.UpdatePeerState(live, "connected")

	webrtcSnapshot := stats.Snapshot(false, false, time.Now()).WebRTC
	// PeerCount already excludes retired peers; the bound is visible in the
	// state histogram, which is what grew without limit before.
	if got := webrtcSnapshot.ConnectionStates["closed"]; got != maxRetiredPeers {
		t.Fatalf("expected retired peers capped at %d, got %d", maxRetiredPeers, got)
	}
	if webrtcSnapshot.PeerCount != 1 || webrtcSnapshot.ConnectionStates["connected"] != 1 {
		t.Fatalf("live peer lost to eviction: %#v", webrtcSnapshot)
	}
}
