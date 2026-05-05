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
	Port              int
	Track             atomic.Pointer[webrtc.TrackLocalStaticRTP]
	DataChannel       atomic.Pointer[webrtc.DataChannel]
	DataChannelPeerID atomic.Uint64
	Stats             *IngestStats
	Egress            *EgressStats
}

var channels [80]*Channel

const (
	neatPortMapPath              = "/home/docker/.insight-config/neat-port-map.json"
	defaultEphemeralUDPPortStart = uint16(40000)
	defaultEphemeralUDPPortEnd   = uint16(40200)
	minValidEphemeralUDPPort     = 1
	maxValidEphemeralUDPPort     = 65535
)

type neatPortMapConfig struct {
	WebRTC *udpPortRangeConfig `json:"webRTC"`
}

type udpPortRangeConfig struct {
	ContainerStart int `json:"containerStart"`
	ContainerEnd   int `json:"containerEnd"`
}

func main() {
	certPath := flag.String("cert", "", "Path to TLS certificate (PEM)")
	keyPath := flag.String("key", "", "Path to TLS private key (PEM)")
	flag.Parse()

	for i := 0; i < 80; i++ {
		channels[i] = &Channel{
			Port:   9000 + i,
			Stats:  NewIngestStats(i, 9000+i, 9100+i),
			Egress: NewEgressStats(i),
		}
		go startUDPListener(channels[i])
		go startMetadataListener(channels[i], 9100+i)
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

	m := webrtc.MediaEngine{}
	m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:     webrtc.MimeTypeH264,
			ClockRate:    90000,
			SDPFmtpLine:  "packetization-mode=1;profile-level-id=42e01f",
			RTCPFeedback: nil,
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo)

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
	if track == nil {
		track, err = webrtc.NewTrackLocalStaticRTP(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000},
			"video", "pion",
		)
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
			ch.DataChannel.Store(dc)
			ch.Egress.UpdateDataChannelState(egressPeerID, "connecting")
			dc.OnOpen(func() {
				log.Printf("[Channel %d] DataChannel open", idx)
				ch.DataChannelPeerID.Store(egressPeerID)
				ch.Egress.UpdateDataChannelState(egressPeerID, "open")
			})
			dc.OnClose(func() {
				log.Printf("[Channel %d] DataChannel closed", idx)
				ch.DataChannel.Store(nil)
				ch.DataChannelPeerID.Store(0)
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

	log.Printf("🧠 Listening for RTP on %s:%d", net.IPv4zero, ch.Port)
	buf := make([]byte, 4096)

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
		ch.Stats.RecordRTPPacket(&pkt, n, remoteAddr)

		track := ch.Track.Load()
		if track == nil {
			ch.Stats.RecordDroppedNoTrack()
			continue
		}
		if _, err := track.Write(buf[:n]); err != nil && err != io.ErrClosedPipe {
			ch.Stats.RecordWriteError(err)
			log.Println("❌ Write error:", err)
			continue
		}
		ch.Stats.RecordForwarded(n)
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

	for {
		n, remoteAddr, err := conn.ReadFrom(buf)
		if err != nil {
			log.Println("Metadata read error:", err)
			continue
		}

		// Trim trailing 0s (null bytes) from fixed-size padded messages
		trimmed := bytes.TrimRight(buf[:n], "\x00")
		ch.Stats.RecordMetadataMessage(len(trimmed), remoteAddr, trimmed)

		dc := ch.DataChannel.Load()
		if dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
			jsonStr := string(trimmed)
			if err := dc.SendText(jsonStr); err != nil {
				ch.Stats.RecordMetadataSendError(err)
				ch.Egress.RecordMetadataSendError(ch.DataChannelPeerID.Load(), err)
				log.Println("❌ Failed to send metadata via DataChannel:", err)
			} else {
				ch.Stats.RecordMetadataForwarded(len(trimmed))
				ch.Egress.RecordMetadataSent(ch.DataChannelPeerID.Load(), len(trimmed))
			}
		} else {
			ch.Stats.RecordMetadataDroppedNoDataChannel()
			ch.Egress.RecordMetadataDroppedNoDataChannel()
		}
	}
}
