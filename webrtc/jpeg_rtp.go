package main

import (
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/pion/rtp"
)

// RTP/JPEG depacketization (RFC 2435). The board's rtpjpegpay strips the JPEG
// headers and sends only the scan data plus a compact header, so a complete
// JFIF image is rebuilt here from the type, Q, size and tables it carries. The
// image is relayed as-is; nothing is decoded on the host.

const maxJPEGFrameBytes = 4 << 20

type jpegMainHeader struct {
	offset          uint32
	typ, q          uint8
	width, height   int
	restartInterval uint16
}

// parseJPEGPayload reads the main header, and the restart header for types
// 64-127, returning what follows them: the quantization table header (Q >= 128
// at offset 0 only) and the scan data.
func parseJPEGPayload(payload []byte) (jpegMainHeader, []byte, error) {
	if len(payload) < 8 {
		return jpegMainHeader{}, nil, errors.New("jpeg payload shorter than its main header")
	}
	if payload[0] != 0 {
		return jpegMainHeader{}, nil, fmt.Errorf("interlaced jpeg (type-specific %d) is unsupported", payload[0])
	}
	h := jpegMainHeader{
		offset: uint32(payload[1])<<16 | uint32(payload[2])<<8 | uint32(payload[3]),
		typ:    payload[4],
		q:      payload[5],
		width:  int(payload[6]) * 8,
		height: int(payload[7]) * 8,
	}
	if h.typ&^64 > 1 {
		return h, nil, fmt.Errorf("jpeg type %d is unsupported", h.typ)
	}
	if h.width == 0 || h.height == 0 {
		return h, nil, errors.New("jpeg frame size is zero")
	}
	body := payload[8:]
	if h.typ >= 64 {
		if len(body) < 4 {
			return h, nil, errors.New("jpeg payload shorter than its restart header")
		}
		// The F, L and restart count bits after the interval may differ per
		// packet (RFC 2435 3.1.7); only the interval describes the image.
		h.restartInterval = binary.BigEndian.Uint16(body)
		if h.restartInterval == 0 {
			return h, nil, errors.New("jpeg restart interval is zero")
		}
		body = body[4:]
	}
	return h, body, nil
}

func assembleJPEG(packets [][]byte) ([]byte, error) {
	if len(packets) == 0 {
		return nil, errors.New("jpeg frame has no packets")
	}
	var first jpegMainHeader
	var tables [][]byte
	var scan []byte
	for i, raw := range packets {
		var pkt rtp.Packet
		if err := pkt.Unmarshal(raw); err != nil {
			return nil, err
		}
		h, body, err := parseJPEGPayload(pkt.Payload)
		if err != nil {
			return nil, err
		}
		if i == 0 {
			if h.offset != 0 {
				return nil, errors.New("jpeg frame is missing its first fragment")
			}
			first = h
			if tables, body, err = jpegQuantizationTables(h.q, body); err != nil {
				return nil, err
			}
		} else if h.typ != first.typ || h.q != first.q || h.width != first.width ||
			h.height != first.height || h.restartInterval != first.restartInterval {
			return nil, errors.New("jpeg header changed within a frame")
		}
		if h.offset != uint32(len(scan)) {
			return nil, fmt.Errorf("jpeg fragment offset %d, expected %d", h.offset, len(scan))
		}
		if len(scan)+len(body) > maxJPEGFrameBytes {
			return nil, fmt.Errorf("jpeg frame exceeds %d bytes", maxJPEGFrameBytes)
		}
		scan = append(scan, body...)
	}
	return jpegImage(first, tables, scan), nil
}

// jpegQuantizationTables returns the luma and chroma tables, either sent
// in-band (Q 128-255, first packet only) or derived from Q (1-99), and the
// payload left after any in-band table header.
func jpegQuantizationTables(q uint8, body []byte) ([][]byte, []byte, error) {
	switch {
	case q == 0 || (q >= 100 && q < 128):
		return nil, nil, fmt.Errorf("jpeg Q %d is reserved", q)
	case q < 100:
		return [][]byte{scaledJPEGTable(jpegLumaQuantizer[:], q), scaledJPEGTable(jpegChromaQuantizer[:], q)}, body, nil
	}
	if len(body) < 4 {
		return nil, nil, errors.New("jpeg quantization table header is truncated")
	}
	precision, length := body[1], int(binary.BigEndian.Uint16(body[2:]))
	if length == 0 {
		return nil, nil, errors.New("jpeg tables sent out of band are unsupported")
	}
	if len(body) < 4+length {
		return nil, nil, errors.New("jpeg quantization tables are truncated")
	}
	data := body[4 : 4+length]
	var tables [][]byte
	for len(data) > 0 && len(tables) < 2 {
		size := 64
		if precision&(1<<len(tables)) != 0 {
			size = 128
		}
		if len(data) < size {
			return nil, nil, errors.New("jpeg quantization table length is inconsistent")
		}
		tables = append(tables, data[:size])
		data = data[size:]
	}
	if len(tables) == 1 {
		tables = append(tables, tables[0])
	}
	return tables, body[4+length:], nil
}

// RFC 2435 Appendix A: the Annex K tables scaled by Q the way the IJG encoder
// does. The base tables are in natural order; DQT carries zigzag order.
func scaledJPEGTable(base []byte, q uint8) []byte {
	scale := 200 - 2*int(q)
	if q < 50 {
		scale = 5000 / int(q)
	}
	table := make([]byte, 64)
	for i, natural := range jpegZigzag {
		table[i] = byte(min(max((int(base[natural])*scale+50)/100, 1), 255))
	}
	return table
}

func jpegImage(h jpegMainHeader, tables [][]byte, scan []byte) []byte {
	out := make([]byte, 0, len(scan)+700)
	out = append(out, 0xff, 0xd8)
	for id, table := range tables {
		precision := byte(0)
		if len(table) == 128 {
			precision = 1
		}
		out = appendJPEGSegment(out, 0xdb, append([]byte{precision<<4 | byte(id)}, table...))
	}
	if h.typ >= 64 {
		out = appendJPEGSegment(out, 0xdd, binary.BigEndian.AppendUint16(nil, h.restartInterval))
	}
	lumaSampling := byte(0x21) // type 0: 4:2:2
	if h.typ&1 == 1 {
		lumaSampling = 0x22 // type 1: 4:2:0
	}
	out = appendJPEGSegment(out, 0xc0, []byte{
		8, byte(h.height >> 8), byte(h.height), byte(h.width >> 8), byte(h.width), 3,
		1, lumaSampling, 0, 2, 0x11, 1, 3, 0x11, 1,
	})
	for _, table := range jpegHuffmanTables {
		out = appendJPEGSegment(out, 0xc4, table)
	}
	out = appendJPEGSegment(out, 0xda, []byte{3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0})
	out = append(out, scan...)
	if n := len(out); out[n-2] != 0xff || out[n-1] != 0xd9 {
		out = append(out, 0xff, 0xd9)
	}
	return out
}

func appendJPEGSegment(out []byte, marker byte, body []byte) []byte {
	out = append(out, 0xff, marker)
	out = binary.BigEndian.AppendUint16(out, uint16(len(body)+2))
	return append(out, body...)
}

var jpegZigzag = [64]byte{
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
	12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
	58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
}

var jpegLumaQuantizer = [64]byte{
	16, 11, 10, 16, 24, 40, 51, 61,
	12, 12, 14, 19, 26, 58, 60, 55,
	14, 13, 16, 24, 40, 57, 69, 56,
	14, 17, 22, 29, 51, 87, 80, 62,
	18, 22, 37, 56, 68, 109, 103, 77,
	24, 35, 55, 64, 81, 104, 113, 92,
	49, 64, 78, 87, 103, 121, 120, 101,
	72, 92, 95, 98, 112, 100, 103, 99,
}

var jpegChromaQuantizer = [64]byte{
	17, 18, 24, 47, 99, 99, 99, 99,
	18, 21, 26, 66, 99, 99, 99, 99,
	24, 26, 56, 99, 99, 99, 99, 99,
	47, 66, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
}

// DHT bodies for the Annex K.3 tables (RFC 2435 Appendix B): class/id, the 16
// code-length counts, then the symbols.
var jpegHuffmanTables = [][]byte{
	append([]byte{0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0}, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11),
	append([]byte{0x10, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d},
		0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
		0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
		0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
		0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
		0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
		0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
		0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
		0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
		0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
		0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
		0xf9, 0xfa),
	append([]byte{0x01, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0}, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11),
	append([]byte{0x11, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77},
		0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
		0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
		0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
		0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
		0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
		0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
		0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
		0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
		0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
		0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
		0xf9, 0xfa),
}
