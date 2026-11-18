package channels

import (
	"sync"
	"time"
)

const (
	// matchTolerance: a message's timestamp is whole milliseconds, so timestamp × 90 lands up
	// to 89 ticks short of its frame's RTP time; 90 ticks (1 ms) covers that and never reaches
	// a neighboring frame.
	matchTolerance = uint32(clockRate / 1000)
	// correlationCapacity and correlationRetention bound both sides: at about 100 messages a
	// second (measured on a DevKit) 256 entries hold 2.5 s.
	correlationCapacity  = 256
	correlationRetention = 5 * time.Second
)

// outbound is a message ready for the browser.
type outbound struct {
	msg      message
	outgoing uint32 // the matched frame's outgoing RTP time
	matched  bool
}

func (o outbound) encode() ([]byte, error) {
	if o.matched {
		return o.msg.forMatched(o.outgoing)
	}
	return o.msg.forUnmatched()
}

type frameStamp struct {
	source, outgoing uint32
	at               time.Time
}

type pendingMessage struct {
	msg message
	at  time.Time
}

// correlationCounts says what became of timed messages.
type correlationCounts struct {
	Matched uint64 // drawn on their frame
	// Unmatched waited the whole retention for a frame (wrong unit or clock, or the video
	// stopped) or were pushed out by newer ones.
	Unmatched uint64
	Pending   uint64
}

// correlator pairs each timed message with the frame it names, whichever arrives first: a frame
// is kept for messages still to come, a message waits for its frame. Both sides hold at most
// correlationCapacity entries for correlationRetention, oldest first.
type correlator struct {
	mu      sync.Mutex
	ssrc    uint32
	hasSSRC bool
	frames  []frameStamp
	pending []pendingMessage
	counts  correlationCounts
}

// frame records a frame sent with outgoing for source, and returns the messages waiting for it.
func (c *correlator) frame(ssrc, source, outgoing uint32, now time.Time) []outbound {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prune(now)
	if c.hasSSRC && ssrc != c.ssrc {
		// A new sender's timestamps start anywhere: an old entry could match the wrong frame.
		c.counts.Unmatched += uint64(len(c.pending))
		c.frames, c.pending = c.frames[:0], c.pending[:0]
	}
	c.ssrc, c.hasSSRC = ssrc, true
	if len(c.frames) == correlationCapacity {
		c.frames = append(c.frames[:0], c.frames[1:]...)
	}
	c.frames = append(c.frames, frameStamp{source, outgoing, now})

	var ready []outbound
	kept := c.pending[:0]
	for _, p := range c.pending {
		if distance(p.msg.stamp, source) <= matchTolerance {
			ready = append(ready, outbound{msg: p.msg, outgoing: outgoing, matched: true})
			continue
		}
		kept = append(kept, p)
	}
	c.pending = kept
	c.counts.Matched += uint64(len(ready))
	return ready
}

// message takes a timed message: it is ready at once when its frame was sent, and waits
// otherwise.
func (c *correlator) message(msg message, now time.Time) (outbound, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prune(now)
	if frame, ok := c.closest(msg.stamp); ok {
		c.counts.Matched++
		return outbound{msg: msg, outgoing: frame.outgoing, matched: true}, true
	}
	if len(c.pending) == correlationCapacity {
		c.pending = append(c.pending[:0], c.pending[1:]...)
		c.counts.Unmatched++
	}
	c.pending = append(c.pending, pendingMessage{msg, now})
	return outbound{}, false
}

func (c *correlator) snapshot(now time.Time) correlationCounts {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prune(now)
	counts := c.counts
	counts.Pending = uint64(len(c.pending))
	return counts
}

// closest is the newest-first nearest frame within the tolerance.
func (c *correlator) closest(stamp uint32) (frameStamp, bool) {
	best, found := frameStamp{}, false
	bestDistance := matchTolerance + 1
	for i := len(c.frames) - 1; i >= 0; i-- {
		if d := distance(c.frames[i].source, stamp); d < bestDistance {
			best, bestDistance, found = c.frames[i], d, true
		}
	}
	return best, found
}

// prune drops what is older than the retention; both sides are in arrival order.
func (c *correlator) prune(now time.Time) {
	first := 0
	for first < len(c.frames) && now.Sub(c.frames[first].at) > correlationRetention {
		first++
	}
	c.frames = append(c.frames[:0], c.frames[first:]...)
	first = 0
	for first < len(c.pending) && now.Sub(c.pending[first].at) > correlationRetention {
		first++
	}
	c.counts.Unmatched += uint64(first)
	c.pending = append(c.pending[:0], c.pending[first:]...)
}

// distance is how far apart two RTP times are, across the 32-bit wrap.
func distance(a, b uint32) uint32 {
	d := int32(a - b)
	if d < 0 {
		return uint32(-int64(d))
	}
	return uint32(d)
}
