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

func TestRewriteRTPPacketTimestamp(t *testing.T) {
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

	rewritten, err := rewriteRTPPacketTimestamp(raw, 5678)
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
