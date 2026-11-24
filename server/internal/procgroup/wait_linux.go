package procgroup

import (
	"errors"

	"golang.org/x/sys/unix"
)

// waitExited waits for the child pid to exit and leaves it unreaped (WNOWAIT); false when the
// wait failed, and the child is then waited for by reaping it.
func waitExited(pid int) bool {
	for {
		var info unix.Siginfo
		err := unix.Waitid(unix.P_PID, pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
		if !errors.Is(err, unix.EINTR) {
			return err == nil
		}
	}
}
