package board

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
)

// MaxOutput is how much a command run with Run may print, stdout and stderr together; a
// command that prints more is stopped and fails with CodeCommandFailed.
const MaxOutput = 16 << 20

// A stream keeps the first and the last bytes of its command's stderr, the middle dropped.
const (
	stderrHead = 1 << 10
	stderrTail = 4 << 10
)

// Result is how a command ended: its exit status (128 + n when signal n ended it, as a shell
// reports it) and its output.
type Result struct {
	Exit   int
	Stdout []byte
	Stderr []byte
}

// process is a command started on a board, over SSH or locally, its stdin empty.
type process interface {
	stdout() io.Reader
	stderr() io.Reader
	// wait waits for the command to end, once its output has been read, and gives its exit
	// status.
	wait() (int, error)
	// kill ends the command; its output then ends too.
	kill()
}

// collect reads p's output within MaxOutput and waits for it to end. When ctx ends first, or
// the output grows too large, p is killed.
func collect(ctx context.Context, p process, argv []string) (Result, error) {
	var stdout, stderr bytes.Buffer
	budget := &outputBudget{left: MaxOutput, exceeded: make(chan struct{})}
	var readers sync.WaitGroup
	for _, pipe := range []struct {
		to   *bytes.Buffer
		from io.Reader
	}{{&stdout, p.stdout()}, {&stderr, p.stderr()}} {
		readers.Go(func() { _, _ = io.Copy(budget.writer(pipe.to), pipe.from) })
	}
	read := make(chan struct{})
	go func() { readers.Wait(); close(read) }()

	var failure error
	select {
	case <-read:
	case <-ctx.Done():
		failure = ctx.Err()
	case <-budget.exceeded:
		failure = boardError(CodeCommandFailed, fmt.Sprintf("`%s` printed more than %d bytes.", argv[0], MaxOutput), "", nil)
	}
	if failure != nil {
		p.kill()
		<-read
	}
	exit, err := p.wait()
	if failure != nil {
		return Result{}, failure
	}
	if err != nil {
		return Result{}, err
	}
	return Result{Exit: exit, Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}, nil
}

// outputBudget is what a command's stdout and stderr may still write together.
type outputBudget struct {
	mu       sync.Mutex
	left     int
	exceeded chan struct{} // closed once the output grew past the budget
}

var errOutputTooLarge = errors.New("output too large")

func (b *outputBudget) writer(to *bytes.Buffer) io.Writer {
	return writerFunc(func(p []byte) (int, error) {
		b.mu.Lock()
		defer b.mu.Unlock()
		if len(p) > b.left {
			if b.left >= 0 {
				close(b.exceeded)
				b.left = -1
			}
			return 0, errOutputTooLarge
		}
		b.left -= len(p)
		return to.Write(p)
	})
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// Stream is a running command's stdout, for output that does not end by itself (a camera
// preview, a microphone recording). Close ends the command.
type Stream struct {
	p        process
	out      io.Reader
	errs     *headTail
	errsDone chan struct{}
	stop     func() bool // stops the context's AfterFunc
	once     sync.Once
}

func newStream(ctx context.Context, p process) *Stream {
	s := &Stream{p: p, out: p.stdout(), errs: &headTail{}, errsDone: make(chan struct{})}
	go func() {
		defer close(s.errsDone)
		_, _ = io.Copy(s.errs, p.stderr())
	}()
	s.stop = context.AfterFunc(ctx, func() { _ = s.Close() })
	return s
}

// Read reads the command's stdout; it ends with io.EOF once the command closed it or the
// stream was closed.
func (s *Stream) Read(p []byte) (int, error) { return s.out.Read(p) }

// Close ends the command if it still runs and waits for it to end. It always returns nil.
func (s *Stream) Close() error {
	s.once.Do(func() {
		s.stop()
		s.p.kill()
		<-s.errsDone
		_, _ = s.p.wait()
	})
	return nil
}

// Stderr is the first and the last bytes the command wrote to stderr so far, with "\n...\n"
// where the middle was dropped; complete once Close returned.
func (s *Stream) Stderr() []byte { return s.errs.bytes() }

// headTail keeps the first stderrHead and the last stderrTail bytes written to it.
type headTail struct {
	mu      sync.Mutex
	head    []byte
	tail    []byte
	dropped bool
}

func (h *headTail) Write(p []byte) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := len(p)
	if room := stderrHead - len(h.head); room > 0 {
		take := min(room, len(p))
		h.head = append(h.head, p[:take]...)
		p = p[take:]
	}
	h.tail = append(h.tail, p...)
	if over := len(h.tail) - stderrTail; over > 0 {
		h.tail = append(h.tail[:0], h.tail[over:]...)
		h.dropped = true
	}
	return n, nil
}

func (h *headTail) bytes() []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := append([]byte(nil), h.head...)
	if h.dropped {
		out = append(out, "\n...\n"...)
	}
	return append(out, h.tail...)
}

// exited is a command that could not start, reported as a shell reports it: exit status 127
// for a program not found, 126 for one that cannot run, and the reason on stderr. So a missing
// program reads the same locally as over SSH.
type exited struct {
	status int
	reason string
}

func (e exited) stdout() io.Reader  { return bytes.NewReader(nil) }
func (e exited) stderr() io.Reader  { return bytes.NewReader([]byte(e.reason + "\n")) }
func (e exited) wait() (int, error) { return e.status, nil }
func (e exited) kill()              {}
