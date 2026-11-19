package channels

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
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

// frame sends one single-packet keyframe at RTP time timestamp.
func (a *app) frame(timestamp uint32) {
	a.t.Helper()
	a.sequence++
	raw, err := (&rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: a.payloadType, SequenceNumber: a.sequence, Timestamp: timestamp, SSRC: a.ssrc, Marker: true},
		Payload: a.keyframePacket,
	}).Marshal()
	if err != nil {
		a.t.Fatal(err)
	}
	if _, err := a.video.Write(raw); err != nil {
		a.t.Fatal(err)
	}
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
	open     chan struct{}
}

func newBrowser(t *testing.T, codecs ...Codec) *browser {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	for _, codec := range codecs {
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
	waitFor(t, "the channel's media", func() bool { return s.channels[0].media.Load() != nil })

	viewer = newBrowser(t, CodecH264)
	answer, err := s.Offer(context.Background(), 0, viewer.offer(t))
	if err != nil {
		t.Fatal(err)
	}
	viewer.accept(t, answer)
	select {
	case <-viewer.open:
	case <-time.After(10 * time.Second):
		t.Fatal("the metadata channel did not open")
	}

	// Frames every 40 ms; each with a detection naming it, sent after it, as a model would.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for timestamp := uint32(93_600); ; timestamp += 3600 {
			select {
			case <-stop:
				return
			case <-time.After(40 * time.Millisecond):
			}
			sender.frame(timestamp + 37) // a frame's RTP time is not a whole millisecond
			sender.detection(timestamp / 90)
		}
	}()

	var matched struct {
		Type    string `json:"type"`
		Insight struct {
			RTPTimestamp uint32 `json:"rtp_timestamp"`
		} `json:"_insight"`
	}
	waitFor(t, "a detection drawn on a frame the browser received", func() bool {
		viewer.mu.Lock()
		defer viewer.mu.Unlock()
		for _, text := range viewer.messages {
			if json.Unmarshal([]byte(text), &matched) == nil && viewer.rtpTimes[matched.Insight.RTPTimestamp] {
				return true
			}
		}
		return false
	})

	state := s.States(time.Now())[0]
	if !state.Video.Active || state.Video.Codec != "H264" || state.Viewers != 1 || state.Metadata.Forwarded == 0 || state.Video.Keyframes == 0 {
		t.Fatalf("state %+v", state)
	}
}

func TestABrowserWithoutTheCodecIsRefused(t *testing.T) {
	s := listen(t, 1)
	newApp(t, s, 0, payloadTypeH265, h265IRAP).frame(90_000)
	waitFor(t, "the channel's media", func() bool { return s.channels[0].media.Load() != nil })
	if _, err := s.Offer(context.Background(), 0, newBrowser(t, CodecH264).offer(t)); offerErrorCode(err) != "codec_unsupported" {
		t.Fatalf("err %v", err)
	}
}

func TestACodecChangeClosesTheViewersOfTheOldOne(t *testing.T) {
	s := listen(t, 1)
	sender := newApp(t, s, 0, payloadTypeH264, h264IDR)
	sender.frame(90_000)
	waitFor(t, "the channel's media", func() bool { return s.channels[0].media.Load() != nil })
	viewer := newBrowser(t, CodecH264, CodecH265)
	answer, err := s.Offer(context.Background(), 0, viewer.offer(t))
	if err != nil {
		t.Fatal(err)
	}
	viewer.accept(t, answer)
	waitFor(t, "connected", func() bool { return viewer.pc.ConnectionState() == webrtc.PeerConnectionStateConnected })

	sender.payloadType, sender.keyframePacket = payloadTypeH265, h265IRAP
	sender.frame(93_600)
	waitFor(t, "the old viewer closed", func() bool {
		state := viewer.pc.ConnectionState()
		return state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateFailed ||
			state == webrtc.PeerConnectionStateDisconnected
	})
	if got := s.channels[0].media.Load().codec; got != CodecH265 {
		t.Fatalf("codec %v", got)
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
