package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestHandleOfferReturnsUnavailableBeforeCodecIsKnown(t *testing.T) {
	const channel = 0
	previous := channels[channel]
	channels[channel] = &Channel{}
	t.Cleanup(func() { channels[channel] = previous })

	request := httptest.NewRequest(http.MethodPost, "/offer?channel=0", strings.NewReader(`{"type":"offer","sdp":""}`))
	response := httptest.NewRecorder()
	handleOffer(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected HTTP %d, got %d: %s", http.StatusServiceUnavailable, response.Code, response.Body.String())
	}
}

func TestHandleOfferAdvertisesSelectedCodec(t *testing.T) {
	tests := []struct {
		name             string
		codec            videoCodec
		mimeType         string
		offerPayloadType webrtc.PayloadType
	}{
		{name: "h264", codec: videoCodecH264, mimeType: webrtc.MimeTypeH264, offerPayloadType: 96},
		{name: "h265", codec: videoCodecH265, mimeType: webrtc.MimeTypeH265, offerPayloadType: 116},
	}

	for index, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			browserParameters := webrtc.RTPCodecParameters{
				RTPCodecCapability: webrtc.RTPCodecCapability{
					MimeType:  tt.mimeType,
					ClockRate: videoRTPClockRate,
				},
				PayloadType: tt.offerPayloadType,
			}
			browser, offer := newReceiveOnlyOffer(t, browserParameters)
			t.Cleanup(func() { _ = browser.Close() })

			previous := channels[index]
			channels[index] = &Channel{Egress: NewEgressStats(index), Stats: NewIngestStats(index, 9000+index, 9100+index)}
			media := mustNewChannelMedia(t, tt.codec)
			channels[index].Media.Store(media)
			t.Cleanup(func() { channels[index] = previous })
			t.Cleanup(media.peers.retire)

			body, err := json.Marshal(offer)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/offer?channel=%d", index), bytes.NewReader(body))
			response := httptest.NewRecorder()
			handleOffer(response, request)

			if response.Code != http.StatusOK {
				t.Fatalf("expected offer to succeed, got HTTP %d: %s", response.Code, response.Body.String())
			}
			var answer webrtc.SessionDescription
			if err := json.NewDecoder(response.Body).Decode(&answer); err != nil {
				t.Fatalf("decode answer: %v", err)
			}
			rtpmap := fmt.Sprintf("a=rtpmap:%d %s/90000", tt.offerPayloadType, tt.mimeType[6:])
			if !strings.Contains(answer.SDP, rtpmap) {
				t.Fatalf("expected answer to advertise %s: %s", tt.mimeType, answer.SDP)
			}
			if got := channels[index].Media.Load(); got != media || got.track.Codec().MimeType != tt.mimeType {
				t.Fatalf("handleOffer replaced the published channel media: %#v", got)
			}
		})
	}
}

func TestHandleOfferReturnsUnavailableWhenMediaRetiresDuringNegotiation(t *testing.T) {
	const channelIndex = 76
	media := mustNewChannelMedia(t, videoCodecH264)
	browser, offer := newReceiveOnlyOffer(t, media.parameters)
	t.Cleanup(func() { _ = browser.Close() })

	previous := channels[channelIndex]
	channel := &Channel{
		Stats:  NewIngestStats(channelIndex, 9000+channelIndex, 9100+channelIndex),
		Egress: NewEgressStats(channelIndex),
	}
	channel.Media.Store(media)
	channels[channelIndex] = channel
	t.Cleanup(func() { channels[channelIndex] = previous })
	body, err := json.Marshal(offer)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/offer?channel=76", bytes.NewReader(body))
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handleOffer(response, request)
		close(done)
	}()

	deadline := time.Now().Add(time.Second)
	for {
		media.peers.mu.Lock()
		peerCount := len(media.peers.peers)
		media.peers.mu.Unlock()
		if peerCount > 0 {
			break
		}
		select {
		case <-done:
			t.Fatalf("offer completed before registering its media generation: HTTP %d", response.Code)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("offer did not register its media generation")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := channel.publishMediaForCodec(videoCodecH265); err != nil {
		t.Fatalf("publish H.265 media: %v", err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("offer did not stop after its media generation retired")
	}
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected retryable HTTP %d, got %d: %s", http.StatusServiceUnavailable, response.Code, response.Body.String())
	}
}

func mustNewChannelMedia(t *testing.T, codec videoCodec) *channelMedia {
	t.Helper()
	media, err := newChannelMedia(codec)
	if err != nil {
		t.Fatalf("create channel media: %v", err)
	}
	return media
}

func TestChannelMediaSharesTrackAcrossNegotiatedViewers(t *testing.T) {
	media := mustNewChannelMedia(t, videoCodecH265)
	type negotiationResult struct {
		sender   *webrtc.PeerConnection
		receiver *webrtc.PeerConnection
		err      error
	}

	start := make(chan struct{})
	results := make(chan negotiationResult, 2)
	for range 2 {
		go func() {
			<-start
			sender, receiver, err := negotiateTestViewer(media)
			results <- negotiationResult{sender: sender, receiver: receiver, err: err}
		}()
	}
	close(start)

	negotiations := make([]negotiationResult, 0, 2)
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatalf("negotiate viewer: %v", result.err)
		}
		negotiations = append(negotiations, result)
	}
	for _, result := range negotiations {
		t.Cleanup(func() {
			_ = result.sender.Close()
			_ = result.receiver.Close()
		})
		if got := result.sender.GetSenders()[0].Track(); got != media.track {
			t.Fatalf("viewer did not bind the published track: %#v", got)
		}
	}

	if got := media.track.bindingCount.Load(); got != 2 {
		t.Fatalf("expected two bindings on the shared track, got %d", got)
	}
	if err := negotiations[0].sender.Close(); err != nil {
		t.Fatalf("close first sender: %v", err)
	}
	if got := media.track.bindingCount.Load(); got != 1 {
		t.Fatalf("expected one binding after first viewer closed, got %d", got)
	}
	if got := media.track.idleEpoch.Load(); got != 0 {
		t.Fatalf("closing one of two viewers marked the track idle: epoch=%d", got)
	}
	if err := negotiations[1].sender.Close(); err != nil {
		t.Fatalf("close second sender: %v", err)
	}
	if got := media.track.bindingCount.Load(); got != 0 {
		t.Fatalf("expected no bindings after both viewers closed, got %d", got)
	}
	if got := media.track.idleEpoch.Load(); got != 1 {
		t.Fatalf("expected one idle transition, got epoch=%d", got)
	}
	if err := negotiations[1].sender.Close(); err != nil {
		t.Fatalf("close second sender again: %v", err)
	}
	if got := media.track.bindingCount.Load(); got != 0 {
		t.Fatalf("closing a viewer twice changed the binding count: %d", got)
	}
}

func TestChannelMediaCodecTransitionPublishesOneGeneration(t *testing.T) {
	channel := &Channel{}
	h264, err := channel.publishMediaForCodec(videoCodecH264)
	if err != nil {
		t.Fatalf("publish H.264 media: %v", err)
	}
	sameH264, err := channel.publishMediaForCodec(videoCodecH264)
	if err != nil {
		t.Fatalf("reuse H.264 media: %v", err)
	}
	if sameH264 != h264 {
		t.Fatal("same codec replaced the media generation")
	}

	h265, err := channel.publishMediaForCodec(videoCodecH265)
	if err != nil {
		t.Fatalf("publish H.265 media: %v", err)
	}
	if h265 == h264 || h265.track == h264.track {
		t.Fatal("codec transition reused the previous media generation")
	}
	if got := channel.Media.Load(); got != h265 {
		t.Fatalf("codec transition did not atomically publish the new generation: %#v", got)
	}
	if h265.codec != videoCodecH265 || h265.parameters.MimeType != webrtc.MimeTypeH265 ||
		h265.track.Codec().MimeType != webrtc.MimeTypeH265 {
		t.Fatalf("published H.265 generation is internally inconsistent: %#v", h265)
	}
}

func TestCodecTransitionRetiresPreviousMediaPeers(t *testing.T) {
	channel := &Channel{}
	h264, err := channel.publishMediaForCodec(videoCodecH264)
	if err != nil {
		t.Fatalf("publish H.264 media: %v", err)
	}
	sender, receiver, err := negotiateTestViewer(h264)
	if err != nil {
		t.Fatalf("negotiate H.264 viewer: %v", err)
	}
	t.Cleanup(func() {
		_ = sender.Close()
		_ = receiver.Close()
	})
	if !h264.peers.add(sender) {
		t.Fatal("active H.264 generation rejected its negotiated peer")
	}
	if got := h264.track.bindingCount.Load(); got != 1 {
		t.Fatalf("expected one H.264 binding before codec transition, got %d", got)
	}

	h265, err := channel.publishMediaForCodec(videoCodecH265)
	if err != nil {
		t.Fatalf("publish H.265 media: %v", err)
	}
	if h265 == h264 {
		t.Fatal("codec transition reused the retired media generation")
	}
	// Rejecting new peers is synchronous with the generation swap; closing the
	// existing ones is not, so that teardown stays off the RTP read loop.
	if h264.peers.add(sender) {
		t.Fatal("retired media generation accepted another peer")
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if sender.ConnectionState() == webrtc.PeerConnectionStateClosed &&
			h264.track.bindingCount.Load() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf(
		"retired media peer did not close: state=%s bindings=%d",
		sender.ConnectionState(),
		h264.track.bindingCount.Load(),
	)
}

func TestRTPForwarderCountsGatedH265DropsWithoutTrackBindings(t *testing.T) {
	channel := &Channel{Stats: NewIngestStats(0, 9000, 9100)}
	media := mustNewChannelMedia(t, videoCodecH265)
	channel.Media.Store(media)
	forwarder := newRTPForwarder()

	// One random-access unit followed by delta units. With no viewer bound the
	// recovery gate re-arms after the IRAP, so the deltas never complete an
	// access unit; they must still be accounted for as discarded.
	packets := []struct {
		sequence uint16
		payload  []byte
	}{
		{10, []byte{0x26, 0x01}},
		{11, []byte{0x02, 0x01}},
		{12, []byte{0x02, 0x01}},
		{13, []byte{0x02, 0x01}},
	}
	for i, p := range packets {
		pkt := testRTPPacket(t, p.sequence, uint32(9000*(i+1)), true, p.payload)
		forwarder.forward(channel, media, pkt.packet, pkt.raw, nil)
	}

	snapshot := channel.Stats.Snapshot(false, false, time.Now())
	if got := snapshot.Forwarding.PacketsDroppedNoTrack; got != uint64(len(packets)) {
		t.Fatalf("expected every unbound packet counted, got %d of %d", got, len(packets))
	}
	if snapshot.Forwarding.PacketsForwarded != 0 {
		t.Fatalf("unexpected forwarding without a bound viewer: %#v", snapshot.Forwarding)
	}
}

func TestHandleOfferRejectsOfferWithoutChannelCodec(t *testing.T) {
	const channelIndex = 76
	previous := channels[channelIndex]
	channel := &Channel{
		Stats:  NewIngestStats(channelIndex, 9000+channelIndex, 9100+channelIndex),
		Egress: NewEgressStats(channelIndex),
	}
	channel.Media.Store(mustNewChannelMedia(t, videoCodecH265))
	channels[channelIndex] = channel
	t.Cleanup(func() { channels[channelIndex] = previous })

	// A browser with no HEVC support: the offer advertises H.264 only.
	browser, offer := newReceiveOnlyOffer(t, webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   videoRTPClockRate,
			SDPFmtpLine: "packetization-mode=1;profile-level-id=42e01f",
		},
		PayloadType: 96,
	})
	t.Cleanup(func() { _ = browser.Close() })

	body, err := json.Marshal(offer)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost,
		fmt.Sprintf("/offer?channel=%d", channelIndex), bytes.NewReader(body))
	response := httptest.NewRecorder()
	handleOffer(response, request)

	// 4xx so the viewer stops instead of renegotiating every few seconds.
	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected HTTP %d, got %d: %s",
			http.StatusUnsupportedMediaType, response.Code, response.Body.String())
	}
	snapshot, _ := channel.Egress.Snapshot(true, false, time.Now())
	if len(snapshot.Peers) != 0 {
		t.Fatalf("a rejected offer registered peer records: %#v", snapshot.Peers)
	}
}

func TestOfferAdvertisesCodecMatchesEncodingName(t *testing.T) {
	h265Offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0\r\n" +
		"o=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
		"m=video 9 UDP/TLS/RTP/SAVPF 116\r\nc=IN IP4 0.0.0.0\r\n" +
		"a=rtpmap:116 H265/90000\r\n"}

	if !offerAdvertisesCodec(h265Offer, webrtc.MimeTypeH265) {
		t.Fatal("expected an H.265 offer to satisfy an H.265 channel")
	}
	if offerAdvertisesCodec(h265Offer, webrtc.MimeTypeH264) {
		t.Fatal("H265/90000 must not satisfy a search for H264")
	}
	malformed := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "not sdp"}
	if !offerAdvertisesCodec(malformed, webrtc.MimeTypeH265) {
		t.Fatal("a malformed offer must defer to the existing SDP error path")
	}
}

func TestRTPForwarderCountsDropsWithoutTrackBindings(t *testing.T) {
	channel := &Channel{Stats: NewIngestStats(0, 9000, 9100)}
	media := mustNewChannelMedia(t, videoCodecH264)
	channel.Media.Store(media)
	packet := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    h264RTPPayloadType,
			SequenceNumber: 10,
			Timestamp:      9000,
			SSRC:           99,
			Marker:         true,
		},
		Payload: []byte{0x65, 0x88, 0x84},
	}
	raw, err := packet.Marshal()
	if err != nil {
		t.Fatal(err)
	}

	newRTPForwarder().forward(channel, media, packet, raw, nil)
	snapshot := channel.Stats.Snapshot(false, false, time.Now())
	if snapshot.Forwarding.PacketsDroppedNoTrack != 1 || snapshot.Forwarding.PacketsForwarded != 0 {
		t.Fatalf("unexpected zero-binding forwarding diagnostics: %#v", snapshot.Forwarding)
	}
}

func TestIngestStatsTrackAttachmentFollowsCurrentMediaBindings(t *testing.T) {
	const channelIndex = 77
	previous := channels[channelIndex]
	channel := &Channel{Stats: NewIngestStats(channelIndex, 9000+channelIndex, 9100+channelIndex)}
	media := mustNewChannelMedia(t, videoCodecH265)
	channel.Media.Store(media)
	channels[channelIndex] = channel
	t.Cleanup(func() { channels[channelIndex] = previous })

	if snapshot := ingestChannelSnapshot(t, channelIndex); snapshot.Forwarding.WebRTCTrackAttached {
		t.Fatal("unbound media reported a WebRTC track attachment")
	}
	sender, receiver, err := negotiateTestViewer(media)
	if err != nil {
		t.Fatalf("negotiate viewer: %v", err)
	}
	t.Cleanup(func() {
		_ = sender.Close()
		_ = receiver.Close()
	})
	if snapshot := ingestChannelSnapshot(t, channelIndex); !snapshot.Forwarding.WebRTCTrackAttached {
		t.Fatal("negotiated viewer did not report a WebRTC track attachment")
	}
	if err := sender.Close(); err != nil {
		t.Fatalf("close sender: %v", err)
	}
	if err := sender.Close(); err != nil {
		t.Fatalf("close sender again: %v", err)
	}
	if snapshot := ingestChannelSnapshot(t, channelIndex); snapshot.Forwarding.WebRTCTrackAttached {
		t.Fatal("closed viewer left the WebRTC track attachment set")
	}
}

func TestH265ForwarderRearmsAfterIdleTransitionBetweenPackets(t *testing.T) {
	channel := &Channel{
		Stats:         NewIngestStats(0, 9000, 9100),
		MetadataSync:  newMetadataTimestampCorrelator(metadataCorrelationCapacity, metadataCorrelationMaxAge),
		MetadataReady: newMetadataForwardQueue(metadataForwardQueueCapacity),
	}
	media := mustNewChannelMedia(t, videoCodecH265)
	channel.Media.Store(media)
	media.track.bindingCount.Store(1)
	forwarder := newRTPForwarder()

	randomAccess := testRTPPacket(t, 10, 9000, true, []byte{0x26, 0x01})
	forwarder.forward(channel, media, randomAccess.packet, randomAccess.raw, nil)
	if got := channel.Stats.Snapshot(false, true, time.Now()).Forwarding.PacketsForwarded; got != 1 {
		t.Fatalf("expected initial random-access packet to be forwarded, got %d", got)
	}

	// The last viewer leaves and a new one arrives without a completed access unit
	// in between, so only the idle epoch records the transition.
	media.track.bindingCount.Store(0)
	media.track.idleEpoch.Add(1)
	media.track.bindingCount.Store(1)

	delta := testRTPPacket(t, 11, 18000, true, []byte{0x02, 0x01})
	forwarder.forward(channel, media, delta.packet, delta.raw, nil)
	if got := channel.Stats.Snapshot(false, true, time.Now()).Forwarding.PacketsForwarded; got != 1 {
		t.Fatalf("delta packet crossed an idle viewer transition: forwarded=%d", got)
	}

	nextRandomAccess := testRTPPacket(t, 12, 27000, true, []byte{0x26, 0x01})
	forwarder.forward(channel, media, nextRandomAccess.packet, nextRandomAccess.raw, nil)
	if got := channel.Stats.Snapshot(false, true, time.Now()).Forwarding.PacketsForwarded; got != 2 {
		t.Fatalf("new random-access packet did not reopen forwarding: forwarded=%d", got)
	}
}

func TestRTPForwarderDoesNotCombineAccessUnitsAcrossCodecGenerations(t *testing.T) {
	channel := &Channel{
		Stats:         NewIngestStats(0, 9000, 9100),
		MetadataSync:  newMetadataTimestampCorrelator(metadataCorrelationCapacity, metadataCorrelationMaxAge),
		MetadataReady: newMetadataForwardQueue(metadataForwardQueueCapacity),
	}
	h264 := mustNewChannelMedia(t, videoCodecH264)
	h264.track.bindingCount.Store(1)
	forwarder := newRTPForwarder()
	h264Start := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    h264RTPPayloadType,
			SequenceNumber: 10,
			Timestamp:      9000,
			SSRC:           99,
		},
		Payload: []byte{0x65, 0x88},
	}
	h264Raw, err := h264Start.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	forwarder.forward(channel, h264, h264Start, h264Raw, nil)

	h265 := mustNewChannelMedia(t, videoCodecH265)
	h265.track.bindingCount.Store(1)
	h265RandomAccess := testRTPPacket(t, 11, 9000, true, []byte{0x26, 0x01})
	forwarder.forward(channel, h265, h265RandomAccess.packet, h265RandomAccess.raw, nil)

	snapshot := channel.Stats.Snapshot(false, true, time.Now())
	if snapshot.Forwarding.PacketsForwarded != 1 {
		t.Fatalf("codec transition forwarded packets from two media generations: %#v", snapshot.Forwarding)
	}
}

func ingestChannelSnapshot(t *testing.T, channelIndex int) ChannelIngestSnapshot {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/ingest/stats?all=1", nil)
	response := httptest.NewRecorder()
	handleIngestStats(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected ingest stats HTTP 200, got %d: %s", response.Code, response.Body.String())
	}
	var stats IngestStatsResponse
	if err := json.NewDecoder(response.Body).Decode(&stats); err != nil {
		t.Fatalf("decode ingest stats: %v", err)
	}
	for _, channel := range stats.Channels {
		if channel.Channel == channelIndex {
			return channel
		}
	}
	t.Fatalf("channel %d missing from ingest stats", channelIndex)
	return ChannelIngestSnapshot{}
}

func negotiateTestViewer(media *channelMedia) (*webrtc.PeerConnection, *webrtc.PeerConnection, error) {
	receiverEngine := webrtc.MediaEngine{}
	if err := receiverEngine.RegisterCodec(media.parameters, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, nil, fmt.Errorf("register receiver codec: %w", err)
	}
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(&receiverEngine)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, nil, fmt.Errorf("create receiver: %w", err)
	}
	if _, err := receiver.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		_ = receiver.Close()
		return nil, nil, fmt.Errorf("add receiver transceiver: %w", err)
	}
	offer, err := receiver.CreateOffer(nil)
	if err != nil {
		_ = receiver.Close()
		return nil, nil, fmt.Errorf("create offer: %w", err)
	}
	if err := receiver.SetLocalDescription(offer); err != nil {
		_ = receiver.Close()
		return nil, nil, fmt.Errorf("set receiver description: %w", err)
	}

	senderEngine := webrtc.MediaEngine{}
	if err := senderEngine.RegisterCodec(media.parameters, webrtc.RTPCodecTypeVideo); err != nil {
		_ = receiver.Close()
		return nil, nil, fmt.Errorf("register sender codec: %w", err)
	}
	sender, err := webrtc.NewAPI(webrtc.WithMediaEngine(&senderEngine)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		_ = receiver.Close()
		return nil, nil, fmt.Errorf("create sender: %w", err)
	}
	closePeers := func(err error) (*webrtc.PeerConnection, *webrtc.PeerConnection, error) {
		_ = sender.Close()
		_ = receiver.Close()
		return nil, nil, err
	}
	if _, err := sender.AddTrack(media.track); err != nil {
		return closePeers(fmt.Errorf("add sender track: %w", err))
	}
	if err := sender.SetRemoteDescription(*receiver.LocalDescription()); err != nil {
		return closePeers(fmt.Errorf("set sender remote description: %w", err))
	}
	answer, err := sender.CreateAnswer(nil)
	if err != nil {
		return closePeers(fmt.Errorf("create answer: %w", err))
	}
	if err := sender.SetLocalDescription(answer); err != nil {
		return closePeers(fmt.Errorf("set sender local description: %w", err))
	}
	if err := receiver.SetRemoteDescription(*sender.LocalDescription()); err != nil {
		return closePeers(fmt.Errorf("set receiver remote description: %w", err))
	}
	return sender, receiver, nil
}

func newReceiveOnlyOffer(t *testing.T, parameters webrtc.RTPCodecParameters) (*webrtc.PeerConnection, webrtc.SessionDescription) {
	t.Helper()
	mediaEngine := webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(parameters, webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatalf("register browser codec: %v", err)
	}
	peerConnection, err := webrtc.NewAPI(webrtc.WithMediaEngine(&mediaEngine)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create browser peer connection: %v", err)
	}
	if _, err := peerConnection.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		_ = peerConnection.Close()
		t.Fatalf("add browser video transceiver: %v", err)
	}
	offer, err := peerConnection.CreateOffer(nil)
	if err != nil {
		_ = peerConnection.Close()
		t.Fatalf("create browser offer: %v", err)
	}
	if err := peerConnection.SetLocalDescription(offer); err != nil {
		_ = peerConnection.Close()
		t.Fatalf("set browser local description: %v", err)
	}
	<-webrtc.GatheringCompletePromise(peerConnection)
	return peerConnection, *peerConnection.LocalDescription()
}

func TestLoadEphemeralUDPPortRangeUsesWebRTCContainerRange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "neat-port-map.json")
	content := []byte(`{
  "schema": "sima.neat.port-map.v1",
  "webRTC": {
    "containerEnd": 40237,
    "containerStart": 40038,
    "hostEnd": 49999,
    "hostStart": 49800,
    "protocol": "udp"
  }
}`)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}

	gotStart, gotEnd, err := loadEphemeralUDPPortRange(path)
	if err != nil {
		t.Fatalf("expected port range to load: %v", err)
	}
	if gotStart != 40038 || gotEnd != 40237 {
		t.Fatalf("expected container range 40038-40237, got %d-%d", gotStart, gotEnd)
	}
}

func TestLoadEphemeralUDPPortRangeRejectsMissingWebRTC(t *testing.T) {
	path := filepath.Join(t.TempDir(), "neat-port-map.json")
	if err := os.WriteFile(path, []byte(`{"schema":"sima.neat.port-map.v1"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, _, err := loadEphemeralUDPPortRange(path); err == nil {
		t.Fatalf("expected missing webRTC section to fail")
	}
}

func TestValidateEphemeralUDPPortRangeRejectsInvalidRange(t *testing.T) {
	if _, _, err := validateEphemeralUDPPortRange(40200, 40000); err == nil {
		t.Fatalf("expected descending port range to fail")
	}
	if _, _, err := validateEphemeralUDPPortRange(0, 40000); err == nil {
		t.Fatalf("expected zero start port to fail")
	}
	if _, _, err := validateEphemeralUDPPortRange(40000, 65536); err == nil {
		t.Fatalf("expected port above 65535 to fail")
	}
}

func TestRTPTimestampRewriterAdvancesPerFrame(t *testing.T) {
	rewriter := newRTPTimestampRewriter()
	start := time.Unix(100, 0)

	first := rewriter.timestampForFrame(start)
	second := rewriter.timestampForFrame(start.Add(33 * time.Millisecond))
	third := rewriter.timestampForFrame(start.Add(66 * time.Millisecond))

	if first != initialRTPTimestamp {
		t.Fatalf("expected first timestamp %d, got %d", initialRTPTimestamp, first)
	}
	if second <= first {
		t.Fatalf("expected second timestamp to advance, got first=%d second=%d", first, second)
	}
	if third <= second {
		t.Fatalf("expected third timestamp to advance, got second=%d third=%d", second, third)
	}
}

func TestRTPPacketRewriterSetsTimestamp(t *testing.T) {
	rewriter := rtpPacketRewriter{}
	original := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    96,
			SequenceNumber: 7,
			Timestamp:      1234,
			SSRC:           99,
			Marker:         true,
		},
		Payload: []byte{0x65, 0x88, 0x84},
	}
	raw, err := original.Marshal()
	if err != nil {
		t.Fatal(err)
	}

	rewritten, err := rewriter.rewrite(raw, 5678)
	if err != nil {
		t.Fatalf("expected timestamp rewrite to succeed: %v", err)
	}

	var got rtp.Packet
	if err := got.Unmarshal(rewritten); err != nil {
		t.Fatalf("expected rewritten packet to unmarshal: %v", err)
	}
	if got.Timestamp != 5678 {
		t.Fatalf("expected rewritten timestamp 5678, got %d", got.Timestamp)
	}
	if got.SequenceNumber != original.SequenceNumber || got.SSRC != original.SSRC ||
		got.PayloadType != original.PayloadType || !got.Marker {
		t.Fatalf("expected non-timestamp RTP header fields to be preserved: %#v", got.Header)
	}
}

func TestRTPPacketRewriterKeepsSequenceContinuousAcrossSourceGap(t *testing.T) {
	rewriter := rtpPacketRewriter{}
	first := testRTPPacket(t, 7, 1234, true, []byte{0x26, 0x01})
	afterGap := testRTPPacket(t, 4000, 5678, true, []byte{0x02, 0x01})

	firstRaw, err := rewriter.rewrite(first.raw, 9000)
	if err != nil {
		t.Fatalf("expected first packet rewrite to succeed: %v", err)
	}
	afterGapRaw, err := rewriter.rewrite(afterGap.raw, 18000)
	if err != nil {
		t.Fatalf("expected packet rewrite after source gap to succeed: %v", err)
	}

	var firstRewritten, afterGapRewritten rtp.Packet
	if err := firstRewritten.Unmarshal(firstRaw); err != nil {
		t.Fatalf("expected first rewritten packet to unmarshal: %v", err)
	}
	if err := afterGapRewritten.Unmarshal(afterGapRaw); err != nil {
		t.Fatalf("expected rewritten packet after source gap to unmarshal: %v", err)
	}
	if afterGapRewritten.SequenceNumber != firstRewritten.SequenceNumber+1 {
		t.Fatalf(
			"expected continuous outgoing sequence numbers, got first=%d after-gap=%d",
			firstRewritten.SequenceNumber,
			afterGapRewritten.SequenceNumber,
		)
	}
	if firstRewritten.Timestamp != 9000 || afterGapRewritten.Timestamp != 18000 {
		t.Fatalf(
			"expected outgoing frame timestamps 9000 and 18000, got %d and %d",
			firstRewritten.Timestamp,
			afterGapRewritten.Timestamp,
		)
	}
}

func TestRTPAccessUnitBufferRejectsSequenceGap(t *testing.T) {
	buffer := newRTPAccessUnitBuffer()
	first := testRTPPacket(t, 10, 9000, false, []byte{0x26, 0x01, 0x80})
	last := testRTPPacket(t, 12, 9000, true, []byte{0x26, 0x01, 0x00})

	if _, ready := buffer.accept(first.packet, first.raw); ready {
		t.Fatal("expected access unit to remain incomplete before marker")
	}
	if _, ready := buffer.accept(last.packet, last.raw); ready {
		t.Fatal("expected access unit with an RTP sequence gap to be rejected")
	}
}

func TestRTPAccessUnitBufferRejectsMissingH265FragmentStart(t *testing.T) {
	buffer := newRTPAccessUnitBuffer()
	continuation := testRTPPacket(t, 10, 9000, true, []byte{0x62, 0x01, 0x13})

	if _, ready := buffer.accept(continuation.packet, continuation.raw); ready {
		t.Fatal("expected an H.265 continuation without its start to be rejected")
	}
}

// FU-A payloads are {indicator, header, ...}: indicator type 28 marks the
// fragmentation unit, and bit 0x80 of the header is the S bit that flags the
// fragment carrying the start of the NAL unit.
func TestRTPAccessUnitBufferRejectsMissingH264FragmentStart(t *testing.T) {
	buffer := newRTPAccessUnitBuffer()
	continuation := testRTPPacketForCodec(t, h264RTPPayloadType, 10, 9000, true, []byte{0x7c, 0x05, 0x88})

	if _, ready := buffer.accept(continuation.packet, continuation.raw); ready {
		t.Fatal("expected an H.264 FU-A continuation without its start to be rejected")
	}
}

func TestRTPAccessUnitBufferAcceptsFragmentedH264AccessUnit(t *testing.T) {
	buffer := newRTPAccessUnitBuffer()
	start := testRTPPacketForCodec(t, h264RTPPayloadType, 10, 9000, false, []byte{0x7c, 0x85, 0x88})
	end := testRTPPacketForCodec(t, h264RTPPayloadType, 11, 9000, true, []byte{0x7c, 0x45, 0x84})

	if _, ready := buffer.accept(start.packet, start.raw); ready {
		t.Fatal("expected a fragmented access unit to remain incomplete before its marker")
	}
	if _, ready := buffer.accept(end.packet, end.raw); !ready {
		t.Fatal("expected a fully fragmented H.264 access unit to be forwarded")
	}
}

// The surviving packet carries a complete single NAL, so its start flag is
// legitimately set; only the sequence gap shows the unit lost its opening packet.
func TestRTPAccessUnitBufferRejectsUnitThatLostItsFirstPacket(t *testing.T) {
	buffer := newRTPAccessUnitBuffer()
	first := testRTPPacketForCodec(t, h264RTPPayloadType, 10, 9000, true, []byte{0x65, 0x88})
	afterLoss := testRTPPacketForCodec(t, h264RTPPayloadType, 13, 18000, true, []byte{0x41, 0x88})

	if _, ready := buffer.accept(first.packet, first.raw); !ready {
		t.Fatal("expected an intact H.264 access unit to be forwarded")
	}
	if _, ready := buffer.accept(afterLoss.packet, afterLoss.raw); ready {
		t.Fatal("expected an H.264 access unit missing its first packet to be rejected")
	}
}

func TestH265RecoveryGateRejectsDamagedRandomAccessUnit(t *testing.T) {
	buffer := newRTPAccessUnitBuffer()
	opening := testRTPPacket(t, 10, 9000, true, []byte{0x26, 0x01})
	damaged := testRTPPacket(t, 13, 18000, true, []byte{0x26, 0x01})
	clean := testRTPPacket(t, 14, 27000, true, []byte{0x26, 0x01})

	if _, ready := buffer.accept(opening.packet, opening.raw); !ready {
		t.Fatal("expected the opening random-access unit to be forwarded")
	}
	if _, ready := buffer.accept(damaged.packet, damaged.raw); ready {
		t.Fatal("expected a random-access unit with a sequence gap to be rejected")
	}
	if _, ready := buffer.accept(clean.packet, clean.raw); !ready {
		t.Fatal("expected the next intact random-access unit to restore the stream")
	}
}

func TestH265RecoveryGateWaitsForRandomAccessAfterLoss(t *testing.T) {
	buffer := newRTPAccessUnitBuffer()
	delta := testRTPPacket(t, 10, 9000, true, []byte{0x02, 0x01})
	randomAccess := testRTPPacket(t, 11, 18000, true, []byte{0x26, 0x01})
	nextDelta := testRTPPacket(t, 12, 27000, true, []byte{0x02, 0x01})

	if _, ready := buffer.accept(delta.packet, delta.raw); ready {
		t.Fatal("expected startup to wait for an H.265 random-access access unit")
	}
	if _, ready := buffer.accept(randomAccess.packet, randomAccess.raw); !ready {
		t.Fatal("expected random-access H.265 access unit to open recovery")
	}
	if _, ready := buffer.accept(nextDelta.packet, nextDelta.raw); !ready {
		t.Fatal("expected complete H.265 access units after random-access recovery")
	}
}

func TestRTPAccessUnitBufferIgnoresUnsupportedPayloadType(t *testing.T) {
	buffer := newRTPAccessUnitBuffer()
	randomAccess := testRTPPacket(t, 10, 9000, true, []byte{0x26, 0x01})
	unsupported := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    72,
			SequenceNumber: 0,
			Timestamp:      1,
			SSRC:           123,
			Marker:         true,
		},
		Payload: []byte{0xc8, 0x00},
	}
	unsupportedRaw, err := unsupported.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	nextDelta := testRTPPacket(t, 11, 18000, true, []byte{0x02, 0x01})

	if _, ready := buffer.accept(randomAccess.packet, randomAccess.raw); !ready {
		t.Fatal("expected initial random-access frame")
	}
	if _, ready := buffer.accept(unsupported, unsupportedRaw); ready {
		t.Fatal("expected unsupported payload type to be dropped")
	}
	if _, ready := buffer.accept(nextDelta.packet, nextDelta.raw); !ready {
		t.Fatal("expected unsupported payload type not to disturb H.265 sequence state")
	}
}

func TestRTPAccessUnitBufferReportsAbandonedFrame(t *testing.T) {
	buffer := newRTPAccessUnitBuffer()
	abandoned := testRTPPacket(t, 10, 9000, false, []byte{0x02, 0x01})
	next := testRTPPacket(t, 11, 18000, true, []byte{0x02, 0x01})

	if _, ready := buffer.accept(abandoned.packet, abandoned.raw); ready {
		t.Fatal("expected first access unit to remain pending")
	}
	if _, ready := buffer.accept(next.packet, next.raw); ready {
		t.Fatal("expected abandoned H.265 frame to require new random access")
	}
}

func TestRTPAccessUnitBufferDetectsLossBetweenAccessUnits(t *testing.T) {
	buffer := newRTPAccessUnitBuffer()
	randomAccess := testRTPPacket(t, 10, 9000, true, []byte{0x26, 0x01})
	afterGap := testRTPPacket(t, 12, 18000, true, []byte{0x02, 0x01})

	if _, ready := buffer.accept(randomAccess.packet, randomAccess.raw); !ready {
		t.Fatal("expected initial random-access frame")
	}
	if _, ready := buffer.accept(afterGap.packet, afterGap.raw); ready {
		t.Fatal("expected RTP loss between access units to rearm H.265 recovery")
	}
}

type testRTP struct {
	packet *rtp.Packet
	raw    []byte
}

func testRTPPacket(t *testing.T, sequence uint16, timestamp uint32, marker bool, payload []byte) testRTP {
	t.Helper()
	return testRTPPacketForCodec(t, h265RTPPayloadType, sequence, timestamp, marker, payload)
}

func testRTPPacketForCodec(t *testing.T, payloadType uint8, sequence uint16, timestamp uint32, marker bool, payload []byte) testRTP {
	t.Helper()
	packet := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    payloadType,
			SequenceNumber: sequence,
			Timestamp:      timestamp,
			SSRC:           99,
			Marker:         marker,
		},
		Payload: payload,
	}
	raw, err := packet.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return testRTP{packet: packet, raw: raw}
}
