// Package procgroup signals the process groups of children Insight started, and nothing else.
//
// Each child Insight starts leads a group of its own (Setpgid), so a signal to the group reaches
// what the child started too. A group signal is a kill(-pid): with a pid of 0 or below, 1, or
// Insight's own, it would reach Insight's own group, init, or every process the user may
// signal. Signal refuses those, so no caller can pass such a pid by mistake.
package procgroup

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// ErrUnsafeTarget refuses a signal that could reach processes Insight did not start.
var ErrUnsafeTarget = errors.New("refusing to signal this process group")

// CheckTarget says whether pid may name a process group to signal: one Insight started, which
// leads its own group. self is Insight's own pid.
func CheckTarget(pid, self int) error {
	if pid <= 1 || pid == self {
		return fmt.Errorf("%w: %d", ErrUnsafeTarget, pid)
	}
	return nil
}

// Signal sends sig to the process group pid leads, after CheckTarget.
func Signal(pid int, sig syscall.Signal) error {
	if err := CheckTarget(pid, os.Getpid()); err != nil {
		return err
	}
	return syscall.Kill(-pid, sig)
}

// Own makes cmd, not yet started, lead a process group of its own.
func Own(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid, cmd.SysProcAttr.Pgid = true, 0
}
