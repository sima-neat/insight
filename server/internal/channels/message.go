package channels

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
)

// A message is one metadata message from an app, parsed once (docs/contracts.md, "The
// envelope"): its fields as raw JSON, and its timestamp when it has a usable one.
type message struct {
	fields map[string]json.RawMessage
	raw    []byte
	// stamp is the frame's RTP time the message names, timestamp × 90 modulo 2³²; valid only
	// when timed.
	stamp uint32
	timed bool
}

// insightKey is the field Insight adds to what it forwards; one from a producer is dropped.
const insightKey = "_insight"

var errNotAnObject = errors.New("a metadata message must be a JSON object")

// parseMessage reads one message. A message that is no JSON object is an error; one without a
// usable timestamp (absent, negative, not a whole number) is untimed and drawn on whatever frame
// shows when it arrives.
func parseMessage(raw []byte) (message, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return message{}, err
	}
	if fields == nil {
		return message{}, errNotAnObject
	}
	m := message{fields: fields, raw: raw}
	if value, ok := fields["timestamp"]; ok {
		if ms, ok := wholeMilliseconds(value); ok {
			m.stamp, m.timed = uint32(ms*90), true
		}
	}
	return m, nil
}

// wholeMilliseconds reads a JSON number that is a whole, non-negative count: 12345 and 12345.0
// alike (a producer that computes it as a float writes the second), not 12345.5, "12345" or -1
// (which Neat's apps send for "none").
func wholeMilliseconds(value json.RawMessage) (uint64, bool) {
	text := string(value)
	if ms, err := strconv.ParseUint(text, 10, 64); err == nil {
		return ms, true
	}
	number, err := strconv.ParseFloat(text, 64)
	if err != nil || number < 0 || number != math.Trunc(number) || number > 1<<53 {
		return 0, false
	}
	return uint64(number), true
}

// forMatched is the message as the browser gets it when it was matched to a frame: with
// "_insight": {"rtp_timestamp": outgoing}, the frame's outgoing RTP time, which the viewer draws
// it on.
func (m message) forMatched(outgoing uint32) ([]byte, error) {
	fields := make(map[string]json.RawMessage, len(m.fields)+1)
	for key, value := range m.fields {
		fields[key] = value
	}
	fields[insightKey] = json.RawMessage(`{"rtp_timestamp":` + strconv.FormatUint(uint64(outgoing), 10) + `}`)
	return json.Marshal(fields)
}

// forUnmatched is the message as the browser gets it when it names no frame: as it came, less
// any "_insight" a producer put in, which the viewer would otherwise trust.
func (m message) forUnmatched() ([]byte, error) {
	if _, ok := m.fields[insightKey]; !ok {
		return m.raw, nil
	}
	fields := make(map[string]json.RawMessage, len(m.fields))
	for key, value := range m.fields {
		if key != insightKey {
			fields[key] = value
		}
	}
	return json.Marshal(fields)
}
