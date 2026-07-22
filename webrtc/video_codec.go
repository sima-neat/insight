package main

import "github.com/pion/webrtc/v4"

type channelVideoTrack struct {
	codec videoCodec
	track *webrtc.TrackLocalStaticRTP
}

type videoCodec uint8

const (
	videoCodecUnknown videoCodec = iota
	videoCodecH264
	videoCodecH265
)

const (
	h264RTPPayloadType = 96
	h265RTPPayloadType = 98
	videoClockRate     = 90000
)

func videoCodecForPayloadType(payloadType uint8) videoCodec {
	switch payloadType {
	case h264RTPPayloadType:
		return videoCodecH264
	case h265RTPPayloadType:
		return videoCodecH265
	default:
		return videoCodecUnknown
	}
}

func (codec videoCodec) name() string {
	switch codec {
	case videoCodecH264:
		return "H264"
	case videoCodecH265:
		return "H265"
	default:
		return "unknown"
	}
}

func videoRTPCodecParameters(codec videoCodec) (webrtc.RTPCodecParameters, bool) {
	parameters := webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{ClockRate: videoClockRate},
	}
	switch codec {
	case videoCodecH264:
		parameters.MimeType = webrtc.MimeTypeH264
		parameters.SDPFmtpLine = "packetization-mode=1;profile-level-id=42e01f"
		parameters.PayloadType = h264RTPPayloadType
	case videoCodecH265:
		parameters.MimeType = webrtc.MimeTypeH265
		parameters.PayloadType = h265RTPPayloadType
	default:
		return webrtc.RTPCodecParameters{}, false
	}
	return parameters, true
}

func newChannelVideoTrack(codec videoCodec) (*channelVideoTrack, error) {
	parameters, _ := videoRTPCodecParameters(codec)
	track, err := webrtc.NewTrackLocalStaticRTP(parameters.RTPCodecCapability, "video", "pion")
	if err != nil {
		return nil, err
	}
	return &channelVideoTrack{codec: codec, track: track}, nil
}
