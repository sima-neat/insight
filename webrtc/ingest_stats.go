package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/rtp"
)

const (
	ingestActiveTTL = 3 * time.Second
	h264ClockRate   = 90000
	maxRecentErrors = 8
)

type IngestStats struct {
	mu sync.Mutex

	channel         int
	udpPort         int
	metadataUDPPort int

	firstPacketAt time.Time
	lastPacketAt  time.Time
	remoteAddr    string

	packetsReceived  uint64
	bytesReceived    uint64
	packetsForwarded uint64
	bytesForwarded   uint64
	droppedNoTrack   uint64
	writeErrors      uint64
	malformedPackets uint64

	ssrc             uint32
	payloadType      uint8
	payloadTypesSeen map[uint8]uint64
	lastSequence     uint16
	lastRTPTimestamp uint32
	haveSequence     bool
	sequenceGaps     uint64

	haveTransit bool
	lastTransit int64
	jitter      float64

	sampleStartedAt time.Time
	sampleBytes     uint64
	samplePackets   uint64
	bitrateBps      float64
	packetRatePPS   float64

	metadataFirstMessageAt time.Time
	metadataLastMessageAt  time.Time
	metadataRemoteAddr     string

	metadataMessagesReceived  uint64
	metadataBytesReceived     uint64
	metadataMessagesForwarded uint64
	metadataBytesForwarded    uint64
	metadataDroppedNoDC       uint64
	metadataSendErrors        uint64
	metadataInvalidJSON       uint64

	metadataSampleStartedAt time.Time
	metadataSampleBytes     uint64
	metadataSampleMessages  uint64
	metadataBitrateBps      float64
	metadataMessageRateMPS  float64

	seenSPS                bool
	seenPPS                bool
	idrCount               uint64
	lastSPSAt              time.Time
	lastPPSAt              time.Time
	lastIDRAt              time.Time
	nalTypeCounts          map[uint8]uint64
	packetizationModesSeen map[string]uint64

	peers      map[uint64]string
	nextPeerID uint64

	recentErrors []string
}

type IngestStatsResponse struct {
	Time        string                  `json:"time"`
	ActiveTTLMS int64                   `json:"active_ttl_ms"`
	Channels    []ChannelIngestSnapshot `json:"channels"`
}

type ChannelIngestSnapshot struct {
	Channel       int                  `json:"channel"`
	UDPPort       int                  `json:"udp_port"`
	Metadata      MetadataSnapshot     `json:"metadata"`
	Active        bool                 `json:"active"`
	FirstPacketAt string               `json:"first_packet_at,omitempty"`
	LastPacketAt  string               `json:"last_packet_at,omitempty"`
	RemoteAddr    string               `json:"remote_addr,omitempty"`
	RTP           RTPIngestSnapshot    `json:"rtp"`
	Forwarding    ForwardingSnapshot   `json:"forwarding"`
	Media         MediaSnapshot        `json:"media"`
	WebRTC        WebRTCSnapshot       `json:"webrtc"`
	Diagnostics   *DiagnosticsSnapshot `json:"diagnostics,omitempty"`
}

type RTPIngestSnapshot struct {
	SSRC               uint32  `json:"ssrc,omitempty"`
	PayloadType        uint8   `json:"payload_type,omitempty"`
	PacketsReceived    uint64  `json:"packets_received"`
	BytesReceived      uint64  `json:"bytes_received"`
	BitrateBPS         float64 `json:"bitrate_bps"`
	PacketRatePPS      float64 `json:"packet_rate_pps"`
	LastSequenceNumber uint16  `json:"last_sequence_number,omitempty"`
	LastTimestamp      uint32  `json:"last_timestamp,omitempty"`
}

type ForwardingSnapshot struct {
	WebRTCTrackAttached   bool   `json:"webrtc_track_attached"`
	PacketsForwarded      uint64 `json:"packets_forwarded"`
	BytesForwarded        uint64 `json:"bytes_forwarded"`
	PacketsDroppedNoTrack uint64 `json:"packets_dropped_no_track"`
	WriteErrors           uint64 `json:"write_errors"`
}

type MetadataSnapshot struct {
	UDPPort           int     `json:"udp_port"`
	Active            bool    `json:"active"`
	FirstMessageAt    string  `json:"first_message_at,omitempty"`
	LastMessageAt     string  `json:"last_message_at,omitempty"`
	RemoteAddr        string  `json:"remote_addr,omitempty"`
	MessagesReceived  uint64  `json:"messages_received"`
	BytesReceived     uint64  `json:"bytes_received"`
	BitrateBPS        float64 `json:"bitrate_bps"`
	MessageRateMPS    float64 `json:"message_rate_mps"`
	MessagesForwarded uint64  `json:"messages_forwarded"`
	BytesForwarded    uint64  `json:"bytes_forwarded"`
	DroppedNoDataChan uint64  `json:"dropped_no_data_channel"`
	SendErrors        uint64  `json:"send_errors"`
	InvalidJSON       uint64  `json:"invalid_json"`
}

type MediaSnapshot struct {
	Kind      string `json:"kind"`
	Codec     string `json:"codec"`
	ClockRate int    `json:"clock_rate"`
	SeenSPS   bool   `json:"seen_sps"`
	SeenPPS   bool   `json:"seen_pps"`
	IDRCount  uint64 `json:"idr_count"`
	LastSPSAt string `json:"last_sps_at,omitempty"`
	LastPPSAt string `json:"last_pps_at,omitempty"`
	LastIDRAt string `json:"last_idr_at,omitempty"`
}

type WebRTCSnapshot struct {
	PeerCount        int            `json:"peer_count"`
	ConnectionStates map[string]int `json:"connection_states"`
}

type DiagnosticsSnapshot struct {
	PayloadTypesSeen       map[string]uint64 `json:"payload_types_seen,omitempty"`
	NALTypeCounts          map[string]uint64 `json:"nal_type_counts,omitempty"`
	PacketizationModesSeen map[string]uint64 `json:"packetization_modes_seen,omitempty"`
	EstimatedSequenceGaps  uint64            `json:"estimated_sequence_gaps"`
	EstimatedJitterMS      float64           `json:"estimated_jitter_ms"`
	MalformedPackets       uint64            `json:"malformed_packets"`
	RecentErrors           []string          `json:"recent_errors,omitempty"`
}

type h264NALObservation struct {
	Type  uint8
	Start bool
	Mode  string
}

func NewIngestStats(channel, udpPort int, metadataUDPPort int) *IngestStats {
	return &IngestStats{
		channel:                channel,
		udpPort:                udpPort,
		metadataUDPPort:        metadataUDPPort,
		payloadTypesSeen:       map[uint8]uint64{},
		nalTypeCounts:          map[uint8]uint64{},
		packetizationModesSeen: map[string]uint64{},
		peers:                  map[uint64]string{},
	}
}

func (s *IngestStats) RecordRTPPacket(pkt *rtp.Packet, packetBytes int, remote net.Addr) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.firstPacketAt.IsZero() {
		s.firstPacketAt = now
	}
	s.lastPacketAt = now
	if remote != nil {
		s.remoteAddr = remote.String()
	}

	s.packetsReceived++
	s.bytesReceived += uint64(packetBytes)
	previousSSRC := s.ssrc
	s.payloadType = pkt.PayloadType
	s.payloadTypesSeen[pkt.PayloadType]++
	s.updateSequenceGap(pkt, previousSSRC)
	s.updateJitter(pkt, now)
	s.updateSample(packetBytes, now)
	s.updateH264Media(pkt.Payload, now)
	s.ssrc = pkt.SSRC
	s.lastSequence = pkt.SequenceNumber
	s.lastRTPTimestamp = pkt.Timestamp
}

func (s *IngestStats) RecordMetadataMessage(messageBytes int, remote net.Addr, payload []byte) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.metadataFirstMessageAt.IsZero() {
		s.metadataFirstMessageAt = now
	}
	s.metadataLastMessageAt = now
	if remote != nil {
		s.metadataRemoteAddr = remote.String()
	}

	s.metadataMessagesReceived++
	s.metadataBytesReceived += uint64(messageBytes)
	if len(payload) > 0 && !json.Valid(payload) {
		s.metadataInvalidJSON++
	}

	s.updateMetadataSample(messageBytes, now)
}

func (s *IngestStats) RecordMetadataForwarded(messageBytes int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metadataMessagesForwarded++
	s.metadataBytesForwarded += uint64(messageBytes)
}

func (s *IngestStats) RecordMetadataDroppedNoDataChannel() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metadataDroppedNoDC++
}

func (s *IngestStats) RecordMetadataSendError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metadataSendErrors++
	if err != nil {
		s.addRecentErrorLocked(fmt.Sprintf("metadata datachannel send failed: %v", err))
	} else {
		s.addRecentErrorLocked("metadata datachannel send failed")
	}
}

func (s *IngestStats) RecordForwarded(packetBytes int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.packetsForwarded++
	s.bytesForwarded += uint64(packetBytes)
}

func (s *IngestStats) RecordDroppedNoTrack() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.droppedNoTrack++
}

func (s *IngestStats) RecordWriteError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writeErrors++
	s.addRecentErrorLocked(fmt.Sprintf("track write failed: %v", err))
}

func (s *IngestStats) RecordMalformedPacket(packetBytes int, remote net.Addr, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if remote != nil {
		s.remoteAddr = remote.String()
	}
	s.malformedPackets++
	s.addRecentErrorLocked(fmt.Sprintf("rtp unmarshal failed from %s (%d bytes): %v", s.remoteAddr, packetBytes, err))
}

func (s *IngestStats) RegisterPeer() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextPeerID++
	peerID := s.nextPeerID
	s.peers[peerID] = "new"
	return peerID
}

func (s *IngestStats) UpdatePeerState(peerID uint64, state string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if state == "" {
		state = "unknown"
	}
	s.peers[peerID] = state
}

func (s *IngestStats) Snapshot(includeVerbose bool, trackAttached bool, now time.Time) ChannelIngestSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()

	active := !s.lastPacketAt.IsZero() && now.Sub(s.lastPacketAt) <= ingestActiveTTL
	bitrate := s.bitrateBps
	packetRate := s.packetRatePPS
	if !active {
		bitrate = 0
		packetRate = 0
	}

	snapshot := ChannelIngestSnapshot{
		Channel:       s.channel,
		UDPPort:       s.udpPort,
		Metadata:      s.snapshotMetadataLocked(now),
		Active:        active,
		FirstPacketAt: formatTime(s.firstPacketAt),
		LastPacketAt:  formatTime(s.lastPacketAt),
		RemoteAddr:    s.remoteAddr,
		RTP: RTPIngestSnapshot{
			SSRC:               s.ssrc,
			PayloadType:        s.payloadType,
			PacketsReceived:    s.packetsReceived,
			BytesReceived:      s.bytesReceived,
			BitrateBPS:         roundFloat(bitrate, 1),
			PacketRatePPS:      roundFloat(packetRate, 1),
			LastSequenceNumber: s.lastSequence,
			LastTimestamp:      s.lastRTPTimestamp,
		},
		Forwarding: ForwardingSnapshot{
			WebRTCTrackAttached:   trackAttached,
			PacketsForwarded:      s.packetsForwarded,
			BytesForwarded:        s.bytesForwarded,
			PacketsDroppedNoTrack: s.droppedNoTrack,
			WriteErrors:           s.writeErrors,
		},
		Media: MediaSnapshot{
			Kind:      "video",
			Codec:     "H264",
			ClockRate: h264ClockRate,
			SeenSPS:   s.seenSPS,
			SeenPPS:   s.seenPPS,
			IDRCount:  s.idrCount,
			LastSPSAt: formatTime(s.lastSPSAt),
			LastPPSAt: formatTime(s.lastPPSAt),
			LastIDRAt: formatTime(s.lastIDRAt),
		},
		WebRTC: s.snapshotWebRTC(),
	}

	if includeVerbose {
		snapshot.Diagnostics = &DiagnosticsSnapshot{
			PayloadTypesSeen:       uint8MapToStringMap(s.payloadTypesSeen),
			NALTypeCounts:          uint8MapToStringMap(s.nalTypeCounts),
			PacketizationModesSeen: copyStringUint64Map(s.packetizationModesSeen),
			EstimatedSequenceGaps:  s.sequenceGaps,
			EstimatedJitterMS:      roundFloat((s.jitter/h264ClockRate)*1000, 3),
			MalformedPackets:       s.malformedPackets,
			RecentErrors:           append([]string(nil), s.recentErrors...),
		}
	}

	return snapshot
}

func (s *IngestStats) snapshotMetadataLocked(now time.Time) MetadataSnapshot {
	active := !s.metadataLastMessageAt.IsZero() && now.Sub(s.metadataLastMessageAt) <= ingestActiveTTL
	bitrate := s.metadataBitrateBps
	messageRate := s.metadataMessageRateMPS
	if !active {
		bitrate = 0
		messageRate = 0
	}
	return MetadataSnapshot{
		UDPPort:           s.metadataUDPPort,
		Active:            active,
		FirstMessageAt:    formatTime(s.metadataFirstMessageAt),
		LastMessageAt:     formatTime(s.metadataLastMessageAt),
		RemoteAddr:        s.metadataRemoteAddr,
		MessagesReceived:  s.metadataMessagesReceived,
		BytesReceived:     s.metadataBytesReceived,
		BitrateBPS:        roundFloat(bitrate, 1),
		MessageRateMPS:    roundFloat(messageRate, 1),
		MessagesForwarded: s.metadataMessagesForwarded,
		BytesForwarded:    s.metadataBytesForwarded,
		DroppedNoDataChan: s.metadataDroppedNoDC,
		SendErrors:        s.metadataSendErrors,
		InvalidJSON:       s.metadataInvalidJSON,
	}
}

func (s *IngestStats) updateSequenceGap(pkt *rtp.Packet, previousSSRC uint32) {
	if !s.haveSequence || pkt.SSRC != previousSSRC {
		s.haveSequence = true
		return
	}
	expected := s.lastSequence + 1
	if pkt.SequenceNumber != expected {
		gap := uint16(pkt.SequenceNumber - expected)
		if gap > 0 {
			s.sequenceGaps += uint64(gap)
		}
	}
}

func (s *IngestStats) updateJitter(pkt *rtp.Packet, now time.Time) {
	arrivalRTPUnits := (now.UnixNano() * h264ClockRate) / int64(time.Second)
	transit := arrivalRTPUnits - int64(pkt.Timestamp)
	if s.haveTransit {
		d := transit - s.lastTransit
		if d < 0 {
			d = -d
		}
		s.jitter += (float64(d) - s.jitter) / 16
	}
	s.lastTransit = transit
	s.haveTransit = true
}

func (s *IngestStats) updateSample(packetBytes int, now time.Time) {
	if s.sampleStartedAt.IsZero() {
		s.sampleStartedAt = now
	}
	s.sampleBytes += uint64(packetBytes)
	s.samplePackets++

	elapsed := now.Sub(s.sampleStartedAt)
	if elapsed < time.Second {
		return
	}
	seconds := elapsed.Seconds()
	s.bitrateBps = (float64(s.sampleBytes) * 8) / seconds
	s.packetRatePPS = float64(s.samplePackets) / seconds
	s.sampleStartedAt = now
	s.sampleBytes = 0
	s.samplePackets = 0
}

func (s *IngestStats) updateMetadataSample(messageBytes int, now time.Time) {
	if s.metadataSampleStartedAt.IsZero() {
		s.metadataSampleStartedAt = now
	}
	s.metadataSampleBytes += uint64(messageBytes)
	s.metadataSampleMessages++

	elapsed := now.Sub(s.metadataSampleStartedAt)
	if elapsed < time.Second {
		return
	}
	seconds := elapsed.Seconds()
	s.metadataBitrateBps = (float64(s.metadataSampleBytes) * 8) / seconds
	s.metadataMessageRateMPS = float64(s.metadataSampleMessages) / seconds
	s.metadataSampleStartedAt = now
	s.metadataSampleBytes = 0
	s.metadataSampleMessages = 0
}

func (s *IngestStats) updateH264Media(payload []byte, now time.Time) {
	for _, obs := range parseH264NALObservations(payload) {
		s.nalTypeCounts[obs.Type]++
		if obs.Mode != "" {
			s.packetizationModesSeen[obs.Mode]++
		}
		switch obs.Type {
		case 5:
			if obs.Start {
				s.idrCount++
				s.lastIDRAt = now
			}
		case 7:
			s.seenSPS = true
			s.lastSPSAt = now
		case 8:
			s.seenPPS = true
			s.lastPPSAt = now
		}
	}
}

func (s *IngestStats) snapshotWebRTC() WebRTCSnapshot {
	states := map[string]int{}
	peerCount := 0
	for _, state := range s.peers {
		states[state]++
		if state != "closed" && state != "failed" {
			peerCount++
		}
	}
	return WebRTCSnapshot{PeerCount: peerCount, ConnectionStates: states}
}

func (s *IngestStats) addRecentErrorLocked(message string) {
	if message == "" {
		return
	}
	s.recentErrors = append(s.recentErrors, fmt.Sprintf("%s %s", time.Now().UTC().Format(time.RFC3339Nano), message))
	if len(s.recentErrors) > maxRecentErrors {
		s.recentErrors = s.recentErrors[len(s.recentErrors)-maxRecentErrors:]
	}
}

func parseH264NALObservations(payload []byte) []h264NALObservation {
	if len(payload) == 0 {
		return nil
	}
	nalType := payload[0] & 0x1f
	switch nalType {
	case 1, 2, 3, 4, 5, 6, 7, 8, 9:
		return []h264NALObservation{{Type: nalType, Start: true, Mode: "single-nal"}}
	case 24:
		return parseSTAPA(payload)
	case 28:
		if len(payload) < 2 {
			return nil
		}
		return []h264NALObservation{{
			Type:  payload[1] & 0x1f,
			Start: payload[1]&0x80 != 0,
			Mode:  "fu-a",
		}}
	default:
		return []h264NALObservation{{Type: nalType, Start: true, Mode: "other"}}
	}
}

func parseSTAPA(payload []byte) []h264NALObservation {
	var observations []h264NALObservation
	offset := 1
	for offset+2 <= len(payload) {
		size := int(payload[offset])<<8 | int(payload[offset+1])
		offset += 2
		if size <= 0 || offset+size > len(payload) {
			break
		}
		observations = append(observations, h264NALObservation{
			Type:  payload[offset] & 0x1f,
			Start: true,
			Mode:  "stap-a",
		})
		offset += size
	}
	return observations
}

func shouldIncludeAll(r *http.Request) bool {
	return truthyQuery(r, "all")
}

func shouldIncludeVerbose(r *http.Request) bool {
	return truthyQuery(r, "verbose")
}

func truthyQuery(r *http.Request, key string) bool {
	value := strings.ToLower(strings.TrimSpace(r.URL.Query().Get(key)))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

func roundFloat(value float64, precision int) float64 {
	scale := 1.0
	for i := 0; i < precision; i++ {
		scale *= 10
	}
	if value >= 0 {
		return float64(int(value*scale+0.5)) / scale
	}
	return float64(int(value*scale-0.5)) / scale
}

func uint8MapToStringMap(input map[uint8]uint64) map[string]uint64 {
	if len(input) == 0 {
		return nil
	}
	keys := make([]int, 0, len(input))
	for key := range input {
		keys = append(keys, int(key))
	}
	sort.Ints(keys)
	output := make(map[string]uint64, len(input))
	for _, key := range keys {
		output[strconv.Itoa(key)] = input[uint8(key)]
	}
	return output
}

func copyStringUint64Map(input map[string]uint64) map[string]uint64 {
	if len(input) == 0 {
		return nil
	}
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	output := make(map[string]uint64, len(input))
	for _, key := range keys {
		output[key] = input[key]
	}
	return output
}
