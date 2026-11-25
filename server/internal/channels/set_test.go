package channels

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// An app and a browser, both in the test: the app sends RTP and metadata to a channel's UDP
// ports, the browser negotiates through Offer and reads what Insight sends it. The connection
// needs a network interface other than loopback, which Pion gathers no candidates on (a CI runner
// has one; a network sandbox may not).

func listen(t *testing.T, count int) *Set {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	s, err := Listen(ctx, Options{Count: count, Address: "127.0.0.1", WebRTCPortStart: 52000, WebRTCPortEnd: 52400})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); s.Wait() })
	return s
}

type app struct {
	t              *testing.T
	video, meta    *net.UDPConn
	sequence       uint16
	ssrc           uint32
	payloadType    uint8
	keyframePacket []byte
}

func newApp(t *testing.T, s *Set, channel int, payloadType uint8, keyframe []byte) *app {
	t.Helper()
	videoPort, metadataPort := s.Ports(channel)
	dial := func(port int) *net.UDPConn {
		conn, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		return conn
	}
	return &app{t: t, video: dial(videoPort), meta: dial(metadataPort), ssrc: 1234, payloadType: payloadType, keyframePacket: keyframe}
}

// newJPEGApp is an app that sends RTP/JPEG, each frame the packets of fixtureI420.
func newJPEGApp(t *testing.T, s *Set, channel int) *app {
	t.Helper()
	return newApp(t, s, channel, payloadTypeJPEG, nil)
}

// frame sends one single-packet keyframe at RTP time timestamp.
func (a *app) frame(timestamp uint32) {
	a.t.Helper()
	a.send(timestamp, true, a.keyframePacket)
}

// jpegFrame sends fixtureI420's packets, one JPEG frame, restamped to RTP time timestamp and the
// app's own sequence numbers.
func (a *app) jpegFrame(timestamp uint32) {
	a.t.Helper()
	for _, raw := range fixtureI420 {
		var packet rtp.Packet
		if err := packet.Unmarshal(raw); err != nil {
			a.t.Fatal(err)
		}
		a.send(timestamp, packet.Marker, packet.Payload)
	}
}

func (a *app) send(timestamp uint32, marker bool, payload []byte) {
	a.t.Helper()
	a.sequence++
	raw, err := (&rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: a.payloadType, SequenceNumber: a.sequence, Timestamp: timestamp, SSRC: a.ssrc, Marker: marker},
		Payload: payload,
	}).Marshal()
	if err != nil {
		a.t.Fatal(err)
	}
	if _, err := a.video.Write(raw); err != nil {
		a.t.Fatal(err)
	}
}

// streamWithDetections sends an H.264 or H.265 frame every 40 ms, each with a detection naming
// it sent after it, as a model would, until the test ends.
func (a *app) streamWithDetections() {
	stop, stopped := make(chan struct{}), make(chan struct{})
	a.t.Cleanup(func() { close(stop); <-stopped })
	go func() {
		defer close(stopped)
		for timestamp := uint32(93_600); ; timestamp += 3600 {
			select {
			case <-stop:
				return
			case <-time.After(40 * time.Millisecond):
			}
			a.frame(timestamp + 37) // a frame's RTP time is not a whole millisecond
			a.detection(timestamp / 90)
		}
	}()
}

func (a *app) detection(timestampMS uint32) {
	a.t.Helper()
	message := fmt.Sprintf(`{"type":"object-detection","timestamp":%d,"data":{"objects":[{"bbox":[1,2,3,4]}]}}`, timestampMS)
	if _, err := a.meta.Write([]byte(message)); err != nil {
		a.t.Fatal(err)
	}
}

type browser struct {
	pc       *webrtc.PeerConnection
	mu       sync.Mutex
	rtpTimes map[uint32]bool
	messages []string
	open     chan struct{} // closed once the metadata channel is open

	// What the jpeg channel brought: the whole frames, the frame being put together, and the
	// unfinished ones dropped for a chunk of another frame.
	frames     []receivedFrame
	collecting *collectingFrame
	dropped    int
}

type receivedFrame struct {
	timestamp uint32
	data      []byte
}

type collectingFrame struct {
	timestamp uint32
	chunks    [][]byte // by index; nil while missing
	missing   int
}

// browserOptions say what a test browser offers.
type browserOptions struct {
	codecs []Codec // the video codecs it decodes
	jpeg   bool    // it opens the jpeg channel beside metadata
	// noDataChannels: it opens neither channel, so its offer has no application m-line.
	noDataChannels bool
}

func newBrowser(t *testing.T, codecs ...Codec) *browser {
	t.Helper()
	return newBrowserWith(t, browserOptions{codecs: codecs})
}

func newBrowserWith(t *testing.T, options browserOptions) *browser {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	for _, codec := range options.codecs {
		parameters, err := codecParameters(codec)
		if err != nil {
			t.Fatal(err)
		}
		if err := engine.RegisterCodec(parameters, webrtc.RTPCodecTypeVideo); err != nil {
			t.Fatal(err)
		}
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	b := &browser{pc: pc, rtpTimes: map[uint32]bool{}, open: make(chan struct{})}
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	if !options.noDataChannels {
		dc, err := pc.CreateDataChannel("metadata", nil)
		if err != nil {
			t.Fatal(err)
		}
		dc.OnOpen(func() { close(b.open) })
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			b.mu.Lock()
			b.messages = append(b.messages, string(msg.Data))
			b.mu.Unlock()
		})
	}
	if options.jpeg && !options.noDataChannels {
		ordered, lifetime := true, uint16(300)
		dc, err := pc.CreateDataChannel("jpeg", &webrtc.DataChannelInit{Ordered: &ordered, MaxPacketLifeTime: &lifetime})
		if err != nil {
			t.Fatal(err)
		}
		dc.OnMessage(func(msg webrtc.DataChannelMessage) { b.jpegChunk(msg.Data) })
	}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			b.mu.Lock()
			b.rtpTimes[packet.Timestamp] = true
			b.mu.Unlock()
		}
	})
	return b
}

// jpegFrameChunks is the most chunks a frame of 16 MiB, the protocol's largest, needs.
const jpegFrameChunks = (16<<20 + jpegChunkBytes - 1) / jpegChunkBytes

// jpegChunk puts a jpeg channel's message into its frame by the receiver's rules
// (docs/contracts.md, "What a viewer's connection carries").
func (b *browser) jpegChunk(msg []byte) {
	if len(msg) <= jpegChunkHeaderBytes {
		return
	}
	timestamp := binary.BigEndian.Uint32(msg[0:])
	index, count := int(binary.BigEndian.Uint16(msg[4:])), int(binary.BigEndian.Uint16(msg[6:]))
	if index >= count || count > jpegFrameChunks {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	frame := b.collecting
	if frame == nil || frame.timestamp != timestamp || len(frame.chunks) != count {
		if frame != nil {
			b.dropped++
		}
		frame = &collectingFrame{timestamp: timestamp, chunks: make([][]byte, count), missing: count}
		b.collecting = frame
	}
	if frame.chunks[index] != nil {
		return // a repeated index
	}
	frame.chunks[index] = bytes.Clone(msg[jpegChunkHeaderBytes:])
	if frame.missing--; frame.missing == 0 {
		b.frames = append(b.frames, receivedFrame{timestamp: timestamp, data: bytes.Join(frame.chunks, nil)})
		b.collecting = nil
	}
}

func (b *browser) waitOpen(t *testing.T) {
	t.Helper()
	select {
	case <-b.open:
	case <-time.After(10 * time.Second):
		t.Fatal("the metadata channel did not open")
	}
}

// matchedMessage is what the tests read of a metadata message: its own timestamp and, once
// Insight matched it to a frame, that frame's RTP time.
type matchedMessage struct {
	Timestamp uint32 `json:"timestamp"`
	Insight   *struct {
		RTPTimestamp uint32 `json:"rtp_timestamp"`
	} `json:"_insight"`
}

// matchedMessages are the metadata messages that arrived matched to a frame.
func (b *browser) matchedMessages() []matchedMessage {
	b.mu.Lock()
	defer b.mu.Unlock()
	var all []matchedMessage
	for _, text := range b.messages {
		var matched matchedMessage
		if json.Unmarshal([]byte(text), &matched) == nil && matched.Insight != nil {
			all = append(all, matched)
		}
	}
	return all
}

// sawADetectionOnAFrame says whether a detection arrived that names a frame the browser received.
func (b *browser) sawADetectionOnAFrame() bool {
	for _, matched := range b.matchedMessages() {
		b.mu.Lock()
		received := b.rtpTimes[matched.Insight.RTPTimestamp]
		b.mu.Unlock()
		if received {
			return true
		}
	}
	return false
}

// matchedFrame is the RTP time of the frame Insight matched the message of timestampMS to, once
// that message came.
func (b *browser) matchedFrame(timestampMS uint32) (uint32, bool) {
	for _, matched := range b.matchedMessages() {
		if matched.Timestamp == timestampMS {
			return matched.Insight.RTPTimestamp, true
		}
	}
	return 0, false
}

// jpegFrames are the whole frames the jpeg channel brought so far, and how many it dropped.
func (b *browser) jpegFrames() ([]receivedFrame, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]receivedFrame(nil), b.frames...), b.dropped
}

// watch has the browser offer to watch channel 0, and takes the answer.
func (b *browser) watch(t *testing.T, s *Set) {
	t.Helper()
	answer, err := s.Offer(context.Background(), 0, b.offer(t))
	if err != nil {
		t.Fatal(err)
	}
	b.accept(t, answer)
}

// closedByInsight says whether the browser's connection ended, as a browser sees Insight close it.
func (b *browser) closedByInsight() bool {
	switch b.pc.ConnectionState() {
	case webrtc.PeerConnectionStateClosed, webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateDisconnected:
		return true
	}
	return false
}

func (b *browser) offer(t *testing.T) Description {
	t.Helper()
	offer, err := b.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(b.pc)
	if err := b.pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	return Description{Type: "offer", SDP: b.pc.LocalDescription().SDP}
}

func (b *browser) accept(t *testing.T, answer Description) {
	t.Helper()
	if err := b.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		t.Fatal(err)
	}
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("not within 10 s: %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// mediaOf waits for channel index's first media generation.
func mediaOf(t *testing.T, s *Set, index int) *media {
	t.Helper()
	waitFor(t, "the channel's media", func() bool { return s.channels[index].media.Load() != nil })
	return s.channels[index].media.Load()
}

func offerErrorCode(err error) string {
	var offerErr *OfferError
	if errors.As(err, &offerErr) {
		return offerErr.Code
	}
	return ""
}

func TestAViewerGetsTheVideoAndTheMetadataMatchedToItsFrames(t *testing.T) {
	s := listen(t, 1)
	sender := newApp(t, s, 0, payloadTypeH264, h264IDR)
	viewer := newBrowser(t, CodecH264)

	if _, err := s.Offer(context.Background(), 0, viewer.offer(t)); offerErrorCode(err) != "no_video" {
		t.Fatalf("before any video: %v", err)
	}
	sender.frame(90_000)
	mediaOf(t, s, 0)

	viewer = newBrowser(t, CodecH264)
	answer, err := s.Offer(context.Background(), 0, viewer.offer(t))
	if err != nil {
		t.Fatal(err)
	}
	viewer.accept(t, answer)
	viewer.waitOpen(t)

	sender.streamWithDetections()
	waitFor(t, "a detection drawn on a frame the browser received", viewer.sawADetectionOnAFrame)

	state := s.States(time.Now())[0]
	if !state.Video.Active || state.Video.Codec != "H264" || state.Viewers != 1 || state.Metadata.Forwarded == 0 || state.Video.Keyframes == 0 {
		t.Fatalf("state %+v", state)
	}
}

func TestABrowserWithoutTheCodecIsRefused(t *testing.T) {
	s := listen(t, 1)
	newApp(t, s, 0, payloadTypeH265, h265IRAP).frame(90_000)
	mediaOf(t, s, 0)
	if _, err := s.Offer(context.Background(), 0, newBrowser(t, CodecH264).offer(t)); offerErrorCode(err) != "codec_unsupported" {
		t.Fatalf("err %v", err)
	}
}

func TestACodecChangeClosesTheViewersOfTheOldOne(t *testing.T) {
	s := listen(t, 1)
	sender := newApp(t, s, 0, payloadTypeH264, h264IDR)
	sender.frame(90_000)
	mediaOf(t, s, 0)
	viewer := newBrowser(t, CodecH264, CodecH265)
	answer, err := s.Offer(context.Background(), 0, viewer.offer(t))
	if err != nil {
		t.Fatal(err)
	}
	viewer.accept(t, answer)
	waitFor(t, "connected", func() bool { return viewer.pc.ConnectionState() == webrtc.PeerConnectionStateConnected })

	sender.payloadType, sender.keyframePacket = payloadTypeH265, h265IRAP
	sender.frame(93_600)
	waitFor(t, "the old viewer closed", viewer.closedByInsight)
	if got := s.channels[0].media.Load().codec; got != CodecH265 {
		t.Fatalf("codec %v", got)
	}
}

func TestACodecChangeRetiresTheJPEGViewers(t *testing.T) {
	s := listen(t, 1)
	sender := newApp(t, s, 0, payloadTypeH264, h264IDR)
	sender.frame(90_000)
	h264Media := mediaOf(t, s, 0)
	early := newBrowserWith(t, browserOptions{codecs: []Codec{CodecH264}, jpeg: true})
	early.watch(t, s)
	waitFor(t, "connected", func() bool { return early.pc.ConnectionState() == webrtc.PeerConnectionStateConnected })

	// H.264 to JPEG: the H.264 viewer is closed, and its jpeg channel, which the H.264
	// generation ignored, joins no other.
	sender.payloadType = payloadTypeJPEG
	sender.jpegFrame(93_600)
	waitFor(t, "the H.264 viewer closed", early.closedByInsight)
	jpegMedia := s.channels[0].media.Load()
	if jpegMedia.codec != CodecJPEG || !h264Media.isRetired() {
		t.Fatalf("codec %v, the H.264 generation retired %v", jpegMedia.codec, h264Media.isRetired())
	}
	late := newBrowserWith(t, browserOptions{codecs: []Codec{CodecH264}, jpeg: true})
	late.watch(t, s)
	waitFor(t, "the JPEG viewer's jpeg channel open", func() bool { return jpegMedia.frameViewers.count() == 1 })
	timestamp := uint32(97_200)
	for range 3 {
		sender.jpegFrame(timestamp)
		timestamp += 3600
	}
	waitFor(t, "three JPEG frames", func() bool { frames, _ := late.jpegFrames(); return len(frames) == 3 })

	// And back: the JPEG viewer is closed, its jpeg channel leaves the old generation, and
	// nothing more reaches it.
	sender.payloadType = payloadTypeH264
	sender.frame(timestamp)
	waitFor(t, "the JPEG viewer closed", late.closedByInsight)
	waitFor(t, "the old generation's jpeg channel gone", func() bool { return jpegMedia.frameViewers.count() == 0 })
	if m := s.channels[0].media.Load(); m.codec != CodecH264 || !jpegMedia.isRetired() || m.frameViewers.count() != 0 {
		t.Fatalf("codec %v, the JPEG generation retired %v, %d jpeg channels on H.264", m.codec, jpegMedia.isRetired(), m.frameViewers.count())
	}
	for range 3 {
		timestamp += 3600
		sender.frame(timestamp)
	}
	time.Sleep(300 * time.Millisecond)
	if frames, _ := late.jpegFrames(); len(frames) != 3 {
		t.Fatalf("the JPEG viewer got %d frames, want its generation's 3", len(frames))
	}
	if frames, _ := early.jpegFrames(); len(frames) != 0 {
		t.Fatalf("the H.264 viewer got %d JPEG frames", len(frames))
	}
}

func TestJPEGFramesAndTheirMetadataShareTimestamps(t *testing.T) {
	s := listen(t, 1)
	sender := newJPEGApp(t, s, 0)
	sender.jpegFrame(45_000) // starts the JPEG generation; nobody watches it yet
	m := mediaOf(t, s, 0)
	viewer := newBrowserWith(t, browserOptions{codecs: []Codec{CodecH264}, jpeg: true})
	viewer.watch(t, s)
	waitFor(t, "the metadata and jpeg channels open", func() bool {
		return s.channels[0].views.count() == 1 && m.frameViewers.count() == 1
	})

	stamps := []uint32{1000, 1033, 1066, 1100} // ms
	for i, stamp := range stamps {
		// Either side may arrive first; both are matched.
		if i%2 == 0 {
			sender.detection(stamp)
		}
		sender.jpegFrame(stamp * 90)
		if i%2 == 1 {
			sender.detection(stamp)
		}
		waitFor(t, fmt.Sprintf("frame %d and its metadata", i), func() bool {
			frames, _ := viewer.jpegFrames()
			_, matched := viewer.matchedFrame(stamp)
			return len(frames) > i && matched
		})
	}

	frames, dropped := viewer.jpegFrames()
	if len(frames) != len(stamps) || dropped != 0 {
		t.Fatalf("%d frames whole and %d dropped, want %d and none", len(frames), dropped, len(stamps))
	}
	for i, frame := range frames {
		picture, err := jpeg.Decode(bytes.NewReader(frame.data))
		if err != nil {
			t.Fatalf("frame %d does not decode: %v", i, err)
		}
		if size := picture.Bounds().Size(); size.X != 64 || size.Y != 48 {
			t.Fatalf("frame %d is %v, want 64 × 48", i, size)
		}
		if matched, _ := viewer.matchedFrame(stamps[i]); matched != frame.timestamp {
			t.Fatalf("frame %d: its metadata names RTP time %d, the frame carries %d", i, matched, frame.timestamp)
		}
	}
}

func TestAFullChannelRefusesTheNextViewerUntilOneLeaves(t *testing.T) {
	s := listen(t, 1)
	newApp(t, s, 0, payloadTypeH264, h264IDR).frame(90_000)
	checkTheViewerLimit(t, s, mediaOf(t, s, 0), browserOptions{codecs: []Codec{CodecH264}})
}

func TestTheNinthJPEGViewerIsRefused(t *testing.T) {
	s := listen(t, 1)
	newJPEGApp(t, s, 0).jpegFrame(90_000)
	checkTheViewerLimit(t, s, mediaOf(t, s, 0), browserOptions{codecs: []Codec{CodecH264}, jpeg: true})
}

// checkTheViewerLimit has browsers offer until channel 0 is full, then checks that the next one
// is refused as too_many_viewers and that one leaving makes room.
func checkTheViewerLimit(t *testing.T, s *Set, m *media, options browserOptions) {
	t.Helper()
	for i := range maxViewers {
		if _, err := s.Offer(context.Background(), 0, newBrowserWith(t, options).offer(t)); err != nil {
			t.Fatalf("viewer %d: %v", i+1, err)
		}
	}
	_, err := s.Offer(context.Background(), 0, newBrowserWith(t, options).offer(t))
	if refusal := AsOfferError(err); refusal.Code != "too_many_viewers" || refusal.Status != 503 {
		t.Fatalf("one viewer over the cap: %v", err)
	}

	m.mu.Lock()
	var first *webrtc.PeerConnection
	for peer := range m.peers {
		first = peer
		break
	}
	m.mu.Unlock()
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "a place free", func() bool { return m.viewers() < maxViewers })
	if _, err := s.Offer(context.Background(), 0, newBrowserWith(t, options).offer(t)); err != nil {
		t.Fatalf("after one left: %v", err)
	}
}

func TestAJPEGOfferIsAnsweredWithAnInactiveVideoLine(t *testing.T) {
	s := listen(t, 1)
	newJPEGApp(t, s, 0).jpegFrame(90_000)
	m := mediaOf(t, s, 0)
	viewer := newBrowserWith(t, browserOptions{codecs: []Codec{CodecH264}, jpeg: true})
	answer, err := s.Offer(context.Background(), 0, viewer.offer(t))
	if err != nil {
		t.Fatal(err)
	}

	var parsed sdp.SessionDescription
	if err := parsed.Unmarshal([]byte(answer.SDP)); err != nil {
		t.Fatal(err)
	}
	var video *sdp.MediaDescription
	for _, description := range parsed.MediaDescriptions {
		if description.MediaName.Media == "video" {
			video = description
		}
	}
	if video == nil {
		t.Fatalf("no video m-line in the answer:\n%s", answer.SDP)
	}
	if _, inactive := video.Attribute("inactive"); !inactive || video.MediaName.Port.Value == 0 {
		t.Fatalf("the video m-line is not answered inactive, or is rejected:\n%s", answer.SDP)
	}
	if _, candidates := video.Attribute("candidate"); !candidates {
		t.Fatalf("the video m-line carries no ICE candidates:\n%s", answer.SDP)
	}

	viewer.accept(t, answer)
	waitFor(t, "connected", func() bool { return viewer.pc.ConnectionState() == webrtc.PeerConnectionStateConnected })
	waitFor(t, "the jpeg channel registered", func() bool { return m.frameViewers.count() == 1 })
	if !m.watched() {
		t.Fatal("a generation with an open jpeg channel is not watched")
	}
	if err := viewer.pc.Close(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the jpeg channel gone", func() bool { return m.frameViewers.count() == 0 })
}

func TestAJPEGOfferWithoutADataChannelIsRefused(t *testing.T) {
	s := listen(t, 1)
	newJPEGApp(t, s, 0).jpegFrame(90_000)
	m := mediaOf(t, s, 0)
	viewer := newBrowserWith(t, browserOptions{codecs: []Codec{CodecH264}, noDataChannels: true})
	_, err := s.Offer(context.Background(), 0, viewer.offer(t))
	if refusal := AsOfferError(err); refusal.Code != "jpeg_needs_data_channel" || refusal.Status != 415 {
		t.Fatalf("an offer without data channels: %v", err)
	}
	if n := m.viewers(); n != 0 {
		t.Fatalf("%d viewers after a refused offer", n)
	}
}

func TestAnH264ChannelIgnoresTheJPEGChannel(t *testing.T) {
	s := listen(t, 1)
	sender := newApp(t, s, 0, payloadTypeH264, h264IDR)
	sender.frame(90_000)
	m := mediaOf(t, s, 0)
	viewer := newBrowserWith(t, browserOptions{codecs: []Codec{CodecH264}, jpeg: true})
	answer, err := s.Offer(context.Background(), 0, viewer.offer(t))
	if err != nil {
		t.Fatal(err)
	}
	viewer.accept(t, answer)
	viewer.waitOpen(t)

	sender.streamWithDetections()
	waitFor(t, "a detection drawn on a frame the browser received", viewer.sawADetectionOnAFrame)
	if n := m.frameViewers.count(); n != 0 {
		t.Fatalf("%d jpeg channels registered on an H.264 channel", n)
	}
}

func TestAJPEGViewerWithoutAJPEGChannelCountsAndGetsNoFrames(t *testing.T) {
	s := listen(t, 1)
	sender := newJPEGApp(t, s, 0)
	sender.jpegFrame(90_000)
	m := mediaOf(t, s, 0)
	viewer := newBrowserWith(t, browserOptions{codecs: []Codec{CodecH264}}) // metadata only
	answer, err := s.Offer(context.Background(), 0, viewer.offer(t))
	if err != nil {
		t.Fatal(err)
	}
	viewer.accept(t, answer)
	viewer.waitOpen(t)

	// Ten more frames, all taken in by the channel, then time for anything sent to arrive.
	const frames = 11
	for i := uint32(1); i < frames; i++ {
		time.Sleep(40 * time.Millisecond)
		sender.jpegFrame(90_000 + i*3600)
	}
	packets := uint64(frames * len(fixtureI420))
	waitFor(t, "every frame taken in", func() bool { return s.States(time.Now())[0].Video.Packets == packets })
	time.Sleep(300 * time.Millisecond)

	if state := s.States(time.Now())[0]; state.Viewers != 1 || state.Video.Codec != "JPEG" {
		t.Fatalf("state %+v", state)
	}
	if m.watched() || m.frameViewers.count() != 0 {
		t.Fatalf("watched %v with %d jpeg channels, by a viewer that opened none", m.watched(), m.frameViewers.count())
	}
	viewer.mu.Lock()
	defer viewer.mu.Unlock()
	if len(viewer.frames) != 0 || len(viewer.messages) != 0 {
		t.Fatalf("a viewer without a jpeg channel got %d frames and %d messages", len(viewer.frames), len(viewer.messages))
	}
}

func TestAnOfferForAChannelThatIsNotThere(t *testing.T) {
	s := listen(t, 2)
	for _, index := range []int{-1, 2} {
		if _, err := s.Offer(context.Background(), index, Description{Type: "offer", SDP: "v=0"}); offerErrorCode(err) != "no_such_channel" {
			t.Fatalf("channel %d: %v", index, err)
		}
	}
	if _, err := s.Offer(context.Background(), 0, Description{Type: "answer", SDP: "v=0"}); offerErrorCode(err) != "invalid_offer" {
		t.Fatalf("an answer: %v", err)
	}
}

func TestMetadataWithoutAViewerIsCountedNotKept(t *testing.T) {
	s := listen(t, 1)
	sender := newApp(t, s, 0, payloadTypeH264, h264IDR)
	sender.detection(1000)
	if _, err := sender.meta.Write([]byte("not json")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "two messages counted", func() bool { return s.States(time.Now())[0].Metadata.Received == 2 })
	state := s.States(time.Now())[0].Metadata
	if state.Invalid != 1 || state.Forwarded != 0 || !state.Active {
		t.Fatalf("%+v", state)
	}
	corr := &s.channels[0].corr
	corr.mu.Lock()
	defer corr.mu.Unlock()
	if len(corr.pending) != 0 {
		t.Fatalf("%d messages wait for a frame no browser watches", len(corr.pending))
	}
}

func TestListenFailsWhenAPortIsTaken(t *testing.T) {
	taken, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer taken.Close()
	port := taken.LocalAddr().(*net.UDPAddr).Port
	_, err = Listen(context.Background(), Options{Count: 1, VideoBase: port, MetadataBase: port + 1000, Address: "127.0.0.1",
		WebRTCPortStart: 52000, WebRTCPortEnd: 52400})
	if err == nil {
		t.Fatal("no error")
	}
}
