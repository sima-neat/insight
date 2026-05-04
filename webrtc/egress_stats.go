package main

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

const egressActiveTTL = 10 * time.Second

type EgressStats struct {
	mu sync.Mutex

	channel    int
	nextPeerID uint64
	peers      map[uint64]*EgressPeerStats

	metadataDroppedNoDC uint64
}

type EgressPeerStats struct {
	ID uint64

	CreatedAt           time.Time
	LastUpdatedAt       time.Time
	LastRTCPAt          time.Time
	LastBrowserReportAt time.Time

	ConnectionState  string
	ICEState         string
	SignalingState   string
	DataChannelState string

	rtcpPacketsReceived uint64
	receiverReports     uint64
	pliCount            uint64
	firCount            uint64
	nackCount           uint64
	nackPacketCount     uint64
	rembCount           uint64
	lastREMBBitrateBPS  float64

	LastReceiverReport *ReceiverReportSnapshot
	LastBrowserReport  *BrowserEgressReport

	metadataLastSentAt     time.Time
	metadataMessagesSent   uint64
	metadataBytesSent      uint64
	metadataSendErrors     uint64
	metadataSampleStarted  time.Time
	metadataSampleBytes    uint64
	metadataSampleMessages uint64
	metadataBitrateBps     float64
	metadataMessageRateMPS float64

	recentErrors []string
}

type EgressStatsResponse struct {
	Time        string                  `json:"time"`
	ActiveTTLMS int64                   `json:"active_ttl_ms"`
	Channels    []ChannelEgressSnapshot `json:"channels"`
}

type ChannelEgressSnapshot struct {
	Channel   int                           `json:"channel"`
	Active    bool                          `json:"active"`
	PeerCount int                           `json:"peer_count"`
	Metadata  ChannelMetadataEgressSnapshot `json:"metadata"`
	Peers     []EgressPeerSnapshot          `json:"peers"`
}

type ChannelMetadataEgressSnapshot struct {
	DroppedNoDataChan uint64 `json:"dropped_no_data_channel"`
}

type EgressPeerSnapshot struct {
	ID                  uint64                 `json:"id"`
	Active              bool                   `json:"active"`
	CreatedAt           string                 `json:"created_at,omitempty"`
	LastUpdatedAt       string                 `json:"last_updated_at,omitempty"`
	LastRTCPAt          string                 `json:"last_rtcp_at,omitempty"`
	LastBrowserReportAt string                 `json:"last_browser_report_at,omitempty"`
	ConnectionState     string                 `json:"connection_state,omitempty"`
	ICEState            string                 `json:"ice_connection_state,omitempty"`
	SignalingState      string                 `json:"signaling_state,omitempty"`
	DataChannelState    string                 `json:"data_channel_state,omitempty"`
	RTCP                RTCPEgressSnapshot     `json:"rtcp"`
	Metadata            MetadataEgressSnapshot `json:"metadata"`
	Browser             *BrowserEgressReport   `json:"browser,omitempty"`
	Diagnostics         *EgressDiagnostics     `json:"diagnostics,omitempty"`
}

type MetadataEgressSnapshot struct {
	MessagesSent   uint64  `json:"messages_sent"`
	BytesSent      uint64  `json:"bytes_sent"`
	BitrateBPS     float64 `json:"bitrate_bps"`
	MessageRateMPS float64 `json:"message_rate_mps"`
	SendErrors     uint64  `json:"send_errors"`
	LastSentAt     string  `json:"last_sent_at,omitempty"`
}

type RTCPEgressSnapshot struct {
	PacketsReceived    uint64                  `json:"packets_received"`
	ReceiverReports    uint64                  `json:"receiver_reports"`
	PLICount           uint64                  `json:"pli_count"`
	FIRCount           uint64                  `json:"fir_count"`
	NACKCount          uint64                  `json:"nack_count"`
	NACKPacketCount    uint64                  `json:"nack_packet_count"`
	REMBCount          uint64                  `json:"remb_count"`
	LastREMBBitrateBPS float64                 `json:"last_remb_bitrate_bps,omitempty"`
	LastReceiverReport *ReceiverReportSnapshot `json:"last_receiver_report,omitempty"`
}

type ReceiverReportSnapshot struct {
	SSRC                uint32  `json:"ssrc"`
	FractionLost        uint8   `json:"fraction_lost"`
	FractionLostPercent float64 `json:"fraction_lost_percent"`
	TotalLost           uint32  `json:"total_lost"`
	LastSequenceNumber  uint32  `json:"last_sequence_number"`
	Jitter              uint32  `json:"jitter"`
	JitterMS            float64 `json:"jitter_ms"`
}

type EgressDiagnostics struct {
	RecentErrors []string `json:"recent_errors,omitempty"`
}

type BrowserEgressReport struct {
	Type        string                  `json:"type,omitempty"`
	Channel     int                     `json:"channel,omitempty"`
	Time        string                  `json:"time,omitempty"`
	Connection  BrowserConnectionState  `json:"connection,omitempty"`
	InboundRTP  BrowserInboundRTPStats  `json:"inbound_rtp,omitempty"`
	Video       BrowserVideoState       `json:"video,omitempty"`
	DataChannel BrowserDataChannelState `json:"data_channel,omitempty"`
}

type BrowserConnectionState struct {
	ConnectionState    string `json:"connection_state,omitempty"`
	ICEConnectionState string `json:"ice_connection_state,omitempty"`
	ICEGatheringState  string `json:"ice_gathering_state,omitempty"`
	SignalingState     string `json:"signaling_state,omitempty"`
}

type BrowserInboundRTPStats struct {
	BytesReceived   uint64  `json:"bytes_received,omitempty"`
	PacketsReceived uint64  `json:"packets_received,omitempty"`
	PacketsLost     int64   `json:"packets_lost,omitempty"`
	FramesReceived  uint64  `json:"frames_received,omitempty"`
	FramesDecoded   uint64  `json:"frames_decoded,omitempty"`
	FramesDropped   uint64  `json:"frames_dropped,omitempty"`
	FramesPerSecond float64 `json:"frames_per_second,omitempty"`
	FrameWidth      uint64  `json:"frame_width,omitempty"`
	FrameHeight     uint64  `json:"frame_height,omitempty"`
	FreezeCount     uint64  `json:"freeze_count,omitempty"`
	PauseCount      uint64  `json:"pause_count,omitempty"`
	BitrateBPS      float64 `json:"bitrate_bps,omitempty"`
}

type BrowserVideoState struct {
	ReadyState     uint16  `json:"ready_state"`
	Paused         bool    `json:"paused"`
	CurrentTime    float64 `json:"current_time"`
	VideoWidth     uint64  `json:"video_width,omitempty"`
	VideoHeight    uint64  `json:"video_height,omitempty"`
	LastFrameAgeMS int64   `json:"last_frame_age_ms,omitempty"`
	Active         bool    `json:"active"`
}

type BrowserDataChannelState struct {
	State                  string `json:"state,omitempty"`
	MetadataMessagesPerSec uint64 `json:"metadata_messages_per_sec,omitempty"`
}

func NewEgressStats(channel int) *EgressStats {
	return &EgressStats{channel: channel, peers: map[uint64]*EgressPeerStats{}}
}

func (s *EgressStats) RegisterPeer() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextPeerID++
	now := time.Now()
	peer := &EgressPeerStats{
		ID:               s.nextPeerID,
		CreatedAt:        now,
		LastUpdatedAt:    now,
		ConnectionState:  "new",
		ICEState:         "new",
		SignalingState:   "stable",
		DataChannelState: "new",
	}
	s.peers[peer.ID] = peer
	return peer.ID
}

func (s *EgressStats) UpdatePeerConnectionState(peerID uint64, connectionState, iceState, signalingState string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	peer := s.ensurePeerLocked(peerID)
	now := time.Now()
	peer.LastUpdatedAt = now
	if connectionState != "" {
		peer.ConnectionState = connectionState
	}
	if iceState != "" {
		peer.ICEState = iceState
	}
	if signalingState != "" {
		peer.SignalingState = signalingState
	}
}

func (s *EgressStats) UpdateDataChannelState(peerID uint64, state string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	peer := s.ensurePeerLocked(peerID)
	peer.LastUpdatedAt = time.Now()
	peer.DataChannelState = state
}

func (s *EgressStats) RecordMetadataSent(peerID uint64, messageBytes int) {
	if peerID == 0 || messageBytes <= 0 {
		return
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	peer := s.ensurePeerLocked(peerID)
	peer.LastUpdatedAt = now
	peer.metadataLastSentAt = now
	peer.metadataMessagesSent++
	peer.metadataBytesSent += uint64(messageBytes)
	peer.updateMetadataSampleLocked(messageBytes, now)
}

func (s *EgressStats) RecordMetadataSendError(peerID uint64, err error) {
	if peerID == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	peer := s.ensurePeerLocked(peerID)
	peer.metadataSendErrors++
	if err != nil {
		peer.addRecentErrorLocked("metadata send failed: " + err.Error())
	} else {
		peer.addRecentErrorLocked("metadata send failed")
	}
}

func (s *EgressStats) RecordMetadataDroppedNoDataChannel() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metadataDroppedNoDC++
}

func (s *EgressStats) RecordRTCP(peerID uint64, packets []rtcp.Packet) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	peer := s.ensurePeerLocked(peerID)
	peer.LastUpdatedAt = now
	peer.LastRTCPAt = now
	peer.rtcpPacketsReceived += uint64(len(packets))

	for _, packet := range packets {
		switch pkt := packet.(type) {
		case *rtcp.ReceiverReport:
			peer.receiverReports++
			if len(pkt.Reports) > 0 {
				peer.LastReceiverReport = receiverReportSnapshot(pkt.Reports[0])
			}
		case *rtcp.PictureLossIndication:
			peer.pliCount++
		case *rtcp.FullIntraRequest:
			peer.firCount++
		case *rtcp.TransportLayerNack:
			peer.nackCount++
			for _, nack := range pkt.Nacks {
				peer.nackPacketCount += uint64(len(nack.PacketList()))
			}
		case *rtcp.ReceiverEstimatedMaximumBitrate:
			peer.rembCount++
			peer.lastREMBBitrateBPS = float64(pkt.Bitrate)
		}
	}
}

func (s *EgressStats) RecordRTCPError(peerID uint64, err error) {
	if err == nil || err == io.ErrClosedPipe {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	peer := s.ensurePeerLocked(peerID)
	peer.addRecentErrorLocked("rtcp read failed: " + err.Error())
}

func (s *EgressStats) RecordBrowserReport(peerID uint64, raw []byte) bool {
	var report BrowserEgressReport
	if err := json.Unmarshal(raw, &report); err != nil || report.Type != "browser_egress_stats" {
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	peer := s.ensurePeerLocked(peerID)
	now := time.Now()
	peer.LastUpdatedAt = now
	peer.LastBrowserReportAt = now
	peer.LastBrowserReport = &report
	return true
}

func (s *EgressStats) Snapshot(includeAll bool, includeVerbose bool, now time.Time) (ChannelEgressSnapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	channel := ChannelEgressSnapshot{
		Channel: s.channel,
		Peers:   []EgressPeerSnapshot{},
		Metadata: ChannelMetadataEgressSnapshot{
			DroppedNoDataChan: s.metadataDroppedNoDC,
		},
	}
	for _, peer := range s.sortedPeersLocked() {
		active := isEgressPeerActive(peer, now)
		if active {
			channel.Active = true
			channel.PeerCount++
		}
		if !includeAll && !active {
			continue
		}
		channel.Peers = append(channel.Peers, peer.snapshot(active, includeVerbose))
	}

	if !includeAll && !channel.Active {
		return channel, false
	}
	return channel, true
}

func (s *EgressStats) ensurePeerLocked(peerID uint64) *EgressPeerStats {
	if peer, ok := s.peers[peerID]; ok {
		return peer
	}
	now := time.Now()
	peer := &EgressPeerStats{ID: peerID, CreatedAt: now, LastUpdatedAt: now}
	s.peers[peerID] = peer
	return peer
}

func (s *EgressStats) sortedPeersLocked() []*EgressPeerStats {
	peers := make([]*EgressPeerStats, 0, len(s.peers))
	for _, peer := range s.peers {
		peers = append(peers, peer)
	}
	sort.Slice(peers, func(i, j int) bool { return peers[i].ID < peers[j].ID })
	return peers
}

func (p *EgressPeerStats) snapshot(active bool, includeVerbose bool) EgressPeerSnapshot {
	metadataBitrate := p.metadataBitrateBps
	metadataRate := p.metadataMessageRateMPS
	if p.metadataLastSentAt.IsZero() || time.Since(p.metadataLastSentAt) > egressActiveTTL {
		metadataBitrate = 0
		metadataRate = 0
	}

	snapshot := EgressPeerSnapshot{
		ID:                  p.ID,
		Active:              active,
		CreatedAt:           formatTime(p.CreatedAt),
		LastUpdatedAt:       formatTime(p.LastUpdatedAt),
		LastRTCPAt:          formatTime(p.LastRTCPAt),
		LastBrowserReportAt: formatTime(p.LastBrowserReportAt),
		ConnectionState:     p.ConnectionState,
		ICEState:            p.ICEState,
		SignalingState:      p.SignalingState,
		DataChannelState:    p.DataChannelState,
		RTCP: RTCPEgressSnapshot{
			PacketsReceived:    p.rtcpPacketsReceived,
			ReceiverReports:    p.receiverReports,
			PLICount:           p.pliCount,
			FIRCount:           p.firCount,
			NACKCount:          p.nackCount,
			NACKPacketCount:    p.nackPacketCount,
			REMBCount:          p.rembCount,
			LastREMBBitrateBPS: p.lastREMBBitrateBPS,
			LastReceiverReport: p.LastReceiverReport,
		},
		Browser: p.LastBrowserReport,
		Metadata: MetadataEgressSnapshot{
			MessagesSent:   p.metadataMessagesSent,
			BytesSent:      p.metadataBytesSent,
			BitrateBPS:     roundFloat(metadataBitrate, 1),
			MessageRateMPS: roundFloat(metadataRate, 1),
			SendErrors:     p.metadataSendErrors,
			LastSentAt:     formatTime(p.metadataLastSentAt),
		},
	}
	if includeVerbose {
		snapshot.Diagnostics = &EgressDiagnostics{RecentErrors: append([]string(nil), p.recentErrors...)}
	}
	return snapshot
}

func (p *EgressPeerStats) updateMetadataSampleLocked(messageBytes int, now time.Time) {
	if p.metadataSampleStarted.IsZero() {
		p.metadataSampleStarted = now
	}
	p.metadataSampleBytes += uint64(messageBytes)
	p.metadataSampleMessages++

	elapsed := now.Sub(p.metadataSampleStarted)
	if elapsed < time.Second {
		return
	}
	seconds := elapsed.Seconds()
	p.metadataBitrateBps = (float64(p.metadataSampleBytes) * 8) / seconds
	p.metadataMessageRateMPS = float64(p.metadataSampleMessages) / seconds
	p.metadataSampleStarted = now
	p.metadataSampleBytes = 0
	p.metadataSampleMessages = 0
}

func (p *EgressPeerStats) addRecentErrorLocked(message string) {
	if message == "" {
		return
	}
	p.recentErrors = append(p.recentErrors, formatTime(time.Now())+" "+message)
	if len(p.recentErrors) > maxRecentErrors {
		p.recentErrors = p.recentErrors[len(p.recentErrors)-maxRecentErrors:]
	}
}

func receiverReportSnapshot(report rtcp.ReceptionReport) *ReceiverReportSnapshot {
	return &ReceiverReportSnapshot{
		SSRC:                report.SSRC,
		FractionLost:        report.FractionLost,
		FractionLostPercent: roundFloat((float64(report.FractionLost)/256)*100, 3),
		TotalLost:           report.TotalLost,
		LastSequenceNumber:  report.LastSequenceNumber,
		Jitter:              report.Jitter,
		JitterMS:            roundFloat((float64(report.Jitter)/h264ClockRate)*1000, 3),
	}
}

func isEgressPeerActive(peer *EgressPeerStats, now time.Time) bool {
	if peer == nil {
		return false
	}
	if peer.ConnectionState == "closed" || peer.ConnectionState == "failed" {
		return false
	}
	if !peer.LastBrowserReportAt.IsZero() && now.Sub(peer.LastBrowserReportAt) <= egressActiveTTL {
		return true
	}
	if !peer.LastRTCPAt.IsZero() && now.Sub(peer.LastRTCPAt) <= egressActiveTTL {
		return true
	}
	return peer.ConnectionState == "connected" || peer.ICEState == "connected" || peer.ICEState == "completed"
}

func handleEgressStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")

	includeAll := shouldIncludeAll(r)
	includeVerbose := shouldIncludeVerbose(r)
	now := time.Now()
	response := EgressStatsResponse{
		Time:        formatTime(now),
		ActiveTTLMS: egressActiveTTL.Milliseconds(),
		Channels:    []ChannelEgressSnapshot{},
	}

	for _, ch := range channels {
		if ch == nil || ch.Egress == nil {
			continue
		}
		snapshot, ok := ch.Egress.Snapshot(includeAll, includeVerbose, now)
		if !ok {
			continue
		}
		response.Channels = append(response.Channels, snapshot)
	}

	json.NewEncoder(w).Encode(response)
}

func readSenderRTCP(sender *webrtc.RTPSender, stats *EgressStats, peerID uint64) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			stats.RecordRTCPError(peerID, err)
			return
		}
		stats.RecordRTCP(peerID, packets)
	}
}
