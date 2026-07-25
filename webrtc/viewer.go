// viewer.go
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type Channel struct {
	Port          int
	Codec         atomic.Uint32
	Track         atomic.Pointer[webrtc.TrackLocalStaticRTP]
	MetadataPeers metadataPeerRegistry
	MetadataSync  *metadataTimestampCorrelator
	MetadataReady *metadataForwardQueue
	Stats         *IngestStats
	Egress        *EgressStats
}

var channels [80]*Channel

type videoCodec uint32

const (
	videoCodecUnknown videoCodec = iota
	videoCodecH264
	videoCodecH265
)

const (
	h264RTPPayloadType = 96
	h265RTPPayloadType = 98
)

func videoCodecForPayloadType(payloadType uint8) videoCodec {
	switch payloadType {
	case h264RTPPayloadType:
		return videoCodecH264
	case h265RTPPayloadType:
		return videoCodecH265
	default:
		return videoCodecUnknown
	}
}

const (
	neatPortMapPath              = "/home/docker/.insight-config/neat-port-map.json"
	defaultEphemeralUDPPortStart = uint16(40000)
	defaultEphemeralUDPPortEnd   = uint16(40200)
	minValidEphemeralUDPPort     = 1
	maxValidEphemeralUDPPort     = 65535
	initialRTPTimestamp          = uint32(1110000000)
	rtpReceiveBufferBytes        = 2 * 1024 * 1024
	metadataCorrelationCapacity  = 256
	metadataForwardQueueCapacity = 16
	metadataCorrelationMaxAge    = 5 * time.Second
)

type neatPortMapConfig struct {
	WebRTC *udpPortRangeConfig `json:"webRTC"`
}

type udpPortRangeConfig struct {
	ContainerStart int `json:"containerStart"`
	ContainerEnd   int `json:"containerEnd"`
}

type rtpTimestampRewriter struct {
	nextTimestamp uint32
	lastFrameAt   time.Time
	haveFrameTime bool
}

type rtpPacketRewriter struct {
	nextSequence uint16
	haveSequence bool
}

type rtpAccessUnit struct {
	packets   [][]byte
	ssrc      uint32
	timestamp uint32
}

type rtpAccessUnitBuffer struct {
	packets                    [][]byte
	ssrc                       uint32
	timestamp                  uint32
	nextSequence               uint16
	sequenceSSRC               uint32
	haveSequence               bool
	codec                      videoCodec
	complete                   bool
	discontinuity              bool
	randomAccess               bool
	waitingForH265RandomAccess bool
	active                     bool
}

func newRTPAccessUnitBuffer() *rtpAccessUnitBuffer {
	return &rtpAccessUnitBuffer{waitingForH265RandomAccess: true}
}

func (b *rtpAccessUnitBuffer) resetH265Recovery() {
	b.waitingForH265RandomAccess = true
}

func (b *rtpAccessUnitBuffer) accept(pkt *rtp.Packet, raw []byte) (rtpAccessUnit, bool) {
	codec := videoCodecForPayloadType(pkt.PayloadType)
	if codec == videoCodecUnknown {
		return rtpAccessUnit{}, false
	}

	startsAccessUnit, randomAccess := h265PacketState(pkt)
	sequenceDiscontinuity := b.haveSequence &&
		(pkt.SSRC != b.sequenceSSRC || pkt.SequenceNumber != b.nextSequence)
	b.nextSequence = pkt.SequenceNumber + 1
	b.sequenceSSRC = pkt.SSRC
	b.haveSequence = true

	newAccessUnit := !b.active || pkt.SSRC != b.ssrc || pkt.Timestamp != b.timestamp
	if newAccessUnit {
		b.packets = b.packets[:0]
		b.ssrc = pkt.SSRC
		b.timestamp = pkt.Timestamp
		b.codec = codec
		b.complete = startsAccessUnit
		b.discontinuity = b.active || sequenceDiscontinuity
		b.randomAccess = randomAccess
		b.active = true
	} else if sequenceDiscontinuity {
		b.complete = false
		b.discontinuity = true
	}
	b.packets = append(b.packets, raw)
	b.randomAccess = b.randomAccess || randomAccess
	if !pkt.Marker {
		return rtpAccessUnit{}, false
	}

	accessUnit := rtpAccessUnit{
		packets:   b.packets,
		ssrc:      b.ssrc,
		timestamp: b.timestamp,
	}
	accessUnitCodec := b.codec
	complete := b.complete
	discontinuity := b.discontinuity
	randomAccess = b.randomAccess
	b.packets = b.packets[:0]
	b.active = false
	if accessUnitCodec == videoCodecH265 && (discontinuity || !complete) {
		b.waitingForH265RandomAccess = true
	}
	if !complete {
		return rtpAccessUnit{}, false
	}
	if randomAccess {
		b.waitingForH265RandomAccess = false
	}
	if accessUnitCodec == videoCodecH265 && b.waitingForH265RandomAccess {
		return rtpAccessUnit{}, false
	}
	return accessUnit, true
}

func h265PacketState(pkt *rtp.Packet) (bool, bool) {
	if videoCodecForPayloadType(pkt.PayloadType) != videoCodecH265 {
		return true, false
	}
	observations := parseH265NALObservations(pkt.Payload)
	startsAccessUnit := len(observations) > 0 && observations[0].Start
	for _, observation := range observations {
		if observation.Start && observation.Type >= 16 && observation.Type <= 23 {
			return startsAccessUnit, true
		}
	}
	return startsAccessUnit, false
}

func main() {
	certPath := flag.String("cert", "", "Path to TLS certificate (PEM)")
	keyPath := flag.String("key", "", "Path to TLS private key (PEM)")
	flag.Parse()

	for i := 0; i < 80; i++ {
		channels[i] = &Channel{
			Port:          9000 + i,
			MetadataSync:  newMetadataTimestampCorrelator(metadataCorrelationCapacity, metadataCorrelationMaxAge),
			MetadataReady: newMetadataForwardQueue(metadataForwardQueueCapacity),
			Stats:         NewIngestStats(i, 9000+i, 9100+i),
			Egress:        NewEgressStats(i),
		}
		go startUDPListener(channels[i])
		go startMetadataListener(channels[i], 9100+i)
		go startMetadataForwarder(channels[i])
	}

	http.HandleFunc("/", serveViewer)
	http.HandleFunc("/offer", handleOffer)
	http.HandleFunc("/ingest/stats", handleIngestStats)
	http.HandleFunc("/egress/stats", handleEgressStats)
	http.HandleFunc("/reverse", serveReverse)
	http.HandleFunc("/reverse-offer", handleReverseOffer)
	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))

	addr := ":8081"

	if *certPath != "" && *keyPath != "" {
		log.Printf("✅ Serving HTTPS on %s using cert: %s", addr, *certPath)
		log.Fatal(http.ListenAndServeTLS(addr, *certPath, *keyPath, nil))
	} else {
		log.Printf("⚠️ No TLS cert/key provided, serving plain HTTP on %s", addr)
		log.Fatal(http.ListenAndServe(addr, nil))
	}
}

func serveViewer(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, "static/viewer.html")
}

func serveReverse(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, "static/reverse.html")
}

func forwardToUDP(track *webrtc.TrackRemote, udpTarget string) {
	conn, err := net.Dial("udp", udpTarget)
	if err != nil {
		log.Printf("❌ Failed to dial UDP: %v", err)
		return
	}
	defer conn.Close()

	buf := make([]byte, 1400)
	for {
		n, _, readErr := track.Read(buf)
		if readErr != nil {
			log.Printf("⚠️ Read from track error: %v", readErr)
			return
		}
		if _, writeErr := conn.Write(buf[:n]); writeErr != nil {
			log.Printf("⚠️ Write to UDP failed: %v", writeErr)
			return
		}
	}
}

func handleReverseOffer(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	portStr := r.URL.Query().Get("port")
	if portStr == "" {
		http.Error(w, "Missing port parameter", http.StatusBadRequest)
		return
	}

	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		http.Error(w, "Invalid port parameter", http.StatusBadRequest)
		return
	}

	var offer webrtc.SessionDescription
	if err := json.NewDecoder(r.Body).Decode(&offer); err != nil {
		http.Error(w, "Invalid SDP offer", http.StatusBadRequest)
		return
	}

	m := webrtc.MediaEngine{}
	m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   90000,
			SDPFmtpLine: "packetization-mode=1;profile-level-id=42e01f",
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo)

	api := webrtc.NewAPI(webrtc.WithMediaEngine(&m))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		http.Error(w, "PeerConnection failed", http.StatusInternalServerError)
		return
	}

	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		log.Printf("🎥 Incoming track from browser, forwarding to 127.0.0.1:%d", port)
		go forwardToUDP(track, fmt.Sprintf("127.0.0.1:%d", port))
	})

	if err := pc.SetRemoteDescription(offer); err != nil {
		http.Error(w, "SetRemoteDescription failed", http.StatusInternalServerError)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		http.Error(w, "CreateAnswer failed", http.StatusInternalServerError)
		return
	}
	if err = pc.SetLocalDescription(answer); err != nil {
		http.Error(w, "SetLocalDescription failed", http.StatusInternalServerError)
		return
	}
	<-webrtc.GatheringCompletePromise(pc)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(pc.LocalDescription())
}

func handleOffer(w http.ResponseWriter, r *http.Request) {
	channelIdxStr := r.URL.Query().Get("channel")
	idx, err := strconv.Atoi(channelIdxStr)
	if err != nil || idx < 0 || idx >= len(channels) {
		http.Error(w, "Invalid channel index", http.StatusBadRequest)
		return
	}
	ch := channels[idx]

	var offer webrtc.SessionDescription
	if err := json.NewDecoder(r.Body).Decode(&offer); err != nil {
		http.Error(w, "Invalid SDP offer", http.StatusBadRequest)
		return
	}
	codec := videoCodec(ch.Codec.Load())
	if codec == videoCodecUnknown {
		http.Error(w, "Video codec not available", http.StatusServiceUnavailable)
		return
	}

	parameters := webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{ClockRate: h264ClockRate},
	}
	switch codec {
	case videoCodecH264:
		parameters.MimeType = webrtc.MimeTypeH264
		parameters.SDPFmtpLine = "packetization-mode=1;profile-level-id=42e01f"
		parameters.PayloadType = h264RTPPayloadType
	case videoCodecH265:
		parameters.MimeType = webrtc.MimeTypeH265
		parameters.PayloadType = h265RTPPayloadType
	}

	m := webrtc.MediaEngine{}
	m.RegisterCodec(parameters, webrtc.RTPCodecTypeVideo)

	// === Add NAT and Port Range logic ===
	s := webrtc.SettingEngine{}
	portStart, portEnd := configuredEphemeralUDPPortRange()
	if err := s.SetEphemeralUDPPortRange(portStart, portEnd); err != nil {
		log.Printf("⚠️ Failed to set WebRTC UDP port range %d-%d: %v", portStart, portEnd, err)
		http.Error(w, "PeerConnection failed", http.StatusInternalServerError)
		return
	}

	hostIP := os.Getenv("CONTAINER_HOST_IP")

	if ip := net.ParseIP(hostIP); ip != nil && !ip.IsLoopback() && !ip.IsUnspecified() {
		log.Printf("🌐 Using CONTAINER_HOST_IP override: %s", hostIP)
		s.SetNAT1To1IPs([]string{hostIP}, webrtc.ICECandidateTypeHost)
	} else if hostIP != "" {
		log.Printf("⚠️ Ignoring invalid or internal CONTAINER_HOST_IP: %q", hostIP)
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(&m), webrtc.WithSettingEngine(s))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		http.Error(w, "PeerConnection failed", http.StatusInternalServerError)
		return
	}
	ingestPeerID := ch.Stats.RegisterPeer()
	egressPeerID := ch.Egress.RegisterPeer()
	ch.Stats.UpdatePeerState(ingestPeerID, pc.ConnectionState().String())
	ch.Egress.UpdatePeerConnectionState(
		egressPeerID,
		pc.ConnectionState().String(),
		pc.ICEConnectionState().String(),
		pc.SignalingState().String(),
	)
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		ch.Stats.UpdatePeerState(ingestPeerID, state.String())
		ch.Egress.UpdatePeerConnectionState(egressPeerID, state.String(), pc.ICEConnectionState().String(), pc.SignalingState().String())
	})
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		ch.Egress.UpdatePeerConnectionState(egressPeerID, pc.ConnectionState().String(), state.String(), pc.SignalingState().String())
	})
	pc.OnSignalingStateChange(func(state webrtc.SignalingState) {
		ch.Egress.UpdatePeerConnectionState(egressPeerID, pc.ConnectionState().String(), pc.ICEConnectionState().String(), state.String())
	})

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			log.Printf("[Channel %d] ICE candidate: %s", idx, c.String())
		}
	})

	track := ch.Track.Load()
	if track == nil || track.Codec().MimeType != parameters.MimeType {
		track, err = webrtc.NewTrackLocalStaticRTP(parameters.RTPCodecCapability, "video", "pion")
		if err != nil {
			http.Error(w, "Track creation failed", http.StatusInternalServerError)
			return
		}
		ch.Track.Store(track)
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		http.Error(w, "AddTrack failed", http.StatusInternalServerError)
		return
	}
	go readSenderRTCP(sender, ch.Egress, egressPeerID)
	go sendRTCP(pc)

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		log.Printf("[Channel %d] Incoming DataChannel: %s", idx, dc.Label())
		if dc.Label() == "metadata" {
			ch.Egress.UpdateDataChannelState(egressPeerID, "connecting")
			dc.OnOpen(func() {
				log.Printf("[Channel %d] DataChannel open", idx)
				ch.MetadataPeers.add(egressPeerID, dc)
				ch.Egress.UpdateDataChannelState(egressPeerID, "open")
			})
			dc.OnClose(func() {
				log.Printf("[Channel %d] DataChannel closed", idx)
				ch.MetadataPeers.remove(egressPeerID, dc)
				ch.Egress.UpdateDataChannelState(egressPeerID, "closed")
			})
			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				ch.Egress.RecordBrowserReport(egressPeerID, msg.Data)
			})
		}
	})

	if err := pc.SetRemoteDescription(offer); err != nil {
		http.Error(w, "SetRemoteDescription failed", http.StatusInternalServerError)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		http.Error(w, "CreateAnswer failed", http.StatusInternalServerError)
		return
	}
	if err = pc.SetLocalDescription(answer); err != nil {
		http.Error(w, "SetLocalDescription failed", http.StatusInternalServerError)
		return
	}
	<-webrtc.GatheringCompletePromise(pc)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(pc.LocalDescription())
}

func configuredEphemeralUDPPortRange() (uint16, uint16) {
	portStart, portEnd, err := loadEphemeralUDPPortRange(neatPortMapPath)
	if err == nil {
		log.Printf("Using WebRTC UDP port range from %s: %d-%d", neatPortMapPath, portStart, portEnd)
		return portStart, portEnd
	}

	if os.IsNotExist(err) {
		log.Printf("Port map config %s not found; using default WebRTC UDP port range %d-%d", neatPortMapPath, defaultEphemeralUDPPortStart, defaultEphemeralUDPPortEnd)
	} else {
		log.Printf("Failed to load WebRTC UDP port range from %s: %v; using default %d-%d", neatPortMapPath, err, defaultEphemeralUDPPortStart, defaultEphemeralUDPPortEnd)
	}
	return defaultEphemeralUDPPortStart, defaultEphemeralUDPPortEnd
}

func loadEphemeralUDPPortRange(path string) (uint16, uint16, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, err
	}

	var cfg neatPortMapConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return 0, 0, fmt.Errorf("parse port map: %w", err)
	}
	if cfg.WebRTC == nil {
		return 0, 0, fmt.Errorf("missing webRTC section")
	}

	return validateEphemeralUDPPortRange(cfg.WebRTC.ContainerStart, cfg.WebRTC.ContainerEnd)
}

func validateEphemeralUDPPortRange(portStart, portEnd int) (uint16, uint16, error) {
	if portStart < minValidEphemeralUDPPort || portStart > maxValidEphemeralUDPPort {
		return 0, 0, fmt.Errorf("webRTC containerStart %d is outside valid UDP port range", portStart)
	}
	if portEnd < minValidEphemeralUDPPort || portEnd > maxValidEphemeralUDPPort {
		return 0, 0, fmt.Errorf("webRTC containerEnd %d is outside valid UDP port range", portEnd)
	}
	if portEnd < portStart {
		return 0, 0, fmt.Errorf("webRTC containerEnd %d is lower than containerStart %d", portEnd, portStart)
	}

	return uint16(portStart), uint16(portEnd), nil
}

func newRTPTimestampRewriter() rtpTimestampRewriter {
	return rtpTimestampRewriter{nextTimestamp: initialRTPTimestamp}
}

func (r *rtpTimestampRewriter) timestampForFrame(now time.Time) uint32 {
	if r.haveFrameTime {
		step := uint32(float64(h264ClockRate) * now.Sub(r.lastFrameAt).Seconds())
		if step == 0 {
			step = 1
		}
		r.nextTimestamp += step
	}
	r.lastFrameAt = now
	r.haveFrameTime = true
	return r.nextTimestamp
}

func newRTPPacketRewriter() rtpPacketRewriter {
	return rtpPacketRewriter{}
}

func (r *rtpPacketRewriter) rewrite(raw []byte, timestamp uint32) ([]byte, error) {
	var pkt rtp.Packet
	if err := pkt.Unmarshal(raw); err != nil {
		return nil, err
	}
	// Pion preserves input sequence numbers, so keep one continuous outgoing
	// sequence space when incomplete access units are dropped or a source restarts.
	if !r.haveSequence {
		r.nextSequence = pkt.SequenceNumber
		r.haveSequence = true
	}
	pkt.SequenceNumber = r.nextSequence
	pkt.Timestamp = timestamp
	rewritten, err := pkt.Marshal()
	if err != nil {
		return nil, err
	}
	r.nextSequence++
	return rewritten, nil
}

func sendRTCP(pc *webrtc.PeerConnection) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if err := pc.WriteRTCP([]rtcp.Packet{
			&rtcp.PictureLossIndication{MediaSSRC: 1},
		}); err != nil && err != io.ErrClosedPipe {
			log.Println("❌ RTCP PLI send error:", err)
		}
	}
}

func handleIngestStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")

	includeAll := shouldIncludeAll(r)
	includeVerbose := shouldIncludeVerbose(r)
	now := time.Now()
	response := IngestStatsResponse{
		Time:        now.UTC().Format(time.RFC3339Nano),
		ActiveTTLMS: ingestActiveTTL.Milliseconds(),
		Channels:    []ChannelIngestSnapshot{},
	}

	for _, ch := range channels {
		if ch == nil || ch.Stats == nil {
			continue
		}
		snapshot := ch.Stats.Snapshot(includeVerbose, ch.Track.Load() != nil, now)
		if !includeAll && !snapshot.Active {
			continue
		}
		response.Channels = append(response.Channels, snapshot)
	}

	json.NewEncoder(w).Encode(response)
}

func startUDPListener(ch *Channel) {
	addr := net.UDPAddr{IP: net.IPv4zero, Port: ch.Port}
	conn, err := net.ListenUDP("udp", &addr)
	if err != nil {
		log.Fatalf("Failed to bind UDP port %d: %v", ch.Port, err)
	}
	defer conn.Close()
	if err := conn.SetReadBuffer(rtpReceiveBufferBytes); err != nil {
		log.Fatalf("Failed to set RTP receive buffer on port %d: %v", ch.Port, err)
	}

	log.Printf("🧠 Listening for RTP on %s:%d", net.IPv4zero, ch.Port)
	buf := make([]byte, 4096)
	accessUnitBuffer := newRTPAccessUnitBuffer()
	var activeTrack *webrtc.TrackLocalStaticRTP
	timestampRewriter := newRTPTimestampRewriter()
	packetRewriter := newRTPPacketRewriter()

	for {
		n, remoteAddr, err := conn.ReadFrom(buf)
		if err != nil {
			log.Println("RTP read error:", err)
			continue
		}

		var pkt rtp.Packet
		if err := pkt.Unmarshal(buf[:n]); err != nil {
			ch.Stats.RecordMalformedPacket(n, remoteAddr, err)
			log.Println("❌ RTP unmarshal error:", err)
			continue
		}
		if codec := videoCodecForPayloadType(pkt.PayloadType); codec != videoCodecUnknown {
			ch.Codec.Store(uint32(codec))
		}
		ch.Stats.RecordRTPPacket(&pkt, n, remoteAddr)

		track := ch.Track.Load()
		if track != activeTrack {
			accessUnitBuffer.resetH265Recovery()
			activeTrack = track
		}
		raw := append([]byte(nil), buf[:n]...)
		accessUnit, ready := accessUnitBuffer.accept(&pkt, raw)
		if !ready {
			continue
		}

		if track == nil {
			for range accessUnit.packets {
				ch.Stats.RecordDroppedNoTrack()
			}
			accessUnitBuffer.resetH265Recovery()
			activeTrack = nil
			continue
		}

		frameAt := time.Now()
		frameTimestamp := timestampRewriter.timestampForFrame(frameAt)

		frameForwarded := false
		for _, rawPacket := range accessUnit.packets {
			packetToWrite, err := packetRewriter.rewrite(rawPacket, frameTimestamp)
			if err != nil {
				ch.Stats.RecordMalformedPacket(len(rawPacket), remoteAddr, err)
				log.Println("❌ RTP packet rewrite error:", err)
				continue
			}
			if _, err := track.Write(packetToWrite); err != nil && err != io.ErrClosedPipe {
				ch.Stats.RecordWriteError(err)
				log.Println("❌ Write error:", err)
				continue
			}
			ch.Stats.RecordForwarded(len(packetToWrite))
			frameForwarded = true
		}
		if frameForwarded {
			for _, metadata := range ch.MetadataSync.addVideoFrame(
				accessUnit.ssrc, accessUnit.timestamp, frameTimestamp, frameAt,
			) {
				enqueueMetadata(ch, metadata)
			}
		}
	}
}

func startMetadataListener(ch *Channel, port int) {
	addr := net.UDPAddr{IP: net.IPv4zero, Port: port}
	conn, err := net.ListenUDP("udp", &addr)
	if err != nil {
		log.Fatalf("❌ Metadata UDP bind failed on %d: %v", port, err)
	}
	defer conn.Close()

	log.Printf("🧠 Listening for metadata on %s:%d", net.IPv4zero, port)
	buf := make([]byte, 65507)
	reassembler := newMetadataReassembler()

	for {
		n, remoteAddr, err := conn.ReadFrom(buf)
		if err != nil {
			log.Println("Metadata read error:", err)
			continue
		}

		result := reassembler.accept(buf[:n], remoteAddr, time.Now())
		ch.Stats.RecordMetadataReassembly(result)
		if !result.complete {
			continue
		}

		// Trim trailing 0s (null bytes) from fixed-size padded messages
		trimmed := bytes.TrimRight(result.message, "\x00")
		ch.Stats.RecordMetadataMessage(len(trimmed), remoteAddr, trimmed)

		for _, metadata := range ch.MetadataSync.addMetadata(trimmed, time.Now()) {
			enqueueMetadata(ch, metadata)
		}
	}
}
