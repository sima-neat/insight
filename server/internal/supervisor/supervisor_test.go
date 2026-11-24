package supervisor

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"insight/internal/procgroup"
)

// Every child in these tests is a small shell script started here; no test signals anything
// it did not start.

func sh(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	return path
}

func eventually(t *testing.T, within time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("not within %v: %s", within, what)
}

func alive(pid int) bool {
	_, ok := processRuns(pid)
	return ok
}

func TestALongLineIsCutAndReadingGoesOn(t *testing.T) {
	s, _ := New(t.TempDir())
	// 2 MiB on one line, then a short one: the child must not block on its pipe.
	p, err := s.Start(Spec{Name: "long", Path: sh(t), Args: []string{"-c", "head -c 2097152 /dev/zero | tr '\\0' x; echo; echo after"}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the child did not finish")
	}
	tail := p.Tail()
	if len(tail) != 2 || len(tail[0]) != maxLine || tail[1] != "after" {
		t.Fatalf("%d lines, the first %d bytes", len(tail), len(tail[0]))
	}
	if p.Status().LastExit != "exit status 0" {
		t.Fatalf("exit %q", p.Status().LastExit)
	}
}

func TestStartKeepsOutputAndStopEndsTheGroup(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// The script starts a grandchild and prints its PID; stopping the child must end both.
	p, err := s.Start(Spec{Name: "worker", Path: sh(t), Args: []string{"-c", "sleep 60 & echo grandchild $!; echo ready; wait"}})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, 2*time.Second, "the child says ready", func() bool {
		tail := p.Tail()
		return len(tail) == 2 && tail[1] == "ready"
	})
	grandchild, err := strconv.Atoi(strings.TrimPrefix(p.Tail()[0], "grandchild "))
	if err != nil {
		t.Fatal(err)
	}
	if !p.Status().Running || p.Status().PID == 0 {
		t.Fatalf("status %+v", p.Status())
	}
	if err := p.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if p.Status().Running {
		t.Fatal("still running")
	}
	eventually(t, 2*time.Second, "the grandchild is gone", func() bool { return !alive(grandchild) })
	if _, err := os.Stat(filepath.Join(s.stateDir, "worker.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the PID file is still there: %v", err)
	}
}

func TestAChildThatIgnoresTermIsKilled(t *testing.T) {
	s, _ := New(t.TempDir())
	p, err := s.Start(Spec{Name: "stubborn", Path: sh(t), Grace: 200 * time.Millisecond,
		Args: []string{"-c", `trap "" TERM; echo ready; while :; do sleep 0.05; done`}})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, 2*time.Second, "ready", func() bool { return len(p.Tail()) > 0 })
	start := time.Now()
	if err := p.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took < 200*time.Millisecond || took > 2*time.Second {
		t.Fatalf("stop took %v", took)
	}
}

func TestAServiceIsRestarted(t *testing.T) {
	s, _ := New(t.TempDir())
	p, err := s.Start(Spec{Name: "flaky", Path: sh(t), Restart: true, Args: []string{"-c", "echo run; exit 3"}})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, 3*time.Second, "a restart", func() bool { return p.Status().Restarts >= 1 })
	if got := p.Status().LastExit; got != "exit status 3" && !p.Status().Running {
		t.Fatalf("last exit %q", got)
	}
	if err := p.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("not done after stop")
	}
}

func TestAOneShotChildIsNotRestarted(t *testing.T) {
	s, _ := New(t.TempDir())
	p, err := s.Start(Spec{Name: "once", Path: sh(t), Args: []string{"-c", "exit 0"}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("not done")
	}
	if p.Status().Restarts != 0 || p.Status().LastExit != "exit status 0" {
		t.Fatalf("status %+v", p.Status())
	}
}

func TestStartFailsForAMissingProgram(t *testing.T) {
	s, _ := New(t.TempDir())
	if _, err := s.Start(Spec{Name: "missing", Path: filepath.Join(t.TempDir(), "nothing")}); err == nil {
		t.Fatal("no error")
	}
	if _, err := s.Start(Spec{Name: "bad name!", Path: sh(t)}); err == nil {
		t.Fatal("a bad name was accepted")
	}
}

func TestStopAll(t *testing.T) {
	s, _ := New(t.TempDir())
	var children []*Process
	for _, name := range []string{"a", "b"} {
		p, err := s.Start(Spec{Name: name, Path: sh(t), Args: []string{"-c", "sleep 60"}})
		if err != nil {
			t.Fatal(err)
		}
		children = append(children, p)
	}
	s.StopAll(context.Background())
	for _, p := range children {
		if p.Status().Running {
			t.Fatalf("%s still running", p.spec.Name)
		}
	}
}

func TestStopLeftovers(t *testing.T) {
	stateDir := t.TempDir()

	t.Run("a child a crashed run left is stopped", func(t *testing.T) {
		// A child in its own group, as the supervisor starts them, whose supervisor is gone.
		cmd := exec.Command(sh(t), "-c", "sleep 60")
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		exited := make(chan struct{})
		go func() { cmd.Wait(); close(exited) }()
		if err := writePIDFile(filepath.Join(stateDir, "left.pid"), cmd.Process.Pid, sh(t)); err != nil {
			t.Fatal(err)
		}
		s, _ := New(stateDir)
		s.StopLeftovers(time.Second)
		select {
		case <-exited:
		case <-time.After(2 * time.Second):
			cmd.Process.Kill()
			t.Fatal("the leftover still runs")
		}
	})

	t.Run("a process that is not a group leader is left alone", func(t *testing.T) {
		cmd := exec.Command(sh(t), "-c", "sleep 60") // in the test's own group
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() { cmd.Process.Kill(); cmd.Wait() }()
		file := filepath.Join(stateDir, "other.pid")
		if err := writePIDFile(file, cmd.Process.Pid, sh(t)); err != nil {
			t.Fatal(err)
		}
		s, _ := New(stateDir)
		s.StopLeftovers(time.Second)
		if !alive(cmd.Process.Pid) {
			t.Fatal("an unrelated process was stopped")
		}
		if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("the file was kept")
		}
	})

	t.Run("a process running another program is left alone", func(t *testing.T) {
		cmd := exec.Command(sh(t), "-c", "sleep 60")
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); cmd.Wait() }()
		if err := writePIDFile(filepath.Join(stateDir, "reused.pid"), cmd.Process.Pid, "/usr/bin/something-else"); err != nil {
			t.Fatal(err)
		}
		s, _ := New(stateDir)
		s.StopLeftovers(time.Second)
		if !alive(cmd.Process.Pid) {
			t.Fatal("a reused PID was stopped")
		}
	})

	t.Run("dangerous and broken files signal nothing", func(t *testing.T) {
		// These PIDs name init, every process, and the test itself: a recorder takes the
		// signal's place before any of them is read, so not even a broken guard signals them.
		var signaled []int
		real := signalGroup
		signalGroup = func(pid int, _ syscall.Signal) error {
			signaled = append(signaled, pid)
			return nil
		}
		t.Cleanup(func() { signalGroup = real })

		for _, pid := range []int{-1, 0, 1, os.Getpid()} {
			if err := stopLeftover(pid, os.Args[0], 0); !errors.Is(err, procgroup.ErrUnsafeTarget) {
				t.Errorf("pid %d: %v", pid, err)
			}
		}
		for name, content := range map[string]string{
			"zero.pid":   "1 0 /bin/sh\n",
			"init.pid":   "1 1 /sbin/init\n",
			"self.pid":   "1 " + strconv.Itoa(os.Getpid()) + " " + os.Args[0] + "\n",
			"group.pid":  "1 -1 /bin/sh\n",
			"broken.pid": "garbage",
		} {
			if err := os.WriteFile(filepath.Join(stateDir, name), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		s, _ := New(stateDir)
		s.StopLeftovers(100 * time.Millisecond)
		if len(signaled) != 0 {
			t.Fatalf("signaled %v", signaled)
		}
		left, _ := filepath.Glob(filepath.Join(stateDir, "*.pid"))
		if len(left) != 0 {
			t.Fatalf("files kept: %v", left)
		}
	})
}
