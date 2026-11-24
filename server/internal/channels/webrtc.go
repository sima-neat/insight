package channels

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/pion/interceptor"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// Description is an SDP offer or answer, as the browser's RTCSessionDescription has it.
type Description struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

// OfferError says why an offer was refused, with the status and code the API answers.
type OfferError struct {
	Status  int
	Code    string
	Message string
}

func (e *OfferError) Error() string { return e.Message }

var (
	errNoChannel = &OfferError{400, "no_such_channel", "There is no such channel."}
	errBadOffer  = &OfferError{400, "invalid_offer", "The offer is not a valid SDP offer."}
	// The browser tries again on a 5xx: video may start, a codec change may settle.
	errNoVideo      = &OfferError{503, "no_video", "No video has reached this channel yet."}
	errCodecChanged = &OfferError{503, "codec_changed", "The channel's video changed codec; try again."}
	errNegotiation  = &OfferError{500, "negotiation_failed", "Insight could not set up the connection."}
	// One leaving frees a place, so this one is retried too.
	errTooManyViewers = &OfferError{503, "too_many_viewers",
		fmt.Sprintf("This channel has %d viewers already; try again once one leaves.", maxViewers)}
	// A 4xx is final: this browser cannot decode the channel's codec.
	errUnsupported = &OfferError{415, "codec_unsupported", "This browser cannot play the channel's codec."}
)

// negotiator answers browsers' offers. Its Pion APIs, one per codec, are built once: the port
// range, the address offered to browsers and the interceptors are the same for every viewer.
type negotiator struct {
	apis map[Codec]*webrtc.API
}

func newNegotiator(portStart, portEnd uint16, iceAddress string) (*negotiator, error) {
	n := &negotiator{apis: map[Codec]*webrtc.API{}}
	for _, codec := range []Codec{CodecH264, CodecH265} {
		parameters, err := codecParameters(codec)
		if err != nil {
			return nil, err
		}
		engine := &webrtc.MediaEngine{}
		if err := engine.RegisterCodec(parameters, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, err
		}
		// A NACK responder resends what a browser lost, and sender reports keep its clock
		// mapping fresh; vf had neither. No PLI: a keyframe is the app's to send (docs/contracts.md).
		registry := &interceptor.Registry{}
		if err := webrtc.ConfigureNack(engine, registry); err != nil {
			return nil, err
		}
		if err := webrtc.ConfigureRTCPReports(registry); err != nil {
			return nil, err
		}
		settings := webrtc.SettingEngine{}
		if err := settings.SetEphemeralUDPPortRange(portStart, portEnd); err != nil {
			return nil, fmt.Errorf("the WebRTC port range %d-%d: %w", portStart, portEnd, err)
		}
		if iceAddress != "" {
			settings.SetNAT1To1IPs([]string{iceAddress}, webrtc.ICECandidateTypeHost)
		}
		n.apis[codec] = webrtc.NewAPI(webrtc.WithMediaEngine(engine),
			webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings))
	}
	return n, nil
}

// answer negotiates a viewer of channel c and returns the answer for its browser.
func (n *negotiator) answer(ctx context.Context, c *Channel, offer Description) (Description, error) {
	if offer.Type != "offer" || offer.SDP == "" {
		return Description{}, errBadOffer
	}
	m := c.media.Load()
	if m == nil {
		return Description{}, errNoVideo
	}
	remote := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}
	parsed, err := remote.Unmarshal()
	if err != nil {
		return Description{}, errBadOffer
	}
	// Refused before anything is set up: no negotiation can succeed, and a 5xx would have the
	// browser retry forever.
	if !offersCodec(parsed.MediaDescriptions, m.parameters.MimeType) {
		return Description{}, errUnsupported
	}

	pc, err := n.apis[m.codec].NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return Description{}, errNegotiation
	}
	if err := m.add(pc); err != nil {
		_ = pc.Close()
		return Description{}, err
	}
	done := false
	defer func() {
		if !done {
			m.remove(pc)
			_ = pc.Close()
		}
	}()
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateFailed:
			m.remove(pc)
			_ = pc.Close()
		case webrtc.PeerConnectionStateClosed:
			m.remove(pc)
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "metadata" {
			return
		}
		dc.OnOpen(func() { c.views.add(dc) })
		dc.OnClose(func() { c.views.remove(dc) })
		// The browser sends nothing Insight reads.
	})
	failed := func(step string, err error) (Description, error) {
		if m.isRetired() {
			return Description{}, errCodecChanged
		}
		slog.Warn("a viewer could not connect", "channel", c.index, "step", step, "error", err)
		return Description{}, errNegotiation
	}

	sender, err := pc.AddTrack(m.track)
	if err != nil {
		return failed("adding the track", err)
	}
	if err := pc.SetRemoteDescription(remote); err != nil {
		return failed("reading the offer", err)
	}
	local, err := pc.CreateAnswer(nil)
	if err != nil {
		return failed("answering", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(local); err != nil {
		return failed("setting the answer", err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		return failed("gathering candidates", ctx.Err())
	}
	if m.isRetired() {
		return Description{}, errCodecChanged
	}
	// The interceptors read RTCP from here (the browser's NACKs and reports); reading it keeps
	// them going, and ends with the connection.
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()
	done = true
	return Description{Type: "answer", SDP: pc.LocalDescription().SDP}, nil
}

// offersCodec says whether an offer's video lists the codec; RTP encoding names ignore case,
// and the slash keeps "H264/90000" from matching a search for H265.
func offersCodec(media []*sdp.MediaDescription, mimeType string) bool {
	wanted := strings.ToUpper(strings.TrimPrefix(mimeType, "video/")) + "/"
	for _, description := range media {
		if description.MediaName.Media != "video" {
			continue
		}
		for _, attribute := range description.Attributes {
			if attribute.Key == "rtpmap" && strings.Contains(strings.ToUpper(attribute.Value), wanted) {
				return true
			}
		}
	}
	return false
}

// AsOfferError returns err as an OfferError, or a negotiation failure.
func AsOfferError(err error) *OfferError {
	var offerErr *OfferError
	if errors.As(err, &offerErr) {
		return offerErr
	}
	return errNegotiation
}
