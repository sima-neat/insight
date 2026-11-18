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
		var info Info
		var err error
		if exists {
			info, err = c.probe(c.ctx, abs)
		}
		c.mu.Lock()
		delete(c.pending, abs)
		switch {
		case !exists:
			delete(c.entries, abs)
		case c.ctx.Err() != nil:
			// Stopped, not failed: nothing to remember.
		case err != nil:
			c.entries[abs] = entry{
				stamp:  st,
				info:   Info{Kind: KindUnknown, Size: st.size, Problem: err.Error()},
				failed: c.now(),
			}
		default:
			c.entries[abs] = entry{stamp: st, info: info}
		}
		c.mu.Unlock()
	}
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
	info, err := os.Stat(abs)
	if err != nil {
		return stamp{}, false
	}
	return stamp{size: info.Size(), mtime: info.ModTime().UnixNano()}, true
}
