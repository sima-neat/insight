package procgroup

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"testing"
)

// recorder stands in for Signal: no test here sends a real signal. It notes, for each call, the
// state /proc gives the process then ('Z' for a zombie: exited, not yet reaped).
type recorder struct {
	mu    sync.Mutex
	calls []call
}

type call struct {
	pid   int
	sig   syscall.Signal
	state byte
}

func (r *recorder) send(pid int, sig syscall.Signal) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, call{pid, sig, processState(pid)})
	return nil
}

func (r *recorder) recorded() []call {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]call(nil), r.calls...)
}

// processState is the state letter of /proc/<pid>/stat, 0 when there is no such process.
func processState(pid int) byte {
	stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0
	}
	// "pid (comm) S ...": comm may hold spaces and parentheses, the state follows the last ')'.
	if i := bytes.LastIndexByte(stat, ')'); i >= 0 && i+2 < len(stat) {
		return stat[i+2]
	}
	return 0
}

func startRecorded(t *testing.T, cmd *exec.Cmd) (*Group, *recorder) {
	t.Helper()
	g, err := Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	r := &recorder{}
	g.send = r.send
	return g, r
}

func TestStartMakesTheChildLeadAGroup(t *testing.T) {
	g, _ := startRecorded(t, exec.Command("true"))
	if !g.cmd.SysProcAttr.Setpgid {
		t.Fatal("the child does not lead a group of its own")
	}
	if err := g.Wait(); err != nil {
		t.Fatal(err)
	}
}

func TestWaitKillsTheGroupBeforeTheChildIsReaped(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("only Linux waits without reaping")
	}
	g, r := startRecorded(t, exec.Command("true"))
	pid := g.cmd.Process.Pid
	if err := g.Wait(); err != nil {
		t.Fatal(err)
	}
	calls := r.recorded()
	if len(calls) != 1 || calls[0].pid != pid || calls[0].sig != syscall.SIGKILL {
		t.Fatalf("signals %+v, want one SIGKILL to %d", calls, pid)
	}
	if calls[0].state != 'Z' {
		t.Fatalf("the group was signaled with its child in state %q, want a zombie, not yet reaped", calls[0].state)
	}
}

func TestSignalReachesTheGroupOnlyUntilTheChildIsReaped(t *testing.T) {
	cmd := exec.Command("cat") // ends when its stdin closes, so no signal is needed to end it
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	g, r := startRecorded(t, cmd)
	if err := g.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	stdin.Close()
	if err := g.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := g.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	calls := r.recorded()
	if len(calls) == 0 || calls[0].sig != syscall.SIGTERM || calls[0].pid != g.cmd.Process.Pid {
		t.Fatalf("the signal before the exit: %+v", calls)
	}
	for _, c := range calls[1:] {
		if c.sig == syscall.SIGTERM {
			t.Fatalf("a signal after the child was reaped was sent: %+v", calls)
		}
	}
}

func TestAGroupThatDidNotStartIsNone(t *testing.T) {
	if _, err := Start(exec.Command(filepath.Join(t.TempDir(), "missing"))); err == nil {
		t.Fatal("a missing program started")
	}
}
