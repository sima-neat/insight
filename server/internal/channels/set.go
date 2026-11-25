// Package channels is the Viewer's path: each channel takes an app's video (RTP on UDP 9000+N)
// and metadata (JSON on UDP 9100+N), matches the metadata to its frames, and sends both to the
// browsers watching it over WebRTC (docs/contracts.md, "Channels" and "Metadata").
package channels

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"sync"
	"time"
)

// Options configure a Set.
type Options struct {
	// Count is how many channels to serve, 0 to Count-1.
	Count int
	// VideoBase and MetadataBase are the UDP ports of channel 0 (9000 and 9100); channel N is
	// at base+N. 0 binds free ports instead (tests).
	VideoBase, MetadataBase int
	// Address is the address the UDP sockets bind; empty is every interface.
	Address string
	// WebRTCPortStart and WebRTCPortEnd bound the ports browsers receive media from.
	WebRTCPortStart, WebRTCPortEnd uint16
	// ICEAddress, when set, is the only address offered to browsers for media (the SDK's host
	// address, as the container's own is not reachable from the browser).
	ICEAddress string
}

// receiveBuffer is each video socket's kernel buffer: a keyframe arrives as a burst.
const receiveBuffer = 2 << 20

// Set is every channel Insight serves.
type Set struct {
	channels   []*Channel
	negotiator *negotiator
	sockets    []*net.UDPConn
	ports      []channelPorts
	wg         sync.WaitGroup
}

type channelPorts struct{ video, metadata int }

// Listen binds every channel's sockets, failing when one is taken, and starts reading them
// until ctx ends; Wait returns when every reader has stopped.
func Listen(ctx context.Context, opts Options) (*Set, error) {
	if opts.Count < 1 {
		return nil, errors.New("no channels to serve")
	}
	negotiator, err := newNegotiator(opts.WebRTCPortStart, opts.WebRTCPortEnd, opts.ICEAddress)
	if err != nil {
		return nil, err
	}
	s := &Set{negotiator: negotiator}
	bind := func(base, index int) (*net.UDPConn, int, error) {
		port := 0
		if base != 0 {
			port = base + index
		}
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP(opts.Address), Port: port})
		if err != nil {
			return nil, 0, fmt.Errorf("UDP port %d of channel %d is taken or cannot be bound: %w", port, index, err)
		}
		return conn, conn.LocalAddr().(*net.UDPAddr).Port, nil
	}
	for i := range opts.Count {
		video, videoPort, err := bind(opts.VideoBase, i)
		if err != nil {
			s.closeSockets()
			return nil, err
		}
		s.sockets = append(s.sockets, video)
		if err := video.SetReadBuffer(receiveBuffer); err != nil {
			slog.Warn("a small UDP buffer", "port", videoPort, "error", err)
		}
		metadata, metadataPort, err := bind(opts.MetadataBase, i)
		if err != nil {
			s.closeSockets()
			return nil, err
		}
		s.sockets = append(s.sockets, metadata)
		s.channels = append(s.channels, newChannel(i))
		s.ports = append(s.ports, channelPorts{videoPort, metadataPort})
	}
	done := ctx.Done()
	for i, c := range s.channels {
		video, metadata := s.sockets[2*i], s.sockets[2*i+1]
		s.wg.Add(3)
		go func() { defer s.wg.Done(); read(video, c.video, true) }()
		go func() { defer s.wg.Done(); read(metadata, c.metadata, false) }()
		go func() { defer s.wg.Done(); c.deliver(done) }()
	}
	go func() {
		<-done
		s.closeSockets()
	}()
	return s, nil
}

// Wait returns once every reader has stopped.
func (s *Set) Wait() { s.wg.Wait() }

func (s *Set) closeSockets() {
	for _, conn := range s.sockets {
		conn.Close()
	}
}

// read hands each datagram to take until the socket closes. Video datagrams are copied, since
// the channel keeps them until their frame is whole; metadata is read from the buffer.
func read(conn *net.UDPConn, take func([]byte, netip.AddrPort, time.Time), copyEach bool) {
	buf := make([]byte, 65536)
	for {
		n, from, err := conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		datagram := buf[:n]
		if copyEach {
			datagram = append([]byte(nil), datagram...)
		}
		take(datagram, from, time.Now())
	}
}

// Ports are channel index's UDP ports.
func (s *Set) Ports(index int) (video, metadata int) {
	return s.ports[index].video, s.ports[index].metadata
}

// Offer answers a browser's offer to watch channel index.
func (s *Set) Offer(ctx context.Context, index int, offer Description) (Description, error) {
	if index < 0 || index >= len(s.channels) {
		return Description{}, errNoChannel
	}
	return s.negotiator.answer(ctx, s.channels[index], offer)
}

// State is a channel's state at one moment, for the API.
type State struct {
	Channel                 int
	VideoPort, MetadataPort int
	Video                   VideoState
	Metadata                MetadataState
	// Viewers are the browsers connected to the channel's video.
	Viewers int
	// Errors are the latest problems, oldest first, each with its time.
	Errors []string
}

// VideoState is what arrived on a channel's video port.
type VideoState struct {
	Active                     bool
	First, Last                time.Time
	Remote                     string
	SSRC                       uint32
	PayloadType                uint8
	Codec                      string // "H264", "H265", "JPEG", or "" before any or for another payload type
	Packets, Bytes             uint64
	PacketsPerSecond, BitsPerS float64
	Keyframes                  uint64
	SeenSPS                    bool
	Unsupported, Malformed     uint64
	// Oversized are the frames dropped for growing over the cap of one frame's bytes.
	Oversized uint64
	// Incomplete are the frames withheld because a packet was lost, the first one included.
	Incomplete uint64
}

// MetadataState is what arrived on a channel's metadata port and what became of it.
type MetadataState struct {
	Active                    bool
	First, Last               time.Time
	Remote                    string
	Received, Bytes           uint64
	MessagesPerSecond, BitsPS float64
	Invalid                   uint64
	// Forwarded are the messages sent to at least one browser: untimed ones at once, timed ones
	// once matched to their frame.
	Forwarded uint64
}

// States are every channel's state now.
func (s *Set) States(now time.Time) []State {
	states := make([]State, len(s.channels))
	for i, c := range s.channels {
		states[i] = c.state(now)
		states[i].VideoPort, states[i].MetadataPort = s.ports[i].video, s.ports[i].metadata
	}
	return states
}

func (c *Channel) state(now time.Time) State {
	viewers := 0
	if m := c.media.Load(); m != nil {
		viewers = m.viewers()
	}
	c.stats.mu.Lock()
	defer c.stats.mu.Unlock()
	v, m := &c.stats.video, &c.stats.metadata
	state := State{Channel: c.index, Viewers: viewers, Errors: append([]string(nil), c.stats.errors...)}

	videoActive := !v.last.IsZero() && now.Sub(v.last) <= activeFor
	packetRate, bitRate := v.rate.at(videoActive)
	state.Video = VideoState{
		Active: videoActive, First: v.first, Last: v.last, Remote: addressText(v.remote),
		SSRC: v.ssrc, PayloadType: v.payloadType, Codec: v.codec.String(),
		Packets: v.packets, Bytes: v.bytes, PacketsPerSecond: packetRate, BitsPerS: bitRate,
		Keyframes: v.keyframes, SeenSPS: v.seenSPS, Unsupported: v.unsupported, Malformed: v.malformed,
		Oversized: v.oversized, Incomplete: v.incomplete,
	}
	metadataActive := !m.last.IsZero() && now.Sub(m.last) <= activeFor
	messageRate, metadataBits := m.rate.at(metadataActive)
	state.Metadata = MetadataState{
		Active: metadataActive, First: m.first, Last: m.last, Remote: addressText(m.remote),
		Received: m.received, Bytes: m.bytes, MessagesPerSecond: messageRate, BitsPS: metadataBits,
		Invalid: m.invalid, Forwarded: m.forwarded,
	}
	return state
}

func addressText(address netip.AddrPort) string {
	if !address.IsValid() {
		return ""
	}
	return address.String()
}
