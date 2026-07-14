package main

import (
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestMetadataForwardQueueDropsOldestOnOverflow(t *testing.T) {
	queue := newMetadataForwardQueue(3)

	for i := 1; i <= 4; i++ {
		dropped := queue.enqueue(correlatedMetadata{payload: []byte(strconv.Itoa(i))})
		if dropped != (i == 4) {
			t.Fatalf("enqueue %d: expected dropped=%t, got %t", i, i == 4, dropped)
		}
	}

	for _, want := range []string{"2", "3", "4"} {
		if got := string(queue.dequeue().payload); got != want {
			t.Fatalf("expected payload %q, got %q", want, got)
		}
	}
}

func TestMetadataForwardQueueAcceptsConcurrentProducers(t *testing.T) {
	const (
		producerCount       = 8
		messagesPerProducer = 128
		messageCount        = producerCount * messagesPerProducer
	)
	queue := newMetadataForwardQueue(messageCount)
	received := make(chan string, messageCount)
	go func() {
		for range messageCount {
			received <- string(queue.dequeue().payload)
		}
	}()

	var producers sync.WaitGroup
	producers.Add(producerCount)
	for producer := 0; producer < producerCount; producer++ {
		go func() {
			defer producers.Done()
			for sequence := 0; sequence < messagesPerProducer; sequence++ {
				payload := strconv.Itoa(producer*messagesPerProducer + sequence)
				if queue.enqueue(correlatedMetadata{payload: []byte(payload)}) {
					t.Errorf("unexpected overflow for payload %s", payload)
				}
			}
		}()
	}
	producers.Wait()

	seen := make(map[string]struct{}, messageCount)
	for range messageCount {
		payload := <-received
		if _, exists := seen[payload]; exists {
			t.Fatalf("received duplicate payload %s", payload)
		}
		seen[payload] = struct{}{}
	}
	if len(seen) != messageCount {
		t.Fatalf("expected %d payloads, got %d", messageCount, len(seen))
	}
}

func TestEnqueueMetadataRecordsEvictedMessage(t *testing.T) {
	ch := &Channel{
		MetadataReady: newMetadataForwardQueue(1),
		Stats:         NewIngestStats(0, 9000, 9100),
	}

	enqueueMetadata(ch, correlatedMetadata{payload: []byte("old")})
	enqueueMetadata(ch, correlatedMetadata{payload: []byte("new")})

	snapshot := ch.Stats.Snapshot(false, false, time.Now())
	if snapshot.Metadata.DroppedQueueFull != 1 {
		t.Fatalf("expected one queue eviction, got %d", snapshot.Metadata.DroppedQueueFull)
	}
	if got := string(ch.MetadataReady.dequeue().payload); got != "new" {
		t.Fatalf("expected newest metadata to remain, got %q", got)
	}
}
