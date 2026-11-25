package supervisor

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"insight/internal/procgroup"
)

// A PID file holds "1 <pid> <program path>": the format, the child's PID, and the program it
// ran, so a later start can tell it from an unrelated process that reuses the PID.
func writePIDFile(path string, pid int, program string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(fmt.Sprintf("%d %d %s\n", pidFileVersion, pid, program)), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func removePIDFile(path string) {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("removing a PID file", "file", path, "error", err)
	}
}

func readPIDFile(path string) (int, string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return 0, "", err
	}
	fields := strings.SplitN(strings.TrimSpace(string(content)), " ", 3)
	if len(fields) != 3 || fields[0] != strconv.Itoa(pidFileVersion) {
		return 0, "", fmt.Errorf("%s: not a PID file of this version", path)
	}
	pid, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, "", fmt.Errorf("%s: %w", path, err)
	}
	return pid, fields[2], nil
}

// processRuns reads the program a running process was started with, from /proc. An empty
// cmdline reads as not running: a zombie's, and a process's not yet through its exec.
var processRuns = func(pid int) (string, bool) {
	cmdline, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err != nil || len(cmdline) == 0 {
		return "", false
	}
	program, _, _ := bytes.Cut(cmdline, []byte{0})
	return string(program), true
}

// signalGroup signals a leftover's process group. It is procgroup.Signal; the test of dangerous
// PID files puts a recorder in its place, so those PIDs never reach a real signal, whatever the
// guard does.
var signalGroup = procgroup.Signal

// StopLeftovers stops the children a previous run of Insight left running (it crashed, or was
// killed), named by the PID files in the state folder. A PID is signaled only while it still
// runs the program its file names and leads its own process group; any other file is removed
// and nothing is signaled.
func (s *Supervisor) StopLeftovers(grace time.Duration) {
	files, err := filepath.Glob(filepath.Join(s.stateDir, "*"+pidFileSuffix))
	if err != nil {
		return
	}
	for _, file := range files {
		pid, program, err := readPIDFile(file)
		if err == nil {
			err = stopLeftover(pid, program, grace)
		}
		if err != nil {
			slog.Warn("a leftover child", "file", file, "error", err)
		}
		removePIDFile(file)
	}
}

func stopLeftover(pid int, program string, grace time.Duration) error {
	if err := procgroup.CheckTarget(pid, os.Getpid()); err != nil {
		return err
	}
	running, ok := processRuns(pid)
	if !ok || running != program {
		return nil // gone, or the PID now belongs to something else
	}
	if pgid, err := syscall.Getpgid(pid); err != nil || pgid != pid {
		return nil // not a group leader: not a child Insight started
	}
	slog.Info("stopping a child a previous run left behind", "pid", pid, "program", program)
	if err := signalGroup(pid, syscall.SIGTERM); err != nil {
		return err
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if _, ok := processRuns(pid); !ok {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return signalGroup(pid, syscall.SIGKILL)
}
