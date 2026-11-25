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
	// A 4xx is final: this browser cannot decode the channel's codec, or cannot receive JPEG.
	errUnsupported          = &OfferError{415, "codec_unsupported", "This browser cannot play the channel's codec."}
	errJPEGNeedsDataChannel = &OfferError{415, "jpeg_needs_data_channel",
		"This channel sends JPEG, which a viewer receives over a data channel this offer does not open."}
)

// negotiator answers browsers' offers. Its Pion APIs, one per codec, are built once: the port
// range, the address offered to browsers and the interceptors are the same for every viewer.
type negotiator struct {
	apis map[Codec]*webrtc.API
}

func newNegotiator(portStart, portEnd uint16, iceAddress string) (*negotiator, error) {
	settings := webrtc.SettingEngine{}
	if err := settings.SetEphemeralUDPPortRange(portStart, portEnd); err != nil {
		return nil, fmt.Errorf("the WebRTC port range %d-%d: %w", portStart, portEnd, err)
	}
	if iceAddress != "" {
		settings.SetNAT1To1IPs([]string{iceAddress}, webrtc.ICECandidateTypeHost)
	}
	n := &negotiator{apis: map[Codec]*webrtc.API{}}
	for _, codec := range []Codec{CodecH264, CodecH265, CodecJPEG} {
		engine, registry, err := mediaEngine(codec)
		if err != nil {
			return nil, err
		}
		// WithSettingEngine takes a copy, so the APIs share no settings.
		n.apis[codec] = webrtc.NewAPI(webrtc.WithMediaEngine(engine),
			webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings))
	}
	return n, nil
}

// mediaEngine is what a viewer's connection to a codec's channel negotiates and runs.
func mediaEngine(codec Codec) (*webrtc.MediaEngine, *interceptor.Registry, error) {
	engine, registry := &webrtc.MediaEngine{}, &interceptor.Registry{}
	if codec == CodecJPEG {
		// JPEG frames go over the viewer's jpeg data channel, so no codec is sent. VP8 and
		// H.264, which every browser offers, are registered only so that the video m-line is
		// not rejected (answer makes it inactive): Pion writes the answer's ICE candidates into
		// the first m-line, and a browser ignores them on a rejected one. With no RTP there is
		// nothing to resend or report, so the registry stays empty (left out, Pion would fill it
		// with its defaults).
		for i, mimeType := range []string{webrtc.MimeTypeVP8, webrtc.MimeTypeH264} {
			parameters := webrtc.RTPCodecParameters{
				RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: mimeType, ClockRate: clockRate},
				PayloadType:        webrtc.PayloadType(96 + i),
			}
			if err := engine.RegisterCodec(parameters, webrtc.RTPCodecTypeVideo); err != nil {
				return nil, nil, err
			}
		}
		return engine, registry, nil
	}
	parameters, err := codecParameters(codec)
	if err != nil {
		return nil, nil, err
	}
	if err := engine.RegisterCodec(parameters, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, nil, err
	}
	// A NACK responder resends what a browser lost, and sender reports keep its clock mapping
	// fresh. No PLI: a keyframe is the app's to send (docs/contracts.md).
	if err := webrtc.ConfigureNack(engine, registry); err != nil {
		return nil, nil, err
	}
	if err := webrtc.ConfigureRTCPReports(registry); err != nil {
		return nil, nil, err
	}
	return engine, registry, nil
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
	// browser retry forever. A JPEG channel needs no decoder of the browser's, but its frames
	// travel on a data channel, so an offer without one (no application m-line) would connect
	// and wait forever.
	jpeg := m.codec == CodecJPEG
	if jpeg {
		if !offersDataChannels(parsed.MediaDescriptions) {
			return Description{}, errJPEGNeedsDataChannel
		}
	} else if !offersCodec(parsed.MediaDescriptions, m.parameters.MimeType) {
		return Description{}, errUnsupported
	}

	if err := m.admits(); err != nil {
		return Description{}, err // no connection made only to be closed
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
	// The browser sends nothing Insight reads on either channel.
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		switch dc.Label() {
		case "metadata":
			dc.OnOpen(func() { c.views.add(dc) })
			dc.OnClose(func() { c.views.remove(dc) })
		case "jpeg":
			// The browser opens it on every channel, since it offers before it knows the
			// codec; only a JPEG channel sends on it.
			if !jpeg {
				return
			}
			dc.OnOpen(func() { m.frameViewers.add(dc) })
			dc.OnClose(func() { m.frameViewers.remove(dc) })
		}
	})
	failed := func(step string, err error) (Description, error) {
		if m.isRetired() {
			return Description{}, errCodecChanged
		}
		slog.Warn("a viewer could not connect", "channel", c.index, "step", step, "error", err)
		return Description{}, errNegotiation
	}

	var sender *webrtc.RTPSender // none for JPEG, which has no track
	if !jpeg {
		if sender, err = pc.AddTrack(m.track); err != nil {
			return failed("adding the track", err)
		}
	}
	if err := pc.SetRemoteDescription(remote); err != nil {
		return failed("reading the offer", err)
	}
	if jpeg {
		// Pion answers the browser's recvonly video sendonly, even with no track to send; a
		// stopped transceiver is answered inactive, its codecs kept, so the m-line is neither
		// rejected nor promises a track the browser would wait for.
		for _, transceiver := range pc.GetTransceivers() {
			if transceiver.Kind() != webrtc.RTPCodecTypeVideo {
				continue
			}
			if err := transceiver.Stop(); err != nil {
				return failed("answering the video inactive", err)
			}
		}
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
	if sender != nil {
		go func() {
			buf := make([]byte, 1500)
			for {
				if _, _, err := sender.Read(buf); err != nil {
					return
				}
			}
		}()
	}
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

// offersDataChannels says whether an offer has an application m-line, which carries its data
// channels.
func offersDataChannels(media []*sdp.MediaDescription) bool {
	for _, description := range media {
		if description.MediaName.Media == "application" {
			return true
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
