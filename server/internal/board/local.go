package board

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"

	"insight/internal/procgroup"
)

// localTransport runs commands on the machine Insight runs on, for Insight installed on the
// board. Each command leads a process group of its own, so a kill reaches what it started.
type localTransport struct {
	socket string // Sentinel's API socket

	mu     sync.Mutex
	active map[*localProcess]struct{}
	closed bool
}

func newLocalTransport(socket string) *localTransport {
	return &localTransport{socket: socket, active: map[*localProcess]struct{}{}}
}

// waitDelay bounds how long a killed command's wait waits for its pipes to close.
const waitDelay = 2 * time.Second

func (l *localTransport) start(_ context.Context, argv []string) (process, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	procgroup.Own(cmd)
	cmd.WaitDelay = waitDelay
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil, boardChanged()
	}
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return exited{status: 127, reason: argv[0] + ": command not found"}, nil
		}
		return exited{status: 126, reason: fmt.Sprintf("%s: %v", argv[0], err)}, nil
	}
	p := &localProcess{cmd: cmd, out: stdout, errs: stderr, owner: l}
	l.active[p] = struct{}{}
	return p, nil
}

func (l *localTransport) dialSentinel(ctx context.Context) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, "unix", l.socket)
}

func (l *localTransport) hostKey() string { return "" }

func (l *localTransport) presentedKey() ssh.PublicKey { return nil }

// close kills the commands still running, so a replaced board ends its recordings at once.
func (l *localTransport) close() {
	l.mu.Lock()
	l.closed = true
	active := make([]*localProcess, 0, len(l.active))
	for p := range l.active {
		active = append(active, p)
	}
	l.mu.Unlock()
	for _, p := range active {
		p.kill()
	}
}

type localProcess struct {
	cmd   *exec.Cmd
	out   io.Reader
	errs  io.Reader
	owner *localTransport

	mu     sync.Mutex
	waited bool
}

func (p *localProcess) stdout() io.Reader { return p.out }
func (p *localProcess) stderr() io.Reader { return p.errs }

func (p *localProcess) wait() (int, error) {
	err := p.cmd.Wait()
	p.mu.Lock()
	p.waited = true
	p.mu.Unlock()
	p.owner.mu.Lock()
	delete(p.owner.active, p)
	p.owner.mu.Unlock()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0, nil
	case errors.As(err, &exit):
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal()), nil
		}
		return exit.ExitCode(), nil
	default:
		return 0, err
	}
}

// kill ends the command's process group. Never after wait: the group's id may then be
// another process's.
func (p *localProcess) kill() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.waited {
		_ = procgroup.Signal(p.cmd.Process.Pid, syscall.SIGKILL)
	}
}
