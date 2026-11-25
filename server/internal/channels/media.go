package channels

import (
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/pion/webrtc/v4"
)

// media is one generation of a channel's video: a codec and the track every viewer of it shares.
// A sender that changes codec starts a new generation, and the old one's viewers are closed, so
// they offer again and get the new codec.
type media struct {
	codec      Codec
	parameters webrtc.RTPCodecParameters
	track      *countedTrack

	mu      sync.Mutex
	retired bool
	peers   map[*webrtc.PeerConnection]struct{}
}

func codecParameters(codec Codec) (webrtc.RTPCodecParameters, error) {
	parameters := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{ClockRate: clockRate}}
	switch codec {
	case CodecH264:
		// Insight offers constrained baseline but passes on whatever profile the app sends; a
		// browser decodes any it can (docs/contracts.md, "Video").
		parameters.MimeType = webrtc.MimeTypeH264
		parameters.SDPFmtpLine = "packetization-mode=1;profile-level-id=42e01f"
		parameters.PayloadType = payloadTypeH264
	case CodecH265:
		parameters.MimeType = webrtc.MimeTypeH265
		parameters.PayloadType = payloadTypeH265
	default:
		return parameters, fmt.Errorf("no codec for %d", codec)
	}
	return parameters, nil
}

func newMedia(codec Codec) (*media, error) {
	parameters, err := codecParameters(codec)
	if err != nil {
		return nil, err
	}
	track, err := webrtc.NewTrackLocalStaticRTP(parameters.RTPCodecCapability, "video", "insight")
	if err != nil {
		return nil, err
	}
	return &media{codec: codec, parameters: parameters, track: &countedTrack{TrackLocalStaticRTP: track},
		peers: map[*webrtc.PeerConnection]struct{}{}}, nil
}

// maxViewers bounds the connections of one channel, the ones still negotiating or waiting for ICE
// to fail included: each holds a Pion connection, its goroutines and its share of the WebRTC port
// range, and an offer is all it takes to open one. Eight covers a team watching one board's
// channel at once.
const maxViewers = 8

// add registers a viewer's connection, or says why not: the generation is retired, or full.
func (m *media) add(peer *webrtc.PeerConnection) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.refusalLocked(); err != nil {
		return err
	}
	m.peers[peer] = struct{}{}
	return nil
}

// admits says why a new viewer would be refused now, before a connection is made for it; add
// decides, once the connection exists.
func (m *media) admits() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.refusalLocked()
}

func (m *media) refusalLocked() error {
	switch {
	case m.retired:
		return errCodecChanged
	case len(m.peers) >= maxViewers:
		return errTooManyViewers
	}
	return nil
}

func (m *media) remove(peer *webrtc.PeerConnection) {
	m.mu.Lock()
	delete(m.peers, peer)
	m.mu.Unlock()
}

func (m *media) isRetired() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.retired
}

func (m *media) viewers() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.peers)
}

// retire closes the generation's viewers. The flag is set at once, so an offer in flight is
// refused; the closing runs apart, since it waits for DTLS and ICE per viewer and retire runs on
// the channel's reader.
func (m *media) retire() {
	m.mu.Lock()
	if m.retired {
		m.mu.Unlock()
		return
	}
	m.retired = true
	peers := make([]*webrtc.PeerConnection, 0, len(m.peers))
	for peer := range m.peers {
		peers = append(peers, peer)
	}
	clear(m.peers)
	m.mu.Unlock()
	go func() {
		for _, peer := range peers {
			_ = peer.Close()
		}
	}()
}

// countedTrack counts Pion's bindings of the track: a binding is a viewer that negotiated it, so
// zero means no browser watches and the reader can skip the work. idle advances when the last
// one leaves, so the next viewer's stream starts at a random-access picture.
type countedTrack struct {
	*webrtc.TrackLocalStaticRTP
	bindings atomic.Int64
	idle     atomic.Uint64
}

func (t *countedTrack) Bind(context webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	parameters, err := t.TrackLocalStaticRTP.Bind(context)
	if err == nil {
		t.bindings.Add(1)
	}
	return parameters, err
}

func (t *countedTrack) Unbind(context webrtc.TrackLocalContext) error {
	// Pion refuses a context it no longer holds (a double close), which keeps the count true.
	if err := t.TrackLocalStaticRTP.Unbind(context); err != nil {
		return err
	}
	if t.bindings.Add(-1) == 0 {
		t.idle.Add(1)
	}
	return nil
}
