package board

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestLiveBoard checks the package against a real board, only when INSIGHT_TEST_BOARD names
// one (user@host or user@host:port). It signs in with this account's keys in ~/.ssh and trusts
// the board's host key in a known_hosts of its own, so the user's is left alone. It changes
// nothing on the board; the one long command it starts there is a sleep, which it ends.
func TestLiveBoard(t *testing.T) {
	spec := os.Getenv("INSIGHT_TEST_BOARD")
	if spec == "" {
		t.Skip("set INSIGHT_TEST_BOARD=user@host[:port] to test against a real board")
	}
	user, address, found := strings.Cut(spec, "@")
	if !found {
		t.Fatalf("INSIGHT_TEST_BOARD=%q: want user@host[:port]", spec)
	}
	host, port := address, DefaultPort
	if h, p, err := net.SplitHostPort(address); err == nil {
		host = h
		if port, err = strconv.Atoi(p); err != nil {
			t.Fatalf("port %q: %v", p, err)
		}
	}
	target, err := SSHTarget(host, port, user, SourceManual)
	if err != nil {
		t.Fatal(err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	registry := NewRegistry(Config{SavedFile: filepath.Join(dir, "board.json"),
		KnownHosts: filepath.Join(dir, "known_hosts"), SSHDir: filepath.Join(home, ".ssh"),
		Env: func(string) string { return "" }})
	t.Cleanup(registry.Close)
	board, err := registry.Select(target)
	if err != nil {
		t.Fatal(err)
	}

	identity, err := board.Identity(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("identity %+v", identity)
	if identity.HostKey == "" || identity.Machine == "" {
		t.Errorf("identity %+v lacks the host key or the machine", identity)
	}

	result := mustRun(t, board, "uname", "-a")
	t.Logf("uname: %s", result.Stdout)

	response, err := board.Sentinel(testContext(t), "GET", "/v1/health", nil)
	if err != nil {
		t.Fatalf("Sentinel: %v", err)
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	response.Body.Close()
	t.Logf("Sentinel /v1/health: %d %s", response.StatusCode, body)
	var health struct{ Schema int }
	if response.StatusCode != http.StatusOK || json.Unmarshal(body, &health) != nil || health.Schema != 1 {
		t.Errorf("Sentinel's health: %d %s", response.StatusCode, body)
	}

	// Closing a stream ends its command on the board, also one that writes nothing more.
	stream, err := board.Stream(testContext(t), []string{"sh", "-c", "echo $$; exec sleep 60"})
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(stream).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	pid := strings.TrimSpace(line)
	if _, err := strconv.Atoi(pid); err != nil {
		t.Fatalf("pid %q", line)
	}
	_ = stream.Close()
	eventually(t, "the remote sleep's end", func() bool {
		return mustRun(t, board, "kill", "-0", pid).Exit != 0
	})
}
