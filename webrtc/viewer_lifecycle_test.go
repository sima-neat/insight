package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestFailedOffersDoNotAccumulateGoroutines(t *testing.T) {
	const (
		channelIndex = 78
		offerCount   = 20
	)
	newLifecycleTestChannel(t, channelIndex)
	baseline := runtime.NumGoroutine()

	for range offerCount {
		request := httptest.NewRequest(
			http.MethodPost,
			"/offer?channel=78",
			bytes.NewBufferString(`{"type":"offer","sdp":"invalid"}`),
		)
		response := httptest.NewRecorder()
		handleOffer(response, request)
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("expected HTTP %d, got %d: %s", http.StatusInternalServerError, response.Code, response.Body.String())
		}
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		runtime.GC()
		if current := runtime.NumGoroutine(); current <= baseline+3 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}

	t.Fatalf("goroutines accumulated across failed offers: before=%d after=%d", baseline, runtime.NumGoroutine())
}

func TestHandleOfferClosesPeerConnectionWhenNegotiationFails(t *testing.T) {
	const channelIndex = 79
	channel := newLifecycleTestChannel(t, channelIndex)

	request := httptest.NewRequest(
		http.MethodPost,
		"/offer?channel=79",
		bytes.NewBufferString(`{"type":"offer","sdp":"invalid"}`),
	)
	response := httptest.NewRecorder()
	handleOffer(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("expected HTTP %d, got %d: %s", http.StatusInternalServerError, response.Code, response.Body.String())
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		snapshot, _ := channel.Egress.Snapshot(true, false, time.Now())
		if len(snapshot.Peers) == 1 && snapshot.Peers[0].ConnectionState == webrtc.PeerConnectionStateClosed.String() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}

	snapshot, _ := channel.Egress.Snapshot(true, false, time.Now())
	t.Fatalf("expected failed negotiation peer to close, got %#v", snapshot.Peers)
}

func newLifecycleTestChannel(t *testing.T, channelIndex int) *Channel {
	t.Helper()
	previous := channels[channelIndex]
	channel := &Channel{
		Stats:  NewIngestStats(channelIndex, 9000+channelIndex, 9100+channelIndex),
		Egress: NewEgressStats(channelIndex),
	}
	media, err := newChannelMedia(videoCodecH264)
	if err != nil {
		t.Fatalf("create channel media: %v", err)
	}
	channel.Media.Store(media)
	channels[channelIndex] = channel
	t.Cleanup(func() { channels[channelIndex] = previous })
	return channel
}

func TestSendRTCPReturnsAfterPeerConnectionCloses(t *testing.T) {
	peerConnection, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create peer connection: %v", err)
	}

	done := make(chan struct{})
	go func() {
		sendRTCP(peerConnection)
		close(done)
	}()

	if err := peerConnection.Close(); err != nil {
		t.Fatalf("close peer connection: %v", err)
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("sendRTCP did not return after the peer connection closed")
	}
}
