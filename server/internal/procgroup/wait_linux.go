package procgroup

import (
	"errors"

	"golang.org/x/sys/unix"
)

// canWaitUnreaped: waitExited can wait for a child without reaping it.
const canWaitUnreaped = true

// waitExited waits for the child pid to exit and leaves it unreaped (WNOWAIT); false when the
// wait failed, and the child is then waited for by reaping it. A variable for the tests.
var waitExited = func(pid int) bool {
	for {
		var info unix.Siginfo
		err := unix.Waitid(unix.P_PID, pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
		if !errors.Is(err, unix.EINTR) {
			return err == nil
		}
	}
}
