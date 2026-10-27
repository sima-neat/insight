package main

import (
	"encoding/binary"
	"log"
	"sync"

	"github.com/pion/webrtc/v4"
)

type metadataPeer struct {
	id      uint64
	channel *webrtc.DataChannel
}

type metadataPeerRegistry struct {
	mu    sync.RWMutex
	peers map[uint64]*webrtc.DataChannel
}

type metadataForwardQueue struct {
	mu       sync.Mutex
	notEmpty *sync.Cond
	items    []correlatedMetadata
	head     int
	size     int
}

func newMetadataForwardQueue(capacity int) *metadataForwardQueue {
	queue := &metadataForwardQueue{
		items: make([]correlatedMetadata, capacity),
	}
	queue.notEmpty = sync.NewCond(&queue.mu)
	return queue
}

func (q *metadataForwardQueue) enqueue(metadata correlatedMetadata) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	dropped := q.size == len(q.items)
	if dropped {
		q.items[q.head] = metadata
		q.head = (q.head + 1) % len(q.items)
	} else {
		index := (q.head + q.size) % len(q.items)
		q.items[index] = metadata
		q.size++
	}
	q.notEmpty.Signal()
	return dropped
}

func (q *metadataForwardQueue) dequeue() correlatedMetadata {
	q.mu.Lock()
	defer q.mu.Unlock()

	for q.size == 0 {
		q.notEmpty.Wait()
	}
	metadata := q.items[q.head]
	q.items[q.head] = correlatedMetadata{}
	q.head = (q.head + 1) % len(q.items)
	q.size--
	return metadata
}

func (r *metadataPeerRegistry) add(peerID uint64, channel *webrtc.DataChannel) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.peers == nil {
		r.peers = make(map[uint64]*webrtc.DataChannel)
	}
	r.peers[peerID] = channel
}

func (r *metadataPeerRegistry) remove(peerID uint64, channel *webrtc.DataChannel) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.peers[peerID] == channel {
		delete(r.peers, peerID)
	}
}

func (r *metadataPeerRegistry) snapshot() []metadataPeer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	peers := make([]metadataPeer, 0, len(r.peers))
	for id, channel := range r.peers {
		peers = append(peers, metadataPeer{id: id, channel: channel})
	}
	return peers
}

func (r *metadataPeerRegistry) len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.peers)
}

func enqueueMetadata(ch *Channel, metadata correlatedMetadata) {
	if ch.MetadataReady.enqueue(metadata) {
		ch.Stats.RecordMetadataDroppedQueueFull()
	}
}

func startMetadataForwarder(ch *Channel) {
	for {
		forwardMetadata(ch, ch.MetadataReady.dequeue())
	}
}

func forwardMetadata(ch *Channel, metadata correlatedMetadata) {
	payload, err := metadata.encode()
	if err != nil {
		return
	}
	peers := ch.MetadataPeers.snapshot()
	if len(peers) == 0 {
		ch.Stats.RecordMetadataDroppedNoDataChannel()
		ch.Egress.RecordMetadataDroppedNoDataChannel()
		return
	}

	message := string(payload)
	forwarded := false
	for _, peer := range peers {
		if peer.channel.ReadyState() != webrtc.DataChannelStateOpen {
			continue
		}
		if sendErr := peer.channel.SendText(message); sendErr != nil {
			ch.Stats.RecordMetadataSendError(sendErr)
			ch.Egress.RecordMetadataSendError(peer.id, sendErr)
			ch.MetadataPeers.remove(peer.id, peer.channel)
			ch.Egress.UpdateDataChannelState(peer.id, "failed")
			log.Printf("[Channel %d] metadata send failed for peer %d: %v", ch.Port-9000, peer.id, sendErr)
			continue
		}
		ch.Egress.RecordMetadataSent(peer.id, len(payload))
		forwarded = true
	}

	if forwarded {
		ch.Stats.RecordMetadataForwarded(len(payload))
		return
	}
	// No peer took the message, and a peer whose send failed was removed above.
	// Counting it here is what keeps every received message attributable to
	// exactly one outcome; send_errors stays the per-peer diagnostic.
	ch.Stats.RecordMetadataDroppedNoDataChannel()
	ch.Egress.RecordMetadataDroppedNoDataChannel()
}

const (
	jpegChunkBytes = 60000
	// About two 1080p frames. A viewer further behind than this skips frames
	// rather than queueing them, so its picture stays current.
	jpegMaxBufferedBytes = 512 << 10
)

// jpegFrameMessages splits a frame into DataChannel messages, each a header of
// rtp_timestamp (u32, the value metadata carries as _insight.rtp_timestamp),
// chunk_index (u16) and chunk_count (u16), all big-endian, then the chunk.
func jpegFrameMessages(timestamp uint32, jpeg []byte) [][]byte {
	count := (len(jpeg) + jpegChunkBytes - 1) / jpegChunkBytes
	messages := make([][]byte, 0, count)
	for index := 0; index < count; index++ {
		chunk := jpeg[index*jpegChunkBytes : min((index+1)*jpegChunkBytes, len(jpeg))]
		message := binary.BigEndian.AppendUint32(make([]byte, 0, 8+len(chunk)), timestamp)
		message = binary.BigEndian.AppendUint16(message, uint16(index))
		message = binary.BigEndian.AppendUint16(message, uint16(count))
		messages = append(messages, append(message, chunk...))
	}
	return messages
}

// sendJPEGFrame reports whether any viewer took the frame.
func sendJPEGFrame(ch *Channel, timestamp uint32, jpeg []byte) bool {
	messages := jpegFrameMessages(timestamp, jpeg)
	sent, backpressured := false, false
	for _, peer := range ch.FramePeers.snapshot() {
		if peer.channel.ReadyState() != webrtc.DataChannelStateOpen {
			continue
		}
		if peer.channel.BufferedAmount() > jpegMaxBufferedBytes {
			ch.Egress.RecordJPEGDroppedBackpressure(peer.id)
			backpressured = true
			continue
		}
		var sendErr error
		for _, message := range messages {
			if sendErr = peer.channel.Send(message); sendErr != nil {
				break
			}
		}
		if sendErr != nil {
			ch.Stats.RecordJPEGSendError(sendErr)
			ch.Egress.RecordJPEGSendError(peer.id, sendErr)
			ch.FramePeers.remove(peer.id, peer.channel)
			ch.Egress.UpdateJPEGState(peer.id, "failed")
			log.Printf("[Channel %d] jpeg send failed for peer %d: %v", ch.Port-9000, peer.id, sendErr)
			continue
		}
		ch.Egress.RecordJPEGSent(peer.id, len(jpeg))
		sent = true
	}
	if !sent && backpressured {
		ch.Stats.RecordJPEGFrameDroppedBackpressure()
	}
	return sent
}
