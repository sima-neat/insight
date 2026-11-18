// Package supervisor runs Insight's child processes: it starts each in its own process group,
// keeps the last lines it printed, restarts a service that exits, and stops them all, children
// of children included, when Insight stops.
//
// Each child's process ID is written to a file in the supervisor's state folder while it runs,
// so a start after a crash can stop what the crashed run left behind, and nothing else.
package supervisor

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"insight/internal/procgroup"
)

// Spec says how to run one child.
type Spec struct {
	// Name identifies the child in logs and in its PID file; letters, digits and dashes.
	Name string
	// Path is the program; Args its arguments, without the program itself.
	Path string
	Args []string
	// Env is the whole environment; nil inherits Insight's.
	Env []string
	// Dir is the working folder; empty is Insight's.
	Dir string
	// Restart starts the child again after it exits, waiting longer after each quick exit.
	Restart bool
	// Grace is how long a stop waits after SIGTERM before SIGKILL; 0 is 5 s.
	Grace time.Duration
	// Output receives every line the child prints, as "[name] line"; nil discards them.
	Output io.Writer
}

// Status is a child's state at one moment.
type Status struct {
	Running  bool
	PID      int
	Restarts int
	// LastExit is how the last run ended ("exit status 1"), or "".
	LastExit string
}

const (
	tailLines      = 100
	firstBackoff   = time.Second
	maxBackoff     = 30 * time.Second
	stableRun      = 30 * time.Second
	defaultGrace   = 5 * time.Second
	pidFileSuffix  = ".pid"
	pidFileVersion = 1
)

// Supervisor owns the children it started.
type Supervisor struct {
	stateDir string
	mu       sync.Mutex
	children []*Process
}

// New makes a supervisor that keeps its PID files in stateDir (created).
func New(stateDir string) (*Supervisor, error) {
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating %s: %w", stateDir, err)
	}
	return &Supervisor{stateDir: stateDir}, nil
}

// Process is one supervised child, across its restarts.
type Process struct {
	spec    Spec
	pidFile string

	mu       sync.Mutex
	cmd      *exec.Cmd
	status   Status
	tail     []string
	stopping bool

	stop chan struct{} // closed by Stop
	done chan struct{} // closed when the child has exited for good
}

// Start runs spec's child. It fails when the program cannot be started at all; later exits are
// handled by the restart policy.
func (s *Supervisor) Start(spec Spec) (*Process, error) {
	if !validName(spec.Name) {
		return nil, fmt.Errorf("child name %q: use letters, digits and dashes", spec.Name)
	}
	if spec.Grace == 0 {
		spec.Grace = defaultGrace
	}
	p := &Process{
		spec:    spec,
		pidFile: filepath.Join(s.stateDir, spec.Name+pidFileSuffix),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	p.mu.Lock()
	exited, err := p.launchLocked()
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	// A child that has exited for good needs no stop; dropping it keeps the list from growing
	// with every start of a short-lived child (a slot's publisher, an encode).
	s.children = slices.DeleteFunc(s.children, func(c *Process) bool {
		select {
		case <-c.done:
			return true
		default:
			return false
		}
	})
	s.children = append(s.children, p)
	s.mu.Unlock()
	go p.watch(exited)
	return p, nil
}

// StopAll stops every child, the last started first.
func (s *Supervisor) StopAll(ctx context.Context) {
	s.mu.Lock()
	children := append([]*Process(nil), s.children...)
	s.mu.Unlock()
	for i := len(children) - 1; i >= 0; i-- {
		if err := children[i].Stop(ctx); err != nil {
			slog.Warn("stopping a child", "child", children[i].spec.Name, "error", err)
		}
	}
}

// Status returns the child's state now.
func (p *Process) Status() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.status
}

// Tail returns the last lines the child printed, oldest first.
func (p *Process) Tail() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.tail...)
}

// Done is closed once the child has exited and will not be restarted.
func (p *Process) Done() <-chan struct{} { return p.done }

// Stop ends the child: SIGTERM to its process group, SIGKILL after the grace period, no
// restart. It returns once the child has exited, or when ctx ends.
func (p *Process) Stop(ctx context.Context) error {
	p.mu.Lock()
	if !p.stopping {
		p.stopping = true
		close(p.stop)
	}
	cmd := p.cmd
	running := p.status.Running
	p.mu.Unlock()

	if running && cmd != nil {
		if err := procgroup.Signal(cmd.Process.Pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
	}
	select {
	case <-p.done:
		return nil
	case <-time.After(p.spec.Grace):
	case <-ctx.Done():
	}
	if running && cmd != nil {
		if err := procgroup.Signal(cmd.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
	}
	select {
	case <-p.done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("%s did not exit: %w", p.spec.Name, ctx.Err())
	}
}

// launchLocked starts one run and returns a channel that delivers its exit. p.mu is held, so
// Stop sees either no run or this one.
func (p *Process) launchLocked() (<-chan error, error) {
	cmd := exec.Command(p.spec.Path, p.spec.Args...)
	cmd.Env, cmd.Dir = p.spec.Env, p.spec.Dir
	procgroup.Own(cmd)
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout, cmd.Stderr = writer, writer
	if err := cmd.Start(); err != nil {
		reader.Close()
		writer.Close()
		return nil, fmt.Errorf("starting %s: %w", p.spec.Name, err)
	}
	writer.Close() // the child holds its own copy
	go p.readLines(reader)

	if err := writePIDFile(p.pidFile, cmd.Process.Pid, p.spec.Path); err != nil {
		slog.Warn("writing a PID file", "child", p.spec.Name, "error", err)
	}
	p.cmd = cmd
	p.status.Running, p.status.PID = true, cmd.Process.Pid

	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	return exited, nil
}

// watch waits for each run's exit and starts the next while the restart policy says so.
func (p *Process) watch(exited <-chan error) {
	defer close(p.done)
	backoff := firstBackoff
	for {
		started := time.Now()
		err := <-exited
		p.mu.Lock()
		cmd := p.cmd
		p.status.Running, p.status.PID = false, 0
		p.status.LastExit = exitText(err)
		stopping := p.stopping
		p.mu.Unlock()
		// The group may still hold the child's own children; they go with it.
		if cmd != nil {
			_ = procgroup.Signal(cmd.Process.Pid, syscall.SIGKILL)
		}
		removePIDFile(p.pidFile)

		if stopping || !p.spec.Restart {
			return
		}
		if time.Since(started) >= stableRun {
			backoff = firstBackoff
		}
		slog.Warn("a child exited; starting it again", "child", p.spec.Name, "exit", exitText(err), "in", backoff)
		for {
			select {
			case <-p.stop:
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, maxBackoff)
			p.mu.Lock()
			if p.stopping {
				p.mu.Unlock()
				return
			}
			next, err := p.launchLocked()
			if err == nil {
				p.status.Restarts++
				p.mu.Unlock()
				exited = next
				break
			}
			p.status.LastExit = err.Error()
			p.mu.Unlock()
			slog.Warn("restarting a child failed", "child", p.spec.Name, "error", err)
		}
	}
}

// readLines reads the child's output to its end, line by line. A line longer than maxLine is
// cut, never a reason to stop reading: a child whose pipe is no longer read blocks, or dies on
// a closed pipe.
func (p *Process) readLines(reader io.ReadCloser) {
	defer reader.Close()
	buffered := bufio.NewReaderSize(reader, 64*1024)
	for {
		line, err := readLine(buffered)
		if err != nil && line == "" {
			return
		}
		p.mu.Lock()
		p.tail = append(p.tail, line)
		if len(p.tail) > tailLines {
			p.tail = p.tail[len(p.tail)-tailLines:]
		}
		p.mu.Unlock()
		if p.spec.Output != nil {
			fmt.Fprintf(p.spec.Output, "[%s] %s\n", p.spec.Name, line)
		}
		if err != nil {
			return
		}
	}
}

// maxLine is how much of one output line is kept.
const maxLine = 4096

// readLine reads one line without its line ending, its first maxLine bytes only.
func readLine(r *bufio.Reader) (string, error) {
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		if room := maxLine - len(line); room > 0 {
			line = append(line, chunk[:min(len(chunk), room)]...)
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		return strings.TrimRight(string(line), "\r\n"), err
	}
}

func exitText(err error) string {
	if err == nil {
		return "exit status 0"
	}
	return err.Error()
}

func validName(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}
