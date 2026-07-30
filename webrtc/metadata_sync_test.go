package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	testCorrelatorCapacity  = 4
	testCorrelatorRetention = 2 * time.Second
)

func metadataPayload(timestampMS int64) []byte {
	return []byte(fmt.Sprintf(
		`{"type":"object-detection","timestamp":%d,"data":{"objects":[]}}`, timestampMS,
	))
}

func TestMetadataTimestampCorrelatorMatchesTruncatedMilliseconds(t *testing.T) {
	correlator := newMetadataTimestampCorrelator(8, 5*time.Second)
	now := time.Unix(100, 0)
	const (
		metadataTimestampMS  = int64(1234)
		sourceRTPTimestamp   = uint32(metadataTimestampMS*90 + 87)
		outgoingRTPTimestamp = uint32(5678)
	)

	correlator.addVideoFrame(99, sourceRTPTimestamp, outgoingRTPTimestamp, now)
	ready := correlator.addMetadata(
		[]byte(`{"type":"object-detection","timestamp":1234,"data":{"objects":[]}}`),
		now,
	)

	if len(ready) != 1 {
		t.Fatalf("expected one matched metadata message, got %d", len(ready))
	}
	var message struct {
		Insight struct {
			RTPTimestamp uint32 `json:"rtp_timestamp"`
		} `json:"_insight"`
	}
	encoded, err := ready[0].encode()
	if err != nil {
		t.Fatalf("expected metadata enrichment to succeed: %v", err)
	}
	if err := json.Unmarshal(encoded, &message); err != nil {
		t.Fatalf("expected valid enriched metadata: %v", err)
	}
	if message.Insight.RTPTimestamp != outgoingRTPTimestamp {
		t.Fatalf("expected outgoing RTP timestamp %d, got %d", outgoingRTPTimestamp, message.Insight.RTPTimestamp)
	}
}

func TestMetadataTimestampCorrelatorReleasesMetadataWhenVideoArrivesLater(t *testing.T) {
	correlator := newMetadataTimestampCorrelator(8, 5*time.Second)
	now := time.Unix(100, 0)
	payload := []byte(`{"type":"tracking","timestamp":2000,"data":{"tracks":[]}}`)

	if ready := correlator.addMetadata(payload, now); len(ready) != 0 {
		t.Fatalf("expected timestamped metadata to wait for its video frame")
	}
	ready := correlator.addVideoFrame(7, 180034, 8765, now.Add(time.Millisecond))

	if len(ready) != 1 {
		t.Fatalf("expected pending metadata to be released, got %d messages", len(ready))
	}
	var message struct {
		Insight struct {
			RTPTimestamp uint32 `json:"rtp_timestamp"`
		} `json:"_insight"`
	}
	encoded, err := ready[0].encode()
	if err != nil {
		t.Fatalf("expected metadata enrichment to succeed: %v", err)
	}
	if err := json.Unmarshal(encoded, &message); err != nil {
		t.Fatalf("expected valid enriched metadata: %v", err)
	}
	if message.Insight.RTPTimestamp != 8765 {
		t.Fatalf("expected outgoing RTP timestamp 8765, got %d", message.Insight.RTPTimestamp)
	}
}

func TestMetadataTimestampCorrelatorMatchesAcrossRTPWraparound(t *testing.T) {
	correlator := newMetadataTimestampCorrelator(8, 5*time.Second)
	now := time.Unix(100, 0)
	correlator.addVideoFrame(7, 11, 9001, now)

	ready := correlator.addMetadata(
		[]byte(`{"type":"object-detection","timestamp":47721858,"data":{"objects":[]}}`),
		now,
	)

	if len(ready) != 1 {
		t.Fatalf("expected wraparound timestamp to match, got %d messages", len(ready))
	}
}

func TestMetadataTimestampCorrelatorDoesNotReleaseExpiredMetadata(t *testing.T) {
	correlator := newMetadataTimestampCorrelator(8, 5*time.Second)
	now := time.Unix(100, 0)
	payload := []byte(`{"type":"tracking","timestamp":2000,"data":{"tracks":[]}}`)

	if ready := correlator.addMetadata(payload, now); len(ready) != 0 {
		t.Fatalf("expected timestamped metadata to wait for its video frame")
	}
	ready := correlator.addVideoFrame(7, 180034, 8765, now.Add(6*time.Second))

	if len(ready) != 0 {
		t.Fatalf("expected expired metadata to be discarded, got %d messages", len(ready))
	}
}

// TestMetadataCorrelatorCountsMatchDirectionsSeparately guards the mistake that
// made apps#391 hard to read: a single "matched" number cannot distinguish a
// correlation that worked from delivery to a browser data channel, and the two
// directions have different causes when they stop working.
// correlatorArrival is one input to a scenario: a nil payload records a video
// frame, otherwise it is a metadata message.
type correlatorArrival struct {
	atMS                   int
	ssrc, source, outgoing uint32
	payload                []byte
}

func frameAt(atMS int, ssrc, source, outgoing uint32) correlatorArrival {
	return correlatorArrival{atMS: atMS, ssrc: ssrc, source: source, outgoing: outgoing}
}

func messageAt(atMS int, timestampMS int64) correlatorArrival {
	return correlatorArrival{atMS: atMS, payload: metadataPayload(timestampMS)}
}

func rawMessageAt(atMS int, payload string) correlatorArrival {
	return correlatorArrival{atMS: atMS, payload: []byte(payload)}
}

// correlatorTally is what a scenario put in and got out, so a test can check it
// against the counters the correlator reports.
type correlatorTally struct {
	messagesIn, framesIn, untimestamped uint64
	// outgoing is the outgoing RTP timestamp of every correlated message, in
	// release order, which is what pins the frame the correlator chose.
	outgoing []uint32
}

func replay(
	t *testing.T, c *metadataTimestampCorrelator, base time.Time, arrivals []correlatorArrival,
) correlatorTally {
	t.Helper()
	var tally correlatorTally
	for _, arrival := range arrivals {
		at := base.Add(time.Duration(arrival.atMS) * time.Millisecond)
		var ready []correlatedMetadata
		if arrival.payload == nil {
			tally.framesIn++
			ready = c.addVideoFrame(arrival.ssrc, arrival.source, arrival.outgoing, at)
		} else {
			tally.messagesIn++
			if parseMetadataEnvelope(arrival.payload).Timestamp == nil {
				tally.untimestamped++
			}
			ready = c.addMetadata(arrival.payload, at)
		}
		for _, metadata := range ready {
			// An untimestamped message comes straight back uncorrelated, and is
			// already counted by untimestamped above.
			if metadata.correlated {
				tally.outgoing = append(tally.outgoing, metadata.outgoing)
			}
		}
	}
	return tally
}

func TestMetadataCorrelatorAttributesEveryOutcome(t *testing.T) {
	const beyond = 2001 // past the 2 s test retention

	cases := []struct {
		name         string
		capacity     int
		arrivals     []correlatorArrival
		observeMS    int
		wantOutgoing []uint32
		want         MetadataCorrelationSnapshot
	}{{
		name:         "video first",
		arrivals:     []correlatorArrival{frameAt(0, 7, 90000, 400), messageAt(0, 1000)},
		wantOutgoing: []uint32{400},
		want:         MetadataCorrelationSnapshot{MatchedVideoFirst: 1, PendingVideo: 1},
	}, {
		name:         "metadata first",
		arrivals:     []correlatorArrival{messageAt(0, 1000), frameAt(0, 7, 90000, 400)},
		wantOutgoing: []uint32{400},
		want:         MetadataCorrelationSnapshot{MatchedMetadataFirst: 1, PendingVideo: 1},
	}, {
		// The nearer frame wins on timestamp distance, not on arrival recency.
		name: "out of order frames, video first",
		arrivals: []correlatorArrival{frameAt(0, 7, 180000, 500), frameAt(1, 7, 90000, 400),
			messageAt(1, 2000), messageAt(1, 1000)},
		observeMS:    1,
		wantOutgoing: []uint32{500, 400},
		want:         MetadataCorrelationSnapshot{MatchedVideoFirst: 2, PendingVideo: 2},
	}, {
		name: "out of order frames, metadata first",
		arrivals: []correlatorArrival{messageAt(0, 1000), frameAt(0, 7, 180000, 500),
			frameAt(1, 7, 90000, 400)},
		observeMS:    1,
		wantOutgoing: []uint32{400},
		want:         MetadataCorrelationSnapshot{MatchedMetadataFirst: 1, PendingVideo: 2},
	}, {
		name:         "metadata delayed within retention",
		arrivals:     []correlatorArrival{frameAt(0, 7, 90000, 400), messageAt(500, 1000)},
		observeMS:    500,
		wantOutgoing: []uint32{400},
		want:         MetadataCorrelationSnapshot{MatchedVideoFirst: 1, PendingVideo: 1},
	}, {
		name:         "video delayed within retention",
		arrivals:     []correlatorArrival{messageAt(0, 1000), frameAt(500, 7, 90000, 400)},
		observeMS:    500,
		wantOutgoing: []uint32{400},
		want:         MetadataCorrelationSnapshot{MatchedMetadataFirst: 1, PendingVideo: 1},
	}, {
		name:      "metadata delayed beyond retention",
		arrivals:  []correlatorArrival{messageAt(0, 1000), frameAt(beyond, 7, 90000, 400)},
		observeMS: beyond,
		want:      MetadataCorrelationSnapshot{ExpiredMetadata: 1, PendingVideo: 1},
	}, {
		name:      "video delayed beyond retention",
		arrivals:  []correlatorArrival{frameAt(0, 7, 90000, 400), messageAt(beyond, 1000)},
		observeMS: beyond,
		want:      MetadataCorrelationSnapshot{ExpiredVideo: 1, PendingMetadata: 1},
	}, {
		// Neither side saw an arrival to prune on, so the read has to age them.
		name:      "both sides age on read",
		arrivals:  []correlatorArrival{frameAt(0, 7, 450000, 700), messageAt(0, 1000)},
		observeMS: beyond,
		want:      MetadataCorrelationSnapshot{ExpiredVideo: 1, ExpiredMetadata: 1},
	}, {
		name:     "video capacity exceeded",
		capacity: 4,
		arrivals: []correlatorArrival{frameAt(0, 7, 90000, 400), frameAt(0, 7, 180000, 401),
			frameAt(0, 7, 270000, 402), frameAt(0, 7, 360000, 403), frameAt(0, 7, 450000, 404)},
		want: MetadataCorrelationSnapshot{EvictedVideo: 1, PendingVideo: 4},
	}, {
		name:     "metadata capacity exceeded",
		capacity: 4,
		arrivals: []correlatorArrival{messageAt(0, 1000), messageAt(0, 2000), messageAt(0, 3000),
			messageAt(0, 4000), messageAt(0, 5000)},
		want: MetadataCorrelationSnapshot{EvictedMetadata: 1, PendingMetadata: 4},
	}, {
		// The restart repeats source 90000. Correlating it to 905 proves the
		// retired generation was cleared rather than matched against.
		name: "source restart repeating keys",
		arrivals: []correlatorArrival{frameAt(0, 7, 90000, 400), messageAt(0, 3000),
			frameAt(1, 8, 90000, 905), messageAt(2, 1000)},
		observeMS:    2,
		wantOutgoing: []uint32{905},
		want: MetadataCorrelationSnapshot{
			MatchedVideoFirst: 1, PendingVideo: 1, EvictedVideo: 1, EvictedMetadata: 1,
		},
	}, {
		// A restart after an idle gap lost its entries to age before the reset saw
		// them. Reporting those as evictions would read as capacity pressure when
		// the stream had simply stopped.
		name: "source restart after an idle gap",
		arrivals: []correlatorArrival{frameAt(0, 7, 90000, 400), messageAt(0, 3000),
			frameAt(beyond, 8, 450000, 905)},
		observeMS: beyond,
		want: MetadataCorrelationSnapshot{
			PendingVideo: 1, ExpiredVideo: 1, ExpiredMetadata: 1,
		},
	}}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			capacity := testCase.capacity
			if capacity == 0 {
				capacity = testCorrelatorCapacity
			}
			correlator := newMetadataTimestampCorrelator(capacity, testCorrelatorRetention)
			base := time.Unix(100, 0)
			tally := replay(t, correlator, base, testCase.arrivals)

			if !slices.Equal(tally.outgoing, testCase.wantOutgoing) {
				t.Errorf("correlated frames = %v, want %v", tally.outgoing, testCase.wantOutgoing)
			}
			got := correlator.pruneAndSnapshot(base.Add(time.Duration(testCase.observeMS) * time.Millisecond))
			if !reflect.DeepEqual(got, testCase.want) {
				t.Errorf("snapshot = %+v, want %+v", got, testCase.want)
			}
		})
	}
}

// TestMetadataCorrelatorAttributesProgressiveDrift covers what users report as
// "overlays worked and then stopped". An over-rate source moves the metadata
// timestamp away from the video timestamp a little per frame, so correlation
// succeeds until the accumulated offset passes the match tolerance and then fails
// permanently. Capacity is wide here so drift shows up as expiry rather than as
// eviction, which is a different diagnosis.
func TestMetadataCorrelatorAttributesProgressiveDrift(t *testing.T) {
	const (
		capacity        = 32
		messages        = 12
		frameIntervalMS = 33 // 30 fps
		// One tolerance width per frame, kept under half the frame interval so a
		// drifted message can never land on the neighbouring frame instead.
		driftPerFrameMS = 1
	)

	correlator := newMetadataTimestampCorrelator(capacity, testCorrelatorRetention)
	base := time.Unix(100, 0)

	matched := make([]bool, messages)
	for i := range matched {
		captureMS := int64(1000 + i*frameIntervalMS)
		arrival := base.Add(time.Duration(i*frameIntervalMS) * time.Millisecond)
		correlator.addVideoFrame(7, uint32(captureMS*90), uint32(400+i), arrival)
		drifted := captureMS + int64(i*driftPerFrameMS)
		matched[i] = len(correlator.addMetadata(metadataPayload(drifted), arrival)) == 1
	}

	if !matched[0] {
		t.Fatal("the undrifted first message did not match, so this proves nothing about drift")
	}
	if matched[messages-1] {
		t.Fatal("the fully drifted last message still matched, so drift never exceeded tolerance")
	}
	matchedCount := 0
	for i, ok := range matched {
		if ok && i > 0 && !matched[i-1] {
			t.Fatalf("message %d matched after correlation had already failed: %v", i, matched)
		}
		if ok {
			matchedCount++
		}
	}

	span := messages * frameIntervalMS * time.Millisecond
	if held := correlator.pruneAndSnapshot(base.Add(span)); held.PendingMetadata != uint64(messages-matchedCount) {
		t.Fatalf("drifted messages were not being held: %+v", held)
	}

	// No message may vanish: what did not match has to show up as expired.
	want := MetadataCorrelationSnapshot{
		MatchedVideoFirst: uint64(matchedCount),
		ExpiredMetadata:   uint64(messages - matchedCount),
		ExpiredVideo:      messages,
	}
	got := correlator.pruneAndSnapshot(base.Add(span + testCorrelatorRetention + time.Millisecond))
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("drifted messages left through the wrong path: %+v, want %+v", got, want)
	}
}

// TestMetadataCorrelatorAccountingIdentityHoldsAcrossMixedSequence is the
// regression test for the gap this change closes: 2987 messages entered the
// correlator on a DevKit and left no trace in any counter. One sequence exercises
// every outcome, then nothing may have entered without leaving through one.
func TestMetadataCorrelatorAccountingIdentityHoldsAcrossMixedSequence(t *testing.T) {
	arrivals := []correlatorArrival{
		frameAt(0, 7, 90000, 400), messageAt(0, 1000), // video first
		messageAt(0, 3000), frameAt(10, 7, 360000, 500), // metadata first, released
		frameAt(20, 7, 270000, 600),                       // by an out-of-order frame
		frameAt(30, 7, 450000, 700), messageAt(530, 5000), // delayed within retention
		rawMessageAt(540, `{"type":"heartbeat"}`),           // forwarded uncorrelated
		messageAt(600, 9000), frameAt(2700, 7, 810000, 800), // expires, and frames age out
		messageAt(5000, 20000),
		// Metadata capacity overflow.
		messageAt(5001, 21000), messageAt(5002, 22000), messageAt(5003, 23000), messageAt(5004, 24000),
		// Video capacity overflow. The last source repeats below so the restart
		// has a key to collide on.
		frameAt(5010, 7, 990000, 900), frameAt(5011, 7, 993000, 901), frameAt(5012, 7, 996000, 902),
		frameAt(5013, 7, 999000, 903), frameAt(5014, 7, 999990, 904),
		frameAt(5020, 8, 999990, 905), messageAt(5021, 11111), // source restart
		messageAt(5022, 40000), // left pending, so the identity has to carry it
	}

	correlator := newMetadataTimestampCorrelator(testCorrelatorCapacity, testCorrelatorRetention)
	base := time.Unix(100, 0)
	tally := replay(t, correlator, base, arrivals)
	snapshot := correlator.pruneAndSnapshot(base.Add(5030 * time.Millisecond))

	if last := tally.outgoing[len(tally.outgoing)-1]; last != 905 {
		t.Fatalf("a repeated source timestamp matched the retired generation: got %d, want 905", last)
	}

	emitted := uint64(len(tally.outgoing)) + tally.untimestamped
	lost := snapshot.ExpiredMetadata + snapshot.EvictedMetadata + snapshot.PendingMetadata
	if tally.messagesIn != emitted+lost {
		t.Fatalf("metadata accounting lost messages: in=%d emitted=%d expired=%d evicted=%d pending=%d",
			tally.messagesIn, emitted,
			snapshot.ExpiredMetadata, snapshot.EvictedMetadata, snapshot.PendingMetadata)
	}
	if matched := snapshot.MatchedVideoFirst + snapshot.MatchedMetadataFirst; matched != uint64(len(tally.outgoing)) {
		t.Fatalf("match counters = %d, want %d correlated messages", matched, len(tally.outgoing))
	}
	// A frame is not consumed by a match, so the video side closes on its own.
	frameOut := snapshot.PendingVideo + snapshot.ExpiredVideo + snapshot.EvictedVideo
	if tally.framesIn != frameOut {
		t.Fatalf("video accounting lost frames: in=%d out=%d (%+v)", tally.framesIn, frameOut, snapshot)
	}
	// The identities hold trivially when a counter is never reached, so assert
	// the sequence actually exercised all eight.
	for name, value := range map[string]uint64{
		"matched_video_first": snapshot.MatchedVideoFirst, "matched_metadata_first": snapshot.MatchedMetadataFirst,
		"pending_video": snapshot.PendingVideo, "pending_metadata": snapshot.PendingMetadata,
		"expired_video": snapshot.ExpiredVideo, "expired_metadata": snapshot.ExpiredMetadata,
		"evicted_video": snapshot.EvictedVideo, "evicted_metadata": snapshot.EvictedMetadata,
	} {
		if value == 0 {
			t.Fatalf("%s was never exercised by the mixed sequence: %+v", name, snapshot)
		}
	}
}

func TestMetadataCorrelatorReportsFrameIDForDiagnostics(t *testing.T) {
	correlator := newMetadataTimestampCorrelator(testCorrelatorCapacity, testCorrelatorRetention)
	now := time.Unix(100, 0)

	correlator.addMetadata([]byte(`{"timestamp":1000,"frame_id":4242}`), now)
	if got := string(correlator.pruneAndSnapshot(now).FrameID); got != "4242" {
		t.Fatalf("expected frame id 4242 in the snapshot, got %q", got)
	}

	// A non-numeric frame id must not cost the message its timestamp.
	correlator.addVideoFrame(7, 90000, 400, now)
	ready := correlator.addMetadata([]byte(`{"timestamp":1000,"frame_id":"a-7"}`), now)
	if len(ready) != 1 || !ready[0].correlated || ready[0].outgoing != 400 {
		t.Fatalf("a string frame id broke timestamp correlation: %+v", ready)
	}
	if got := string(correlator.pruneAndSnapshot(now).FrameID); got != `"a-7"` {
		t.Fatalf("expected the string frame id verbatim, got %q", got)
	}

	oversized := fmt.Sprintf(`{"timestamp":1000,"frame_id":"%s"}`, strings.Repeat("x", maxReportedFrameIDBytes))
	correlator.addMetadata([]byte(oversized), now)
	if got := string(correlator.pruneAndSnapshot(now).FrameID); got != `"a-7"` {
		t.Fatalf("an oversized frame id reached the stats payload: %q", got)
	}
}

// The counters have to reach the endpoint under the documented names, since
// diagnosing a stalled overlay without a packet capture is the whole point.
func TestIngestStatsPublishesCorrelationOutcomes(t *testing.T) {
	const channelIndex = 78
	now := time.Now() // the handler ages the correlator at time.Now()
	correlator := newMetadataTimestampCorrelator(testCorrelatorCapacity, testCorrelatorRetention)
	correlator.addVideoFrame(7, 90000, 400, now)
	correlator.addMetadata([]byte(`{"timestamp":1000,"frame_id":4242}`), now)
	correlator.addMetadata(metadataPayload(3000), now)

	previous := channels[channelIndex]
	channels[channelIndex] = &Channel{
		Port:         9000 + channelIndex,
		Stats:        NewIngestStats(channelIndex, 9000+channelIndex, 9100+channelIndex),
		MetadataSync: correlator,
	}
	t.Cleanup(func() { channels[channelIndex] = previous })

	response := httptest.NewRecorder()
	handleIngestStats(response, httptest.NewRequest(http.MethodGet, "/ingest/stats?all=1", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("expected HTTP 200, got %d: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, key := range []string{"matched_video_first", "matched_metadata_first", "pending_video",
		"pending_metadata", "expired_video", "expired_metadata", "evicted_video",
		"evicted_metadata", "frame_id"} {
		if !strings.Contains(body, `"`+key+`"`) {
			t.Fatalf("ingest stats response is missing %q: %s", key, body)
		}
	}

	var stats IngestStatsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &stats); err != nil {
		t.Fatalf("decode ingest stats: %v", err)
	}
	var metadata MetadataSnapshot
	for _, channel := range stats.Channels {
		if channel.Channel == channelIndex {
			metadata = channel.Metadata
		}
	}
	if metadata.MatchedVideoFirst != 1 || metadata.PendingMetadata != 1 {
		t.Fatalf("correlator counters did not reach the response: %+v", metadata.MetadataCorrelationSnapshot)
	}
	if string(metadata.FrameID) != "4242" {
		t.Fatalf("expected frame id 4242 in the response, got %q", metadata.FrameID)
	}
}

func TestMetadataPeerRegistryRemovesOnlyClosingPeer(t *testing.T) {
	registry := metadataPeerRegistry{}
	first := new(webrtc.DataChannel)
	second := new(webrtc.DataChannel)
	registry.add(1, first)
	registry.add(2, second)

	registry.remove(1, first)
	peers := registry.snapshot()

	if len(peers) != 1 {
		t.Fatalf("expected one remaining metadata peer, got %d", len(peers))
	}
	if peers[0].id != 2 || peers[0].channel != second {
		t.Fatalf("expected the second peer to remain, got %#v", peers[0])
	}
}

func BenchmarkMetadataTimestampCorrelatorBoundedLookup(b *testing.B) {
	correlator := newMetadataTimestampCorrelator(256, 5*time.Second)
	now := time.Unix(100, 0)
	correlator.addVideoFrame(7, 90087, 7000, now)
	for i := uint32(1); i < 256; i++ {
		correlator.addVideoFrame(7, 1_000_000+i*3000, 7000+i, now)
	}
	payload := []byte(
		`{"type":"object-detection","timestamp":1000,"data":{"objects":[{"x":10,"y":20,"width":30,"height":40,"confidence":0.9,"label":"person"}]}}`,
	)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if ready := correlator.addMetadata(payload, now); len(ready) != 1 {
			b.Fatalf("expected one matched metadata message, got %d", len(ready))
		}
	}
}

func BenchmarkMetadataTimestampCorrelatorVideoFrame(b *testing.B) {
	correlator := newMetadataTimestampCorrelator(256, 5*time.Second)
	now := time.Unix(100, 0)

	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		timestamp := uint32(i) * 3000
		correlator.addVideoFrame(7, timestamp, timestamp, now)
	}
}
