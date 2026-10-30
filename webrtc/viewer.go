// viewer.go
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type Channel struct {
	Port          int
	Media         atomic.Pointer[channelMedia]
	MetadataPeers metadataPeerRegistry
	FramePeers    metadataPeerRegistry
	MetadataSync  *metadataTimestampCorrelator
	MetadataReady *metadataForwardQueue
	Stats         *IngestStats
	Egress        *EgressStats
}

var channels [80]*Channel

type videoCodec uint32

type channelMedia struct {
	codec      videoCodec
	parameters webrtc.RTPCodecParameters
	track      *trackedRTPTrack
	peers      mediaPeerRegistry
}

type mediaPeerRegistry struct {
	mu      sync.Mutex
	retired bool
	peers   map[*webrtc.PeerConnection]struct{}
}

func (r *mediaPeerRegistry) add(peer *webrtc.PeerConnection) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.retired {
		return false
	}
	if r.peers == nil {
		r.peers = map[*webrtc.PeerConnection]struct{}{}
	}
	r.peers[peer] = struct{}{}
	return true
}

func (r *mediaPeerRegistry) remove(peer *webrtc.PeerConnection) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.peers, peer)
}

func (r *mediaPeerRegistry) isRetired() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.retired
}

func (r *mediaPeerRegistry) retire() {
	r.mu.Lock()
	if r.retired {
		r.mu.Unlock()
		return
	}
	r.retired = true
	peers := make([]*webrtc.PeerConnection, 0, len(r.peers))
	for peer := range r.peers {
		peers = append(peers, peer)
	}
	clear(r.peers)
	r.mu.Unlock()

	// The retired flag is set synchronously above, so a concurrent offer is
	// rejected the moment the generation is replaced. Closing is not: it blocks
	// on DTLS and ICE teardown per peer, and retire() runs on the channel's RTP
	// read loop.
	go func() {
		for _, peer := range peers {
			_ = peer.Close()
		}
	}()
}

// trackedRTPTrack counts live Pion bindings so ingest diagnostics can answer
// "is a viewer actually receiving this channel" without a second counter that
// could drift from Pion's own state. Both fields are atomic rather than mutex
// guarded: Bind and Unbind run on Pion's negotiation goroutines, forward() runs
// on the channel's RTP read loop, and handleIngestStats reads bindingCount on
// HTTP goroutines. Nothing here needs those to be mutually exclusive — a read
// that straddles a bind only misattributes one access unit's counters.
type trackedRTPTrack struct {
	*webrtc.TrackLocalStaticRTP
	bindingCount atomic.Int64
	// idleEpoch advances each time the last viewer leaves. forward() re-arms the
	// H.265 random-access gate when it changes, so a viewer attaching to an idle
	// channel starts at an IRAP instead of mid-GOP. The zero-binding branch in
	// forward() re-arms on every completed access unit, but only while access
	// units are completing; this covers an unbind/rebind that spans one.
	idleEpoch atomic.Uint64
}

func (t *trackedRTPTrack) Bind(context webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	parameters, err := t.TrackLocalStaticRTP.Bind(context)
	if err == nil {
		t.bindingCount.Add(1)
	}
	return parameters, err
}

func (t *trackedRTPTrack) Unbind(context webrtc.TrackLocalContext) error {
	// Pion reports ErrUnbindFailed for a context it no longer holds, which is how
	// a double close arrives here. Returning early keeps the count paired with
	// the bindings Pion actually released.
	if err := t.TrackLocalStaticRTP.Unbind(context); err != nil {
		return err
	}
	if t.bindingCount.Add(-1) == 0 {
		t.idleEpoch.Add(1)
	}
	return nil
}

const (
	videoCodecUnknown videoCodec = iota
	videoCodecH264
	videoCodecH265
	videoCodecJPEG
)

const (
	jpegRTPPayloadType = 26
	h264RTPPayloadType = 96
	h265RTPPayloadType = 98
)

func videoCodecForPayloadType(payloadType uint8) videoCodec {
	switch payloadType {
	case h264RTPPayloadType:
		return videoCodecH264
	case h265RTPPayloadType:
		return videoCodecH265
	case jpegRTPPayloadType:
		return videoCodecJPEG
	default:
		return videoCodecUnknown
	}
}

func newChannelMedia(codec videoCodec) (*channelMedia, error) {
	parameters := webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{ClockRate: videoRTPClockRate},
	}
	switch codec {
	case videoCodecH264:
		parameters.MimeType = webrtc.MimeTypeH264
		parameters.SDPFmtpLine = "packetization-mode=1;profile-level-id=42e01f"
		parameters.PayloadType = h264RTPPayloadType
	case videoCodecH265:
		parameters.MimeType = webrtc.MimeTypeH265
		parameters.PayloadType = h265RTPPayloadType
	case videoCodecJPEG:
		// Browsers have no RTP/JPEG decoder, so JPEG has no track: whole frames
		// go to the viewer over its "jpeg" DataChannel instead.
		parameters.MimeType = "video/jpeg"
		parameters.PayloadType = jpegRTPPayloadType
		return &channelMedia{codec: codec, parameters: parameters}, nil
	default:
		return nil, fmt.Errorf("unsupported video codec %d", codec)
	}

	track, err := webrtc.NewTrackLocalStaticRTP(parameters.RTPCodecCapability, "video", "pion")
	if err != nil {
		return nil, err
	}
	return &channelMedia{
		codec:      codec,
		parameters: parameters,
		track:      &trackedRTPTrack{TrackLocalStaticRTP: track},
	}, nil
}

func (ch *Channel) publishMediaForCodec(codec videoCodec) (*channelMedia, error) {
	previous := ch.Media.Load()
	if previous != nil && previous.codec == codec {
		return previous, nil
	}
	media, err := newChannelMedia(codec)
	if err != nil {
		return nil, err
	}
	ch.Media.Store(media)
	if previous != nil {
		previous.peers.retire()
	}
	return media, nil
}

const (
	neatPortMapPath              = "/home/docker/.insight-config/neat-port-map.json"
	browserICEAddressEnv         = "NEAT_INSIGHT_BROWSER_ICE_ADDRESS"
	defaultEphemeralUDPPortStart = uint16(40000)
	defaultEphemeralUDPPortEnd   = uint16(40200)
	minValidEphemeralUDPPort     = 1
	maxValidEphemeralUDPPort     = 65535
	initialRTPTimestamp          = uint32(1110000000)
	// Larger deltas are treated as sender discontinuities so one bad source
	// cannot move the browser's presentation clock several seconds at once.
	maxSourceRTPTimestampStep    = int32(5 * videoRTPClockRate)
	rtpReceiveBufferBytes        = 2 * 1024 * 1024
	metadataCorrelationCapacity  = 256
	metadataForwardQueueCapacity = 16
	// Retention only binds while a side's arrivals fit in the capacity above. At
	// the ~100 messages per second measured on a DevKit, 256 slots hold ~2.5 s, so
	// a sustained correlation failure reports evictions before it reports expiries.
	metadataCorrelationRetention = 5 * time.Second
)

func configuredBrowserICEAddress() (string, string) {
	if value, present := os.LookupEnv(browserICEAddressEnv); present {
		return strings.TrimSpace(value), browserICEAddressEnv
	}
	return strings.TrimSpace(os.Getenv("CONTAINER_HOST_IP")), "CONTAINER_HOST_IP"
}

type neatPortMapConfig struct {
	WebRTC *udpPortRangeConfig `json:"webRTC"`
}

type udpPortRangeConfig struct {
	ContainerStart int `json:"containerStart"`
	ContainerEnd   int `json:"containerEnd"`
}

type rtpTimestampRewriter struct {
	nextTimestamp uint32
	// Highest timestamp sent. After a discontinuity fallback re-anchors the
	// source mapping, holdingMax keeps backward deltas (B-frames measured from
	// the new anchor) from landing on or behind frames already sent.
	maxTimestamp        uint32
	holdingMax          bool
	lastSourceTimestamp uint32
	lastSourceSSRC      uint32
	lastFrameAt         time.Time
	haveFrame           bool
}

type rtpPacketRewriter struct {
	nextSequence uint16
	haveSequence bool
}

type rtpForwarder struct {
	accessUnitBuffer  *rtpAccessUnitBuffer
	media             *channelMedia
	idleEpoch         uint64
	timestampRewriter rtpTimestampRewriter
	packetRewriter    rtpPacketRewriter
}

type rtpAccessUnit struct {
	packets   [][]byte
	ssrc      uint32
	timestamp uint32
	// Set when the source's sequence broke since the previous accepted unit.
	// Loss and a same-SSRC restart look alike here, and only a restart can
	// rewind the source clock, so the source timestamp delta is not trusted.
	afterSequenceBreak bool
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
	sequenceBreak              bool
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

	startsAccessUnit, randomAccess := rtpPacketState(pkt)
	// An SSRC change is a new sender, not loss from the current one. It carries
	// no sequence baseline to compare against, and any unfinished access unit it
	// interrupts belonged to the previous source.
	sameSource := b.haveSequence && pkt.SSRC == b.sequenceSSRC
	sequenceDiscontinuity := sameSource && pkt.SequenceNumber != b.nextSequence
	b.sequenceBreak = b.sequenceBreak || sequenceDiscontinuity
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
		b.discontinuity = (b.active && sameSource) || sequenceDiscontinuity
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
	// A sequence gap is the only evidence that an access unit lost its opening
	// packets: RTP marks the end of an access unit, never the start, so a unit
	// whose first packet is gone still presents a payload that legitimately
	// begins a NAL. Withholding it also keeps a damaged random-access unit from
	// clearing the recovery gate below, since a partial IRAP would seed every
	// frame in the group from a corrupt reference.
	if !complete || discontinuity {
		return rtpAccessUnit{}, false
	}
	if randomAccess {
		b.waitingForH265RandomAccess = false
	}
	if accessUnitCodec == videoCodecH265 && b.waitingForH265RandomAccess {
		return rtpAccessUnit{}, false
	}
	accessUnit.afterSequenceBreak = b.sequenceBreak
	b.sequenceBreak = false
	return accessUnit, true
}

// Reports whether pkt opens an access unit, and whether that unit is a random
// access point. Every codec needs the start flag: an access unit whose opening
// fragment was lost must not be forwarded, because rtpPacketRewriter renumbers
// the outgoing sequence space and would leave the browser unable to see the gap,
// and a JPEG frame cannot be rebuilt without its first fragment's tables.
// Random access is reported for H.265 alone, being consumed only by the recovery
// gate in accept, which withholds delta units until an IRAP restores the stream.
func rtpPacketState(pkt *rtp.Packet) (startsAccessUnit bool, randomAccess bool) {
	switch videoCodecForPayloadType(pkt.PayloadType) {
	case videoCodecH265:
		observations := parseH265NALObservations(pkt.Payload)
		startsAccessUnit = len(observations) > 0 && observations[0].Start
		for _, observation := range observations {
			if observation.Start && observation.Type >= 16 && observation.Type <= 23 {
				return startsAccessUnit, true
			}
		}
		return startsAccessUnit, false
	case videoCodecH264:
		observations := parseH264NALObservations(pkt.Payload)
		return len(observations) > 0 && observations[0].Start, false
	case videoCodecJPEG:
		return len(pkt.Payload) >= 8 && pkt.Payload[1]|pkt.Payload[2]|pkt.Payload[3] == 0, false
	default:
		return true, false
	}
}

func newRTPForwarder() *rtpForwarder {
	return &rtpForwarder{
		accessUnitBuffer:  newRTPAccessUnitBuffer(),
		timestampRewriter: newRTPTimestampRewriter(),
	}
}

// hasViewers reports whether any viewer can take media's frames: a bound track,
// or for JPEG an open "jpeg" DataChannel.
func (ch *Channel) hasViewers(media *channelMedia) bool {
	if media.track == nil {
		return ch.FramePeers.len() > 0
	}
	return media.track.bindingCount.Load() > 0
}

func (f *rtpForwarder) forward(ch *Channel, media *channelMedia, pkt *rtp.Packet, raw []byte, remoteAddr net.Addr) {
	var idleEpoch uint64
	if media.track != nil {
		idleEpoch = media.track.idleEpoch.Load()
	}
	if media != f.media {
		f.accessUnitBuffer = newRTPAccessUnitBuffer()
		f.media = media
		f.idleEpoch = idleEpoch
	} else if idleEpoch != f.idleEpoch {
		f.accessUnitBuffer.resetH265Recovery()
		f.idleEpoch = idleEpoch
	}

	accessUnit, ready := f.accessUnitBuffer.accept(pkt, raw)
	// Counted per packet rather than per completed access unit: while no viewer
	// is bound the H.265 recovery gate withholds every access unit between
	// random-access points, and those never reach a completion the loop below
	// could count. Accounting only for completed units undercounts the
	// discarded traffic by most of the stream.
	if !ch.hasViewers(media) {
		ch.Stats.RecordDroppedNoTrack()
		if ready {
			f.accessUnitBuffer.resetH265Recovery()
		}
		return
	}
	if !ready {
		// For JPEG, a marker that completes no frame means accept() discarded it.
		if media.codec == videoCodecJPEG && pkt.Marker {
			ch.Stats.RecordJPEGFrameIncomplete(errors.New("frame lost a fragment"))
		}
		return
	}

	var jpegFrame []byte
	if media.codec == videoCodecJPEG {
		var err error
		if jpegFrame, err = assembleJPEG(accessUnit.packets); err != nil {
			ch.Stats.RecordJPEGFrameIncomplete(err)
			return
		}
	}
	frameAt := time.Now()
	frameTimestamp := f.timestampRewriter.timestampForSourceFrame(
		accessUnit.timestamp, accessUnit.ssrc, accessUnit.afterSequenceBreak, frameAt,
	)
	frameForwarded := false
	if jpegFrame != nil {
		frameForwarded = sendJPEGFrame(ch, frameTimestamp, jpegFrame)
		if frameForwarded {
			ch.Stats.RecordJPEGFrameForwarded(len(accessUnit.packets), len(jpegFrame))
		}
	} else {
		for _, rawPacket := range accessUnit.packets {
			packetToWrite, err := f.packetRewriter.rewrite(rawPacket, frameTimestamp)
			if err != nil {
				ch.Stats.RecordMalformedPacket(len(rawPacket), remoteAddr, err)
				log.Println("❌ RTP packet rewrite error:", err)
				continue
			}
			if _, err := media.track.Write(packetToWrite); err != nil && err != io.ErrClosedPipe {
				ch.Stats.RecordWriteError(err)
				log.Println("❌ Write error:", err)
				continue
			}
			ch.Stats.RecordForwarded(len(packetToWrite))
			frameForwarded = true
		}
	}
	if frameForwarded {
		for _, metadata := range ch.MetadataSync.addVideoFrame(
			accessUnit.ssrc, accessUnit.timestamp, frameTimestamp, frameAt,
		) {
			enqueueMetadata(ch, metadata)
		}
	}
}

func main() {
	certPath := flag.String("cert", "", "Path to TLS certificate (PEM)")
	keyPath := flag.String("key", "", "Path to TLS private key (PEM)")
	flag.Parse()

	for i := 0; i < 80; i++ {
		channels[i] = &Channel{
			Port:          9000 + i,
			MetadataSync:  newMetadataTimestampCorrelator(metadataCorrelationCapacity, metadataCorrelationRetention),
			MetadataReady: newMetadataForwardQueue(metadataForwardQueueCapacity),
			Stats:         NewIngestStats(i, 9000+i, 9100+i),
			Egress:        NewEgressStats(i),
		}
		go startUDPListener(channels[i])
		go startMetadataListener(channels[i], 9100+i)
		go startMetadataForwarder(channels[i])
	}

	http.Handle("/", viewerPageHandler())
	http.HandleFunc("/offer", handleOffer)
	http.HandleFunc("/ingest/stats", handleIngestStats)
	http.HandleFunc("/egress/stats", handleEgressStats)
	http.HandleFunc("/reverse", serveReverse)
	http.HandleFunc("/reverse-offer", handleReverseOffer)
	http.Handle("/static/", staticFileHandler(http.Dir("static")))

	addr := ":8081"

	if *certPath != "" && *keyPath != "" {
		log.Printf("✅ Serving HTTPS on %s using cert: %s", addr, *certPath)
		log.Fatal(http.ListenAndServeTLS(addr, *certPath, *keyPath, nil))
	} else {
		log.Printf("⚠️ No TLS cert/key provided, serving plain HTTP on %s", addr)
		log.Fatal(http.ListenAndServe(addr, nil))
	}
}

// revalidate adds Cache-Control: no-cache to what next serves. Without it, browsers
// keep the viewer page and its scripts by heuristic freshness and can pair a new file
// with an old one; no-cache makes them revalidate each time (a 304 when nothing
// changed). Status codes, content and conditional requests stay with next.
func revalidate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

// staticFileHandler serves /static/ from root, revalidated.
func staticFileHandler(root http.FileSystem) http.Handler {
	return revalidate(http.StripPrefix("/static/", http.FileServer(root)))
}

// viewerPageHandler serves the viewer page, revalidated like its scripts.
func viewerPageHandler() http.Handler {
	return revalidate(http.HandlerFunc(serveViewer))
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

// offerAdvertisesCodec reports whether the browser offered the encoding this
// channel carries. A malformed offer is treated as advertising it, so the
// existing SDP error path stays responsible for reporting that.
func offerAdvertisesCodec(offer webrtc.SessionDescription, mimeType string) bool {
	parsed, err := offer.Unmarshal()
	if err != nil {
		return true
	}
	// RTP encoding names are case-insensitive, and the trailing slash keeps
	// "H264/90000" from satisfying a search for H265.
	wanted := strings.ToUpper(strings.TrimPrefix(mimeType, "video/")) + "/"
	for _, media := range parsed.MediaDescriptions {
		if media.MediaName.Media != "video" {
			continue
		}
		for _, attribute := range media.Attributes {
			if attribute.Key != "rtpmap" {
				continue
			}
			if strings.Contains(strings.ToUpper(attribute.Value), wanted) {
				return true
			}
		}
	}
	return false
}

// offerHasDataChannels reports whether the offer can carry the "jpeg"
// DataChannel. A malformed offer is treated as able to, like the codec check.
func offerHasDataChannels(offer webrtc.SessionDescription) bool {
	parsed, err := offer.Unmarshal()
	if err != nil {
		return true
	}
	for _, media := range parsed.MediaDescriptions {
		if media.MediaName.Media == "application" {
			return true
		}
	}
	return false
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
	media := ch.Media.Load()
	if media == nil {
		http.Error(w, "Video codec not available", http.StatusServiceUnavailable)
		return
	}
	parameters := media.parameters
	// A JPEG channel has no track, so it needs no browser decoder: frames travel
	// over the "jpeg" DataChannel.
	jpeg := media.track == nil
	// Rejected before anything is allocated. A browser with no decoder for this
	// channel's codec can never negotiate, so the answer must say so with a
	// status the viewer treats as permanent. Letting Pion fail instead would
	// return 500, which the viewer retries, and every attempt would register
	// peer records for a connection that cannot succeed.
	if !jpeg && !offerAdvertisesCodec(offer, parameters.MimeType) {
		http.Error(w, "Browser does not support the channel codec", http.StatusUnsupportedMediaType)
		return
	}
	// A video-only offer, such as the ROI editor preview's, cannot receive JPEG
	// frames and would otherwise connect and wait forever.
	if jpeg && !offerHasDataChannels(offer) {
		http.Error(w, "JPEG channels can be viewed only in the Video Viewer", http.StatusUnsupportedMediaType)
		return
	}

	m := webrtc.MediaEngine{}
	if !jpeg {
		m.RegisterCodec(parameters, webrtc.RTPCodecTypeVideo)
	} else {
		// Codecs every browser offers, only so the video m-line is answered
		// inactive rather than rejected: Pion writes the answer's ICE candidates
		// into the first m-line, and a browser ignores them on a rejected one.
		for i, mimeType := range []string{webrtc.MimeTypeVP8, webrtc.MimeTypeH264} {
			m.RegisterCodec(webrtc.RTPCodecParameters{
				RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: mimeType, ClockRate: videoRTPClockRate},
				PayloadType:        webrtc.PayloadType(96 + i),
			}, webrtc.RTPCodecTypeVideo)
		}
	}

	// === Add NAT and Port Range logic ===
	s := webrtc.SettingEngine{}
	portStart, portEnd := configuredEphemeralUDPPortRange()
	if err := s.SetEphemeralUDPPortRange(portStart, portEnd); err != nil {
		log.Printf("⚠️ Failed to set WebRTC UDP port range %d-%d: %v", portStart, portEnd, err)
		http.Error(w, "PeerConnection failed", http.StatusInternalServerError)
		return
	}

	hostIP, hostIPSource := configuredBrowserICEAddress()

	if ip := net.ParseIP(hostIP); ip != nil && !ip.IsLoopback() && !ip.IsUnspecified() {
		log.Printf("🌐 Using %s override: %s", hostIPSource, hostIP)
		s.SetNAT1To1IPs([]string{hostIP}, webrtc.ICECandidateTypeHost)
	} else if hostIP != "" {
		log.Printf("⚠️ Ignoring invalid or internal %s: %q", hostIPSource, hostIP)
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(&m), webrtc.WithSettingEngine(s))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		http.Error(w, "PeerConnection failed", http.StatusInternalServerError)
		return
	}
	if !media.peers.add(pc) {
		_ = pc.Close()
		http.Error(w, "Video codec changed", http.StatusServiceUnavailable)
		return
	}
	success := false
	defer func() {
		if !success {
			media.peers.remove(pc)
			_ = pc.Close()
		}
	}()
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
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			media.peers.remove(pc)
		}
		if state == webrtc.PeerConnectionStateFailed {
			_ = pc.Close()
		}
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
	// The response carries a stable message; the cause goes to the log. Callers
	// cannot act on a Pion error, and it is the only record of why a viewer
	// failed to connect.
	respondNegotiationError := func(message string, cause error) {
		if media.peers.isRetired() {
			http.Error(w, "Video codec changed", http.StatusServiceUnavailable)
			return
		}
		log.Printf("[Channel %d] %s: %v", idx, message, cause)
		http.Error(w, message, http.StatusInternalServerError)
	}

	var sender *webrtc.RTPSender
	if !jpeg {
		if sender, err = pc.AddTrack(media.track); err != nil {
			respondNegotiationError("AddTrack failed", err)
			return
		}
	}

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		log.Printf("[Channel %d] Incoming DataChannel: %s", idx, dc.Label())
		switch dc.Label() {
		case "metadata":
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
		case "jpeg":
			// The viewer opens it on every channel; only a JPEG channel uses it.
			if !jpeg {
				return
			}
			ch.Egress.UpdateJPEGState(egressPeerID, "connecting")
			dc.OnOpen(func() {
				ch.FramePeers.add(egressPeerID, dc)
				ch.Egress.UpdateJPEGState(egressPeerID, "open")
			})
			dc.OnClose(func() {
				ch.FramePeers.remove(egressPeerID, dc)
				ch.Egress.UpdateJPEGState(egressPeerID, "closed")
			})
		}
	})
	if err := pc.SetRemoteDescription(offer); err != nil {
		respondNegotiationError("SetRemoteDescription failed", err)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		respondNegotiationError("CreateAnswer failed", err)
		return
	}
	if err = pc.SetLocalDescription(answer); err != nil {
		respondNegotiationError("SetLocalDescription failed", err)
		return
	}
	if sender != nil {
		go readSenderRTCP(sender, ch.Egress, egressPeerID)
		go sendRTCP(pc)
	}
	<-webrtc.GatheringCompletePromise(pc)
	if media.peers.isRetired() {
		http.Error(w, "Video codec changed", http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(pc.LocalDescription()); err != nil {
		log.Printf("Failed to encode SDP answer: %v", err)
		return
	}
	success = true
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
	return r.timestampForSourceFrame(r.lastSourceTimestamp, r.lastSourceSSRC, false, now)
}

func (r *rtpTimestampRewriter) timestampForSourceFrame(
	sourceTimestamp, sourceSSRC uint32, afterSequenceBreak bool, now time.Time,
) uint32 {
	if r.haveFrame {
		// Signed, so B-frames arriving in decode order keep their backward
		// presentation deltas instead of reading as a huge forward jump.
		sourceStep := int32(sourceTimestamp - r.lastSourceTimestamp)
		discontinuity := afterSequenceBreak || sourceSSRC != r.lastSourceSSRC ||
			sourceStep > maxSourceRTPTimestampStep || sourceStep < -maxSourceRTPTimestampStep
		r.holdingMax = r.holdingMax || discontinuity
		next := r.nextTimestamp + uint32(sourceStep)
		if discontinuity || sourceStep == 0 || (r.holdingMax && int32(next-r.maxTimestamp) <= 0) {
			base := r.nextTimestamp
			if r.holdingMax {
				base = r.maxTimestamp
			}
			step := uint32(float64(videoRTPClockRate) * now.Sub(r.lastFrameAt).Seconds())
			if step == 0 {
				step = 1
			}
			next = base + step
		} else {
			r.holdingMax = false
		}
		r.nextTimestamp = next
	}
	if !r.haveFrame || int32(r.nextTimestamp-r.maxTimestamp) > 0 {
		r.maxTimestamp = r.nextTimestamp
	}
	r.lastSourceTimestamp = sourceTimestamp
	r.lastSourceSSRC = sourceSSRC
	r.lastFrameAt = now
	r.haveFrame = true
	return r.nextTimestamp
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
		if pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
			return
		}
		if err := pc.WriteRTCP([]rtcp.Packet{
			&rtcp.PictureLossIndication{MediaSSRC: 1},
		}); err == io.ErrClosedPipe {
			return
		} else if err != nil {
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
		media := ch.Media.Load()
		trackAttached := media != nil && ch.hasViewers(media)
		snapshot := ch.Stats.Snapshot(includeVerbose, trackAttached, now)
		snapshot.Metadata.MetadataCorrelationSnapshot = ch.MetadataSync.pruneAndSnapshot(now)
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
		log.Printf("Failed to set RTP receive buffer on port %d: %v", ch.Port, err)
	}

	log.Printf("🧠 Listening for RTP on %s:%d", net.IPv4zero, ch.Port)
	buf := make([]byte, 4096)
	forwarder := newRTPForwarder()

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
		codec := videoCodecForPayloadType(pkt.PayloadType)
		if codec == videoCodecUnknown {
			continue
		}
		media, err := ch.publishMediaForCodec(codec)
		if err != nil {
			log.Printf("Failed to publish channel media on port %d: %v", ch.Port, err)
			continue
		}
		raw := append([]byte(nil), buf[:n]...)
		forwarder.forward(ch, media, &pkt, raw, remoteAddr)
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
