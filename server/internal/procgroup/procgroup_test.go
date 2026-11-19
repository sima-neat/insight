package procgroup

import (
	"errors"
	"os/exec"
	"testing"
)

// Only the guard is tested on plain numbers: no test signals a process group it did not start.
func TestCheckTarget(t *testing.T) {
	for _, pid := range []int{-5, -1, 0, 1, 4242} {
		if err := CheckTarget(pid, 4242); !errors.Is(err, ErrUnsafeTarget) {
			t.Errorf("pid %d was accepted", pid)
		}
	}
	if err := CheckTarget(4243, 4242); err != nil {
		t.Errorf("a child's pid was refused: %v", err)
	}
}

func TestSignalRefusesBeforeSignaling(t *testing.T) {
	for _, pid := range []int{0, 1, -1} {
		if err := Signal(pid, 0); !errors.Is(err, ErrUnsafeTarget) {
			t.Errorf("pid %d: %v", pid, err)
		}
	}
}

func TestOwn(t *testing.T) {
	cmd := exec.Command("true")
	Own(cmd)
	if !cmd.SysProcAttr.Setpgid || cmd.SysProcAttr.Pgid != 0 {
		t.Fatalf("%+v", cmd.SysProcAttr)
	}
}
