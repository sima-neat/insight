package relay

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"insight/internal/procgroup"
)

// The relay runs its producers itself rather than through internal/supervisor, whose children
// print lines (it reads stdout and stderr together, as text) and stay in its list after they
// exit. It handles their process groups the same way: each producer leads its own group, which
// is stopped with SIGTERM, then SIGKILL, and killed once more after the producer exits, so
// nothing the producer started outlives it.

const (
	// stopGrace is how long a stop waits after SIGTERM before SIGKILL, and how long an exited
	// producer's children may hold its stderr open.
	stopGrace = 2 * time.Second
	// stderrLines is how many of the producer's last stderr lines are kept, for the log and
	// the error a reader gets; maxStderrLine is how much of one line.
	stderrLines   = 5
	maxStderrLine = 512
)

// producer is one running producer process.
type producer struct {
	pid    int
	stdout *os.File
	stderr *tail
	exited chan struct{} // closed once the process is reaped and its group killed

	stopOnce sync.Once
	waitErr  error // set before exited is closed
}

// startProducer starts cmd in a process group of its own, its stdout a pipe the relay reads and
// its stderr kept in a short tail.
func startProducer(cmd *exec.Cmd) (*producer, error) {
	if cmd.Stdout != nil || cmd.Stderr != nil {
		return nil, errors.New("the producer's stdout and stderr are the relay's: leave them unset")
	}
	procgroup.Own(cmd)
	stderr := &tail{}
	// Wait returns once stderr is read to its end, so the tail is whole; a child of the
	// producer that holds it open is waited for this long, then killed with the group.
	cmd.Stderr, cmd.WaitDelay = stderr, stopGrace

	stdout, stdoutW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout = stdoutW
	err = cmd.Start()
	stdoutW.Close() // the child holds its own copy
	if err != nil {
		stdout.Close()
		return nil, fmt.Errorf("starting %s: %w", cmd.Path, err)
	}

	p := &producer{pid: cmd.Process.Pid, stdout: stdout, stderr: stderr, exited: make(chan struct{})}
	go func() {
		p.waitErr = cmd.Wait()
		// The group may still hold the producer's own children; they go with it.
		_ = procgroup.Signal(p.pid, syscall.SIGKILL)
		// A child that left the group could keep the pipe open; the stream is over either way.
		stdout.Close()
		close(p.exited)
	}()
	return p, nil
}

// stop ends the producer: SIGTERM to its group, SIGKILL after stopGrace. It does not wait;
// exited says when the producer is gone.
func (p *producer) stop() {
	p.stopOnce.Do(func() {
		select {
		case <-p.exited:
			return
		default:
		}
		_ = procgroup.Signal(p.pid, syscall.SIGTERM)
		go func() {
			select {
			case <-p.exited:
			case <-time.After(stopGrace):
				_ = procgroup.Signal(p.pid, syscall.SIGKILL)
			}
		}()
	})
}

// exitText says how the producer ended ("exit status 1"); call it once exited is closed.
func (p *producer) exitText() string {
	if p.waitErr == nil {
		return "exit status 0"
	}
	return p.waitErr.Error()
}

// tail keeps the last lines written to it.
type tail struct {
	mu      sync.Mutex
	lines   []string
	partial []byte
}

func (t *tail) Write(b []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := len(b)
	for len(b) > 0 {
		line, rest, complete := bytes.Cut(b, []byte("\n"))
		t.partial = append(t.partial, line[:min(len(line), maxStderrLine-len(t.partial))]...)
		if !complete {
			break
		}
		t.endLine()
		b = rest
	}
	return n, nil
}

// endLine moves the partial line to the lines.
func (t *tail) endLine() {
	if line := string(bytes.TrimSpace(t.partial)); line != "" {
		t.lines = append(t.lines, line)
		if len(t.lines) > stderrLines {
			t.lines = t.lines[len(t.lines)-stderrLines:]
		}
	}
	t.partial = t.partial[:0]
}

// last returns the kept lines, oldest first, a last line without its line ending included.
func (t *tail) last() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := append([]string(nil), t.lines...)
	if line := string(bytes.TrimSpace(t.partial)); line != "" {
		lines = append(lines[max(0, len(lines)+1-stderrLines):], line)
	}
	return lines
}
