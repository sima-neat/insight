// Package relay serves MJPEG streams over HTTP with one producer per stream however many
// readers watch it: the slot previews, a slot's HTTP MJPEG output and the library's file
// previews.
//
// A stream is named by a key (a slot, a file). Its first reader starts its producer, an ffmpeg
// writing MJPEG to its stdout; every reader gets the latest picture, so a slow one skips
// pictures and holds back neither the producer nor the other readers. The producer runs on for
// a few seconds after the last reader leaves, so a reader that comes back finds it running, and
// is stopped then. A stream that sends no picture for a while is ended with its readers.
package relay

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"insight/internal/apierr"
)

// Options configure the relays.
type Options struct {
	// MaxRelays is how many streams may run at once, stopping ones included until their
	// producer has exited. A reader of a further stream is answered 429; readers of a running
	// stream are not counted.
	MaxRelays int
	// IdleStop is how long a stream's producer runs on after its last reader left.
	IdleStop time.Duration
	// StallTimeout ends a stream whose producer sent no picture for this long (the first one
	// included), with its readers' responses, and drops a reader that has not taken a picture
	// for this long.
	StallTimeout time.Duration
	// Start makes the producer of key's stream from source: a command, not started, that writes
	// MJPEG in ffmpeg's mpjpeg format to its stdout (`-f mpjpeg pipe:1`). Its Stdout and Stderr
	// stay unset: the relay reads them, runs the command in a process group of its own and
	// stops the group.
	Start func(key, source string) (*exec.Cmd, error)
}

// Relays runs the streams; it is safe for concurrent use.
type Relays struct {
	opts Options

	mu      sync.Mutex
	streams map[string]*stream // the running streams by key; a stopping one is no longer here
	live    int                // streams whose producer has not exited, for the cap
	closed  bool
	running sync.WaitGroup // one per live stream
}

// The reasons a stream ends.
var (
	errStalled = errors.New("no picture within the stall timeout")
	errIdle    = errors.New("no readers")
	errClosed  = errors.New("the relays are closed")
	errExited  = errors.New("the producer exited")
)

// stream is one key's producer and the latest picture it sent.
type stream struct {
	key string

	// Guarded by Relays.mu.
	readers int
	idle    *time.Timer // the stop after the last reader left, while one is pending

	mu     sync.Mutex
	proc   *producer
	part   []byte        // the latest picture as a part of the response, nil before the first
	seq    uint64        // counts the pictures
	next   chan struct{} // closed when the next picture replaces part
	done   chan struct{} // closed when the stream has ended
	reason error         // why it ended
	detail string        // the producer's last stderr line, or why it could not start
}

// New makes the relays.
func New(opts Options) (*Relays, error) {
	switch {
	case opts.MaxRelays < 1:
		return nil, errors.New("relay: MaxRelays must be at least 1")
	case opts.IdleStop < 0:
		return nil, errors.New("relay: IdleStop must not be negative")
	case opts.StallTimeout <= 0:
		return nil, errors.New("relay: StallTimeout must be positive")
	case opts.Start == nil:
		return nil, errors.New("relay: Start is required")
	}
	return &Relays{opts: opts, streams: map[string]*stream{}}, nil
}

// Serve answers req with key's stream as multipart/x-mixed-replace, starting it from source when
// it is not running (a reader that joins a running stream gets it whatever its source). The
// response begins with the stream's first picture; a stream that ends before one is answered
// with the API's error shape. Serve returns when the reader leaves, the stream ends or the
// relays close.
func (r *Relays) Serve(w http.ResponseWriter, req *http.Request, key, source string) {
	s, refused := r.join(key, source)
	if refused != nil {
		apierr.Write(w, refused.status, refused.code, refused.message, refused.hint)
		return
	}
	defer r.leave(s)

	control := http.NewResponseController(w)
	var sent uint64
	for {
		s.mu.Lock()
		part, seq, next, ended := s.part, s.seq, s.next, s.reason != nil
		s.mu.Unlock()
		if ended {
			if sent == 0 {
				s.writeFailure(w)
			}
			return
		}
		if seq != sent {
			if sent == 0 {
				w.Header().Set("Content-Type", ContentType)
				w.Header().Set("Cache-Control", "no-store, max-age=0")
				w.WriteHeader(http.StatusOK)
				if _, err := io.WriteString(w, openingBoundary); err != nil {
					return
				}
			}
			// A reader that cannot take one picture within the stall timeout is gone (a peer
			// that vanished without closing): its write fails and it leaves.
			_ = control.SetWriteDeadline(time.Now().Add(r.opts.StallTimeout))
			if _, err := w.Write(part); err != nil {
				return
			}
			if err := control.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
				return
			}
			_ = control.SetWriteDeadline(time.Time{}) // waiting for the next picture has none
			sent = seq
			continue
		}
		select {
		case <-next:
		case <-s.done:
		case <-req.Context().Done():
			return
		}
	}
}

// Close ends every stream and returns once their producers have exited. Serve refuses
// readers after it.
func (r *Relays) Close() {
	r.mu.Lock()
	r.closed = true
	streams := make([]*stream, 0, len(r.streams))
	for _, s := range r.streams {
		streams = append(streams, s)
	}
	r.mu.Unlock()
	for _, s := range streams {
		r.end(s, errClosed)
	}
	r.running.Wait()
}

// refusal is a reader turned away before its response began.
type refusal struct {
	status              int
	code, message, hint string
}

// join adds a reader to key's stream, starting the stream when it is not running.
func (r *Relays) join(key, source string) (*stream, *refusal) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, &refusal{status: http.StatusServiceUnavailable, code: "shutting_down",
			message: "Insight is shutting down."}
	}
	s := r.streams[key]
	starting := s == nil
	if starting {
		if r.live >= r.opts.MaxRelays {
			r.mu.Unlock()
			return nil, &refusal{status: http.StatusTooManyRequests, code: "too_many_streams",
				message: fmt.Sprintf("%d MJPEG streams are open already.", r.opts.MaxRelays),
				hint:    "Close a preview, then try again."}
		}
		s = &stream{key: key, next: make(chan struct{}), done: make(chan struct{})}
		r.streams[key] = s
		r.live++
		r.running.Add(1)
	}
	s.readers++
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	r.mu.Unlock()
	if starting {
		r.start(s, source)
	}
	return s, nil
}

// leave removes a reader; the last one leaving schedules the producer's stop.
func (r *Relays) leave(s *stream) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s.readers--
	if s.readers > 0 || r.streams[s.key] != s {
		return
	}
	var timer *time.Timer
	timer = time.AfterFunc(r.opts.IdleStop, func() {
		r.mu.Lock()
		if s.idle != timer { // a reader came back, or the stream ended meanwhile
			r.mu.Unlock()
			return
		}
		s.idle = nil
		delete(r.streams, s.key) // from here on no reader can join it
		r.mu.Unlock()
		r.end(s, errIdle)
	})
	s.idle = timer
}

// start runs s's producer, outside the lock: making the command may take a moment.
func (r *Relays) start(s *stream, source string) {
	cmd, err := r.opts.Start(s.key, source)
	var proc *producer
	if err == nil {
		proc, err = startProducer(cmd)
	}
	if err != nil {
		slog.Warn("an MJPEG stream could not start", "key", s.key, "error", err)
		s.mu.Lock()
		s.detail = err.Error()
		s.mu.Unlock()
		r.end(s, fmt.Errorf("starting the producer: %w", err))
		r.finished()
		return
	}
	s.mu.Lock()
	s.proc = proc
	ended := s.reason != nil // Close came first
	s.mu.Unlock()
	if ended {
		proc.stop()
	}
	go r.run(s, proc)
}

// run reads the producer's pictures until its output ends, then waits for it to exit.
func (r *Relays) run(s *stream, proc *producer) {
	defer r.finished()
	stall := time.AfterFunc(r.opts.StallTimeout, func() { r.end(s, errStalled) })
	err := readFrames(proc.stdout, func(jpeg []byte) {
		stall.Reset(r.opts.StallTimeout)
		s.publish(appendPart(nil, jpeg))
	})
	stall.Stop()
	proc.stop() // a producer that closed its output but runs on is done too
	<-proc.exited

	lines := proc.stderr.last()
	s.mu.Lock()
	if len(lines) > 0 {
		s.detail = lines[len(lines)-1]
	}
	s.mu.Unlock()
	if err != nil {
		err = fmt.Errorf("reading its output: %w", err)
	} else {
		err = fmt.Errorf("%w: %s", errExited, proc.exitText())
	}
	r.end(s, err) // the first reason stands: a stall or a stop ended it before the exit
	s.mu.Lock()
	reason := s.reason
	s.mu.Unlock()
	if !errors.Is(reason, errIdle) && !errors.Is(reason, errClosed) {
		slog.Warn("an MJPEG stream ended", "key", s.key, "reason", reason,
			"exit", proc.exitText(), "stderr", strings.Join(lines, " | "))
	}
}

// end ends s for reason, unless it has ended already: its readers' responses end, its
// producer is stopped, and the next reader of its key starts a new one.
func (r *Relays) end(s *stream, reason error) {
	r.mu.Lock()
	if r.streams[s.key] == s {
		delete(r.streams, s.key)
	}
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	r.mu.Unlock()

	s.mu.Lock()
	if s.reason != nil {
		s.mu.Unlock()
		return
	}
	s.reason = reason
	close(s.done)
	proc := s.proc
	s.mu.Unlock()
	if proc != nil {
		proc.stop()
	}
}

// finished counts a stream whose producer has exited, or never started, out of the cap.
func (r *Relays) finished() {
	r.mu.Lock()
	r.live--
	r.mu.Unlock()
	r.running.Done()
}

// publish makes part the latest picture and wakes the readers waiting for one.
func (s *stream) publish(part []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.part = part
	s.seq++
	close(s.next)
	s.next = make(chan struct{})
}

// writeFailure answers a reader whose stream ended before its first picture.
func (s *stream) writeFailure(w http.ResponseWriter) {
	s.mu.Lock()
	reason, detail := s.reason, s.detail
	s.mu.Unlock()
	switch {
	case errors.Is(reason, errClosed):
		apierr.Write(w, http.StatusServiceUnavailable, "shutting_down", "Insight is shutting down.", "")
	case errors.Is(reason, errStalled):
		apierr.Write(w, http.StatusGatewayTimeout, "stream_stalled", "The stream sent no picture in time.", detail)
	default:
		apierr.Write(w, http.StatusBadGateway, "stream_failed", "The stream ended before its first picture.", detail)
	}
}
