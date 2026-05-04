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
}
