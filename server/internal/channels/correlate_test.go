package channels

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// Carried over from vf's tests (webrtc/metadata_sync_test.go), with whole-number timestamps and a
// producer's own "_insight" added.

func timedMessage(t *testing.T, ms int64) message {
	t.Helper()
	m, err := parseMessage([]byte(fmt.Sprintf(`{"type":"object-detection","timestamp":%d,"data":{"objects":[]}}`, ms)))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func outgoingOf(t *testing.T, o outbound) uint32 {
	t.Helper()
	encoded, err := o.encode()
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Insight *struct {
			RTPTimestamp uint32 `json:"rtp_timestamp"`
		} `json:"_insight"`
	}
	if err := json.Unmarshal(encoded, &body); err != nil {
		t.Fatal(err)
	}
	if body.Insight == nil {
		t.Fatalf("no _insight in %s", encoded)
	}
	return body.Insight.RTPTimestamp
}

var now0 = time.Unix(100, 0)

func TestAMessageMatchesTheFrameItsMillisecondsName(t *testing.T) {
	var c correlator
	// 1234 ms truncated: the frame's RTP time is up to 89 ticks past 1234 × 90.
	c.frame(99, 1234*90+87, 5678, now0)
	out, ok := c.message(timedMessage(t, 1234), now0)
	if !ok || outgoingOf(t, out) != 5678 {
		t.Fatalf("ok %v", ok)
	}
}

func TestAMessageWaitsForItsFrame(t *testing.T) {
	var c correlator
	if _, ok := c.message(timedMessage(t, 2000), now0); ok {
		t.Fatal("matched before its frame")
	}
	ready := c.frame(7, 2000*90+34, 8765, now0.Add(time.Millisecond))
	if len(ready) != 1 || outgoingOf(t, ready[0]) != 8765 {
		t.Fatalf("released %d", len(ready))
	}
	if len(c.pending) != 0 {
		t.Fatalf("%d messages still wait", len(c.pending))
	}
}

func TestMatchingCrossesTheRTPWrap(t *testing.T) {
	var c correlator
	c.frame(7, 11, 9001, now0)
	// 47721858 × 90 is 2³² + 4 ticks.
	if _, ok := c.message(timedMessage(t, 47721858), now0); !ok {
		t.Fatal("no match across the wrap")
	}
}

func TestAMessageThatWaitedTooLongIsDropped(t *testing.T) {
	var c correlator
	c.message(timedMessage(t, 2000), now0)
	if ready := c.frame(7, 2000*90, 8765, now0.Add(6*time.Second)); len(ready) != 0 {
		t.Fatal("an expired message was released")
	}
	if len(c.pending) != 0 {
		t.Fatalf("%d messages still wait", len(c.pending))
	}
}

func TestTheClosestFrameWins(t *testing.T) {
	var c correlator
	c.frame(7, 1000*90-80, 1, now0)
	c.frame(7, 1000*90+10, 2, now0)
	c.frame(7, 1000*90+85, 3, now0)
	out, ok := c.message(timedMessage(t, 1000), now0)
	if !ok || outgoingOf(t, out) != 2 {
		t.Fatalf("ok %v", ok)
	}
	if _, ok := c.message(timedMessage(t, 1002), now0); ok {
		t.Fatal("a message 2 ms off matched")
	}
}

func TestANewSenderClearsBothSides(t *testing.T) {
	var c correlator
	c.frame(7, 1000*90, 1, now0)
	c.message(timedMessage(t, 5000), now0)
	c.frame(8, 0, 2, now0) // another SSRC
	if len(c.pending) != 0 {
		t.Fatalf("%d messages of the old sender still wait", len(c.pending))
	}
	if _, ok := c.message(timedMessage(t, 1000), now0); ok {
		t.Fatal("the old sender's frame matched")
	}
}

func TestBothSidesAreBounded(t *testing.T) {
	var c correlator
	for i := range correlationCapacity + 10 {
		c.message(timedMessage(t, int64(i)), now0)
	}
	if len(c.pending) != correlationCapacity || c.pending[0].msg.stamp != 10*90 {
		t.Fatalf("%d messages wait, the oldest stamped %d", len(c.pending), c.pending[0].msg.stamp)
	}
	for i := range correlationCapacity + 10 {
		c.frame(7, uint32(1_000_000+i*3000), uint32(i), now0)
	}
	if len(c.frames) != correlationCapacity {
		t.Fatalf("%d frames kept", len(c.frames))
	}
}

func TestParseMessage(t *testing.T) {
	cases := []struct {
		raw   string
		timed bool
		stamp uint32
		err   bool
	}{
		{`{"type":"x","timestamp":12345,"data":{}}`, true, 12345 * 90, false},
		{`{"type":"x","timestamp":12345.0,"data":{}}`, true, 12345 * 90, false},
		{`{"type":"x","timestamp":12345.5,"data":{}}`, false, 0, false},
		{`{"type":"x","timestamp":"12345","data":{}}`, false, 0, false},
		{`{"type":"x","timestamp":-1,"data":{}}`, false, 0, false},
		{`{"type":"x","timestamp":null,"data":{}}`, false, 0, false},
		{`{"type":"x","data":{}}`, false, 0, false},
		{`not json`, false, 0, true},
		{`[1,2]`, false, 0, true},
		{`null`, false, 0, true},
	}
	for _, c := range cases {
		m, err := parseMessage([]byte(c.raw))
		if (err != nil) != c.err || m.timed != c.timed || m.stamp != c.stamp {
			t.Errorf("%s: timed %v stamp %d err %v", c.raw, m.timed, m.stamp, err)
		}
	}
}

func TestAProducersInsightFieldIsDropped(t *testing.T) {
	m, err := parseMessage([]byte(`{"type":"x","data":{},"_insight":{"rtp_timestamp":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := outbound{msg: m}.encode()
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	json.Unmarshal(encoded, &fields)
	if _, ok := fields["_insight"]; ok || fields["type"] != "x" {
		t.Fatalf("%s", encoded)
	}
	// A matched message's _insight is Insight's own.
	if got := outgoingOf(t, outbound{msg: m, outgoing: 42, matched: true}); got != 42 {
		t.Fatalf("outgoing %d", got)
	}
	// Without one, an unmatched message passes as it came.
	plain := []byte(`{"type":"x","data":{}}`)
	m, _ = parseMessage(plain)
	if encoded, _ := (outbound{msg: m}).encode(); string(encoded) != string(plain) {
		t.Fatalf("%s", encoded)
	}
}
