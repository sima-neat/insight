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
					ClockRate: h264ClockRate,
				},
				PayloadType: tt.offerPayloadType,
			}
			browser, offer := newReceiveOnlyOffer(t, browserParameters)
			t.Cleanup(func() { _ = browser.Close() })

			previous := channels[index]
			channels[index] = &Channel{Egress: NewEgressStats(index), Stats: NewIngestStats(index, 9000+index, 9100+index)}
			channels[index].Codec.Store(uint32(tt.codec))
			previousMimeType := webrtc.MimeTypeH264
			if tt.codec == videoCodecH264 {
				previousMimeType = webrtc.MimeTypeH265
			}
			previousTrack, _ := webrtc.NewTrackLocalStaticRTP(
				webrtc.RTPCodecCapability{MimeType: previousMimeType, ClockRate: h264ClockRate},
				"video", "pion",
			)
			channels[index].Track.Store(previousTrack)
			t.Cleanup(func() { channels[index] = previous })

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
			track := channels[index].Track.Load()
			if track == nil || track == previousTrack || track.Codec().MimeType != tt.mimeType {
				t.Fatalf("unexpected channel track: %#v", track)
			}
		})
	}
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
	rewriter := newRTPPacketRewriter()
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
	rewriter := newRTPPacketRewriter()
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
	packet := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    h265RTPPayloadType,
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
