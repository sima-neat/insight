package procgroup

import (
	"os/exec"
	"sync"
	"syscall"
)

// A Group is a started child and the process group it leads. Its signals reach the group only
// until the child is reaped: from then on the child's pid, and so the group's id, may be another
// process's.
type Group struct {
	cmd *exec.Cmd
	// send is Signal; the tests record instead.
	send func(pid int, sig syscall.Signal) error

	mu     sync.Mutex
	reaped bool
}

// Start starts cmd, set up as exec.Cmd's Start wants it, as the leader of a group of its own.
func Start(cmd *exec.Cmd) (*Group, error) {
	Own(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &Group{cmd: cmd, send: Signal}, nil
}

// Pid is the child's pid, the group's id.
func (g *Group) Pid() int { return g.cmd.Process.Pid }

// Signal sends sig to the group. Once the child is reaped it sends nothing and returns nil.
func (g *Group) Signal(sig syscall.Signal) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.reaped {
		return nil
	}
	return g.send(g.cmd.Process.Pid, sig)
}

// Wait waits for the child to exit, kills what is left of its group (what the child started),
// then reaps the child and returns what exec.Cmd's Wait does. The kill comes while the child is
// a zombie, whose pid no other process can take. Where the system cannot wait without reaping
// (waitExited), the kill comes after, as close to the reap as it can. Call Wait once.
func (g *Group) Wait() error {
	pid := g.cmd.Process.Pid
	if waitExited(pid) {
		g.mu.Lock()
		_ = g.send(pid, syscall.SIGKILL)
		g.reaped = true
		g.mu.Unlock()
		return g.cmd.Wait()
	}
	err := g.cmd.Wait()
	g.mu.Lock()
	_ = g.send(pid, syscall.SIGKILL)
	g.reaped = true
	g.mu.Unlock()
	return err
}
