package main

import (
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
