package channels

// Codec is a channel's video codec, named by the RTP payload type its sender uses (the contract
// fixes them; Insight reads no SDP from apps).
type Codec uint8

const (
	CodecNone Codec = iota
	CodecH264
	CodecH265
	CodecJPEG
)

const (
	payloadTypeH264 = 96
	payloadTypeH265 = 98
	// payloadTypeJPEG is RFC 3551's static type for JPEG (RFC 2435).
	payloadTypeJPEG = 26
	// clockRate is the RTP clock of every codec.
	clockRate = 90000
)

func codecOf(payloadType uint8) Codec {
	switch payloadType {
	case payloadTypeH264:
		return CodecH264
	case payloadTypeH265:
		return CodecH265
	case payloadTypeJPEG:
		return CodecJPEG
	}
	return CodecNone
}

// String is the codec's name as the API reports it.
func (c Codec) String() string {
	switch c {
	case CodecH264:
		return "H264"
	case CodecH265:
		return "H265"
	case CodecJPEG:
		return "JPEG"
	}
	return ""
}

// startsPicture says whether a payload of codec holds its picture's first bytes: the start of a
// NAL unit for H.264 and H.265, a fragment at offset 0 for JPEG. A payload too short to say does
// not.
func startsPicture(codec Codec, payload []byte) bool {
	switch codec {
	case CodecH264, CodecH265:
		units := nalsOf(codec, payload)
		return len(units) > 0 && units[0].Start
	case CodecJPEG:
		return len(payload) >= 4 && jpegFragmentOffset(payload) == 0
	}
	return false
}

// nal is what one RTP payload says about a NAL unit it carries: its type, and whether the
// payload holds the unit's start (a fragment may not).
type nal struct {
	Type  uint8
	Start bool
}

// h264NALs reads an H.264 payload (RFC 6184): a single NAL unit, a STAP-A aggregate, or an FU-A
// fragment, whose header's S bit (0x80) marks the fragment with the unit's start.
func h264NALs(payload []byte) []nal {
	if len(payload) == 0 {
		return nil
	}
	switch kind := payload[0] & 0x1f; kind {
	case 24: // STAP-A: 16-bit sizes, each followed by a NAL unit
		var units []nal
		for offset := 1; offset+2 <= len(payload); {
			size := int(payload[offset])<<8 | int(payload[offset+1])
			offset += 2
			if size <= 0 || offset+size > len(payload) {
				break
			}
			units = append(units, nal{Type: payload[offset] & 0x1f, Start: true})
			offset += size
		}
		return units
	case 28: // FU-A
		if len(payload) < 2 {
			return nil
		}
		return []nal{{Type: payload[1] & 0x1f, Start: payload[1]&0x80 != 0}}
	default:
		return []nal{{Type: kind, Start: true}}
	}
}

// h265NALs reads an H.265 payload (RFC 7798): a single NAL unit, an aggregation packet (48) or
// a fragmentation unit (49), whose FU header's S bit marks the start.
func h265NALs(payload []byte) []nal {
	if len(payload) < 2 {
		return nil
	}
	switch kind := (payload[0] >> 1) & 0x3f; {
	case kind == 48:
		var units []nal
		for offset := 2; offset+2 <= len(payload); {
			size := int(payload[offset])<<8 | int(payload[offset+1])
			offset += 2
			if size < 2 || offset+size > len(payload) {
				break
			}
			units = append(units, nal{Type: (payload[offset] >> 1) & 0x3f, Start: true})
			offset += size
		}
		return units
	case kind == 49:
		if len(payload) < 3 {
			return nil
		}
		return []nal{{Type: payload[2] & 0x3f, Start: payload[2]&0x80 != 0}}
	default:
		return []nal{{Type: kind, Start: true}}
	}
}

// nalsOf reads the NAL units of a payload of codec.
func nalsOf(codec Codec, payload []byte) []nal {
	switch codec {
	case CodecH264:
		return h264NALs(payload)
	case CodecH265:
		return h265NALs(payload)
	}
	return nil
}

// isRandomAccess says whether a NAL unit of codec starts a picture a decoder can begin at: an IDR
// slice (5) for H.264, an IRAP (16 to 23) for H.265.
func isRandomAccess(codec Codec, unit nal) bool {
	if !unit.Start {
		return false
	}
	switch codec {
	case CodecH264:
		return unit.Type == 5
	case CodecH265:
		return unit.Type >= 16 && unit.Type <= 23
	}
	return false
}

// isParameterSet says whether a NAL unit is a sequence parameter set (H.264 7, H.265 33).
func isSequenceParameterSet(codec Codec, unit nal) bool {
	return codec == CodecH264 && unit.Type == 7 || codec == CodecH265 && unit.Type == 33
}
