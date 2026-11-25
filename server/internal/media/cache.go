package media

import (
	"context"
	"os"
	"sync"
	"time"
)

// Prober probes the file at an absolute path. FFprobe makes the real one; tests pass a fake.
type Prober func(ctx context.Context, abs string) (Info, error)

// FFprobe is the Prober that runs the ffprobe at ffprobePath.
func FFprobe(ffprobePath string) Prober {
	return func(ctx context.Context, abs string) (Info, error) {
		return ProbeFile(ctx, ffprobePath, abs)
	}
}

const (
	// probeWorkers is how many probes run at once: enough that one slow file does not hold up
	// the library, few enough that a large library does not load a board's cores.
	probeWorkers = 2
	// retryFailedAfter is how long a failed probe stands before Want probes the file again: a
	// corrupt file then costs one probe a minute, and a probe that failed under load (a timeout)
	// clears itself.
	retryFailedAfter = time.Minute
)

// Cache keeps what probing said about each file, by its absolute path, for as long as the
// file's size and modification time stay the same. The tree, the slots and auto-assign read
// it, so a file is probed once rather than on every request.
//
// Get never waits for a probe; Want queues one, and a pool of two workers runs the queue.
// The workers exist only while there is work; when ctx ends they stop, a running ffprobe is
// killed, and Want does nothing more.
type Cache struct {
	ctx   context.Context
	probe Prober
	now   func() time.Time

	mu      sync.Mutex
	entries map[string]entry
	pending map[string]bool // queued or being probed
	queue   []string
	workers int
	flights map[string]*flight // the probe running for each file, which every asker waits for
}

// flight is one probe of a version of a file, which Probe's callers and the workers share: a
// burst of requests for a file not probed yet runs one ffprobe.
type flight struct {
	stamp stamp
	done  chan struct{}
	info  Info  // as Get gives it, once done
	err   error // the cache's context ended; set before done is closed
}

// stamp identifies a version of a file's content.
type stamp struct {
	size  int64
	mtime int64 // nanoseconds since the epoch
}

type entry struct {
	stamp  stamp
	info   Info
	failed time.Time // when the probe failed; zero after a success
}

// NewCache makes a cache whose probes run with probe until ctx ends.
func NewCache(ctx context.Context, probe Prober) *Cache {
	return &Cache{
		ctx:     ctx,
		probe:   probe,
		now:     time.Now,
		entries: map[string]entry{},
		pending: map[string]bool{},
		flights: map[string]*flight{},
	}
}

// Get returns what the last probe of the file at abs said, if the file has not changed since.
// A failed probe is an Info of KindUnknown whose Problem says why.
func (c *Cache) Get(abs string) (Info, bool) {
	st, ok := statOf(abs)
	if !ok {
		return Info{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[abs]
	if !ok || e.stamp != st {
		return Info{}, false
	}
	return e.info, true
}

// Want queues a probe of the file at abs unless one is queued or running, the file is gone, or
// the cache holds a result for its current version (a failure only for retryFailedAfter).
func (c *Cache) Want(abs string) {
	if c.ctx.Err() != nil {
		return
	}
	st, ok := statOf(abs)
	if !ok {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pending[abs] {
		return
	}
	if e, ok := c.entries[abs]; ok && e.stamp == st {
		if e.failed.IsZero() || c.now().Sub(e.failed) < retryFailedAfter {
			return
		}
	}
	c.pending[abs] = true
	c.queue = append(c.queue, abs)
	if c.workers < probeWorkers {
		c.workers++
		go c.work()
	}
}

// work probes queued files until the queue is empty or the cache's context ends.
func (c *Cache) work() {
	for {
		abs, ok := c.next()
		if !ok {
			return
		}
		st, exists := statOf(abs)
		if exists {
			<-c.join(abs, st).done
		}
		c.mu.Lock()
		delete(c.pending, abs)
		if !exists {
			delete(c.entries, abs)
		}
		c.mu.Unlock()
	}
}

// Probe returns what probing the file at abs says: the cached answer while the file has not
// changed since (a failure too, as Get gives it), else the answer of a probe it starts at once,
// or of the one already running for that version of the file, and keeps for Get. The probe runs
// under the cache's context, so a caller that stops waiting (its ctx ended) leaves it to the
// others. A failed probe is an Info of KindUnknown whose Problem says why; the error is for a
// file that cannot be read at all, and for ctx or the cache's context ending.
func (c *Cache) Probe(ctx context.Context, abs string) (Info, error) {
	if info, ok := c.Get(abs); ok {
		return info, nil
	}
	st, err := stampOf(abs)
	if err != nil {
		return Info{}, err
	}
	f := c.join(abs, st)
	select {
	case <-f.done:
		return f.info, f.err
	case <-ctx.Done():
		return Info{}, ctx.Err()
	}
}

// join returns the probe of the file at abs as it is at st: the running one, or a new one.
func (c *Cache) join(abs string, st stamp) *flight {
	c.mu.Lock()
	defer c.mu.Unlock()
	if f := c.flights[abs]; f != nil && f.stamp == st {
		return f
	}
	f := &flight{stamp: st, done: make(chan struct{})}
	c.flights[abs] = f
	go func() {
		info, err := c.probe(c.ctx, abs)
		c.mu.Lock()
		if c.ctx.Err() != nil {
			f.err = c.ctx.Err() // stopped, not failed: nothing to remember
		} else {
			f.info = c.storeLocked(abs, st, info, err)
		}
		if c.flights[abs] == f {
			delete(c.flights, abs)
		}
		c.mu.Unlock()
		close(f.done)
	}()
	return f
}

// storeLocked keeps what a probe of the file at abs, as it was at st, said, and returns it as
// Get will.
func (c *Cache) storeLocked(abs string, st stamp, info Info, err error) Info {
	e := entry{stamp: st, info: info}
	if err != nil {
		e.info = Info{Kind: KindUnknown, Size: st.size, Problem: err.Error()}
		e.failed = c.now()
	}
	c.entries[abs] = e
	return e.info
}

// next takes the next queued path, or retires the calling worker when there is none or the
// cache's context has ended.
func (c *Cache) next() (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.queue) == 0 || c.ctx.Err() != nil {
		for _, abs := range c.queue {
			delete(c.pending, abs)
		}
		c.queue = nil
		c.workers--
		return "", false
	}
	abs := c.queue[0]
	c.queue = c.queue[1:]
	return abs, true
}

// statOf is the stamp of the file at abs, following links; false when it cannot be read.
func statOf(abs string) (stamp, bool) {
	st, err := stampOf(abs)
	return st, err == nil
}

// stampOf is the stamp of the file at abs, following links, or why it cannot be read.
func stampOf(abs string) (stamp, error) {
	info, err := os.Stat(abs)
	if err != nil {
		return stamp{}, err
	}
	return stamp{size: info.Size(), mtime: info.ModTime().UnixNano()}, nil
}
