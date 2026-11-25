package channels

import (
	"errors"
	"io"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// queueLength bounds the messages waiting for the browsers of one channel; a full queue drops
// its oldest, since a late overlay is worth less than the next one.
const queueLength = 16

// A Channel is one tile of the Viewer: an app's video on UDP 9000+N and its metadata on 9100+N,
// sent on to every browser watching N.
type Channel struct {
	index int
	stats stats
	media atomic.Pointer[media]
	corr  correlator
	queue chan outbound
	views viewers

	// Owned by the video reader.
	assembler      *assembler
	assemblerMedia *media
	assemblerIdle  uint64
	line           timeline
	seq            sequencer

	// Owned by the metadata reader.
	joiner *reassembler
}

func newChannel(index int) *Channel {
	return &Channel{index: index, queue: make(chan outbound, queueLength), line: newTimeline(), joiner: newReassembler()}
}

// video takes one RTP datagram, raw, which the channel keeps (the reader hands over a copy).
func (c *Channel) video(raw []byte, from netip.AddrPort, now time.Time) {
	var packet rtp.Packet
	if err := packet.Unmarshal(raw); err != nil {
		c.stats.count(func(s *stats) { s.video.malformed++ })
		c.stats.failed("a malformed RTP packet of %d bytes from %s: %v", len(raw), from, err)
		return
	}
	codec := codecOf(packet.PayloadType)
	c.stats.videoPacket(codec, packet.PayloadType, packet.SSRC, packet.Timestamp, packet.Payload, len(raw), from, now)
	if codec == CodecNone {
		return
	}
	m, err := c.publish(codec)
	if err != nil {
		c.stats.failed("starting %s media: %v", codec, err)
		return
	}
	if m != c.assemblerMedia {
		c.assembler, c.assemblerMedia, c.assemblerIdle = newAssembler(), m, m.track.idle.Load()
	} else if idle := m.track.idle.Load(); idle != c.assemblerIdle {
		// Everyone left and someone came back between two packets: start them at a keyframe.
		c.assembler.rearm()
		c.assemblerIdle = idle
	}
	unit, ready, oversized := c.assembler.accept(&packet, raw)
	if oversized {
		c.stats.count(func(s *stats) { s.video.oversized++ })
		c.stats.failed("dropped a frame over %d MiB from %s", maxUnitBytes>>20, from)
	}
	if m.track.bindings.Load() == 0 {
		if ready {
			c.assembler.rearm()
		}
		return
	}
	if !ready {
		return
	}
	outgoing := c.line.frame(unit.timestamp, unit.ssrc, unit.afterSequenceBreak, now)
	sent := false
	for _, raw := range unit.packets {
		if err := c.seq.stamp(raw, outgoing); err != nil {
			continue // accept parsed it, so it has a header
		}
		if _, err := m.track.Write(raw); err != nil && !errors.Is(err, io.ErrClosedPipe) {
			c.stats.failed("sending video: %v", err)
			continue
		}
		sent = true
	}
	if !sent {
		return
	}
	for _, out := range c.corr.frame(unit.ssrc, unit.timestamp, outgoing, now) {
		c.enqueue(out)
	}
}

// publish returns the media generation for codec, starting a new one when the codec changed.
func (c *Channel) publish(codec Codec) (*media, error) {
	current := c.media.Load()
	if current != nil && current.codec == codec {
		return current, nil
	}
	next, err := newMedia(codec)
	if err != nil {
		return nil, err
	}
	c.media.Store(next)
	if current != nil {
		current.retire()
	}
	return next, nil
}

// metadata takes one metadata datagram; buf is the reader's and reused after the call.
func (c *Channel) metadata(buf []byte, from netip.AddrPort, now time.Time) {
	result := c.joiner.accept(buf, from, now)
	if !result.complete {
		return
	}
	raw := result.message
	if !result.reassembled {
		raw = append([]byte(nil), raw...) // it is the reader's buffer
	}
	msg, err := parseMessage(raw)
	c.stats.metadataMessage(len(raw), err == nil, from, now)
	if err != nil {
		return
	}
	if c.views.count() == 0 {
		return // no browser to draw it, so it does not wait for a frame
	}
	if !msg.timed {
		c.enqueue(outbound{msg: msg})
		return
	}
	if out, ok := c.corr.message(msg, now); ok {
		c.enqueue(out)
	}
}

func (c *Channel) enqueue(out outbound) {
	for {
		select {
		case c.queue <- out:
			return
		default:
		}
		select {
		case <-c.queue:
		default:
		}
	}
}

// deliver sends queued messages to the channel's browsers until done is closed.
func (c *Channel) deliver(done <-chan struct{}) {
	for {
		select {
		case out := <-c.queue:
			c.send(out)
		case <-done:
			return
		}
	}
}

func (c *Channel) send(out outbound) {
	payload, err := out.encode()
	if err != nil {
		return // parsed once already, so encoding it again cannot fail
	}
	text, sent := string(payload), false
	for _, dc := range c.views.list() {
		if dc.ReadyState() != webrtc.DataChannelStateOpen {
			continue
		}
		if err := dc.SendText(text); err != nil {
			c.stats.failed("sending metadata to a browser: %v", err)
			c.views.remove(dc)
			continue
		}
		sent = true
	}
	if sent {
		c.stats.count(func(s *stats) { s.metadata.forwarded++ })
	}
}

// viewers are the metadata DataChannels open to the channel's browsers.
type viewers struct {
	mu  sync.Mutex
	dcs map[*webrtc.DataChannel]struct{}
}

func (v *viewers) add(dc *webrtc.DataChannel) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.dcs == nil {
		v.dcs = map[*webrtc.DataChannel]struct{}{}
	}
	v.dcs[dc] = struct{}{}
}

func (v *viewers) remove(dc *webrtc.DataChannel) {
	v.mu.Lock()
	delete(v.dcs, dc)
	v.mu.Unlock()
}

func (v *viewers) count() int {
	v.mu.Lock()
	defer v.mu.Unlock()
	return len(v.dcs)
}

func (v *viewers) list() []*webrtc.DataChannel {
	v.mu.Lock()
	defer v.mu.Unlock()
	list := make([]*webrtc.DataChannel, 0, len(v.dcs))
	for dc := range v.dcs {
		list = append(list, dc)
	}
	return list
}
