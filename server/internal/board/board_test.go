package board

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"insight/internal/apierr"
)

// fixture is a registry whose selected board is a test SSH server, found as the SDK's DevKit.
type fixture struct {
	server     *testServer
	registry   *Registry
	sshDir     string
	knownHosts string
	socket     string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{server: newTestServer(t), sshDir: filepath.Join(t.TempDir(), "ssh"),
		knownHosts: filepath.Join(t.TempDir(), "known_hosts"), socket: filepath.Join(socketDir(t), "api.sock")}
	if err := os.Mkdir(f.sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	f.server.authorize(writeClientKey(t, f.sshDir))
	f.registry = f.newRegistry(t)
	return f
}

func (f *fixture) newRegistry(t *testing.T) *Registry {
	t.Helper()
	env := map[string]string{
		"DEVKIT_SYNC_DEVKIT_IP":   "127.0.0.1",
		"DEVKIT_SYNC_DEVKIT_PORT": strconv.Itoa(f.server.port()),
		"DEVKIT_SYNC_DEVKIT_USER": "tester",
	}
	registry := NewRegistry(Config{
		SavedFile:      filepath.Join(t.TempDir(), "board.json"),
		KnownHosts:     f.knownHosts,
		SSHDir:         f.sshDir,
		Env:            func(name string) string { return env[name] },
		SentinelSocket: f.socket,
	})
	t.Cleanup(registry.Close)
	return registry
}

func (f *fixture) board(t *testing.T) *Board {
	t.Helper()
	board, err := f.registry.Selected()
	if err != nil {
		t.Fatal(err)
	}
	return board
}

func testContext(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func codeOf(err error) string {
	var failure *apierr.Error
	if errors.As(err, &failure) {
		return failure.Code
	}
	return ""
}

func mustRun(t *testing.T, board *Board, argv ...string) Result {
	t.Helper()
	result, err := board.Run(testContext(t), argv)
	if err != nil {
		t.Fatalf("%v: %v", argv, err)
	}
	return result
}

func TestRunOverSSH(t *testing.T) {
	f := newFixture(t)
	board := f.board(t)
	if got := board.ID(); got != "ssh:tester@127.0.0.1:"+strconv.Itoa(f.server.port()) {
		t.Errorf("id %q", got)
	}

	result := mustRun(t, board, "echo", "it's", "a b")
	if string(result.Stdout) != "it's a b\n" || result.Exit != 0 {
		t.Errorf("echo: %+v", result)
	}
	result = mustRun(t, board, "sh", "-c", "echo oops >&2; exit 3")
	if result.Exit != 3 || string(result.Stderr) != "oops\n" {
		t.Errorf("exit: %+v", result)
	}
	// Its stdin is empty, so a command that reads it ends at once.
	if piped, err := board.Run(testContext(t), []string{"cat"}); err != nil || piped.Exit != 0 || len(piped.Stdout) != 0 {
		t.Errorf("stdin: %+v %v", piped, err)
	}
	if result := mustRun(t, board, "no-such-program-here"); result.Exit != 127 {
		t.Errorf("a missing program: %+v", result)
	}
	if n := f.server.connections(); n != 1 {
		t.Errorf("%d connections for four commands; want one shared", n)
	}
}

func TestRunTimesOutAndKills(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()
	_, err := f.board(t).Run(ctx, []string{"sleep", "30"})
	if codeOf(err) != CodeTimeout {
		t.Fatalf("got %v, want a timeout", err)
	}
	eventually(t, "the command's end", func() bool { return f.server.commands() == 0 })
}

func TestStreamOverSSH(t *testing.T) {
	f := newFixture(t)
	board := f.board(t)

	stream, err := board.Stream(testContext(t), []string{"sh", "-c", "echo ready >&2; while :; do echo tick; sleep 0.05; done"})
	if err != nil {
		t.Fatal(err)
	}
	line := make([]byte, 5)
	if _, err := io.ReadFull(stream, line); err != nil || string(line) != "tick\n" {
		t.Fatalf("read %q, %v", line, err)
	}
	if f.server.commands() != 1 {
		t.Fatalf("%d commands run", f.server.commands())
	}
	_ = stream.Close()
	eventually(t, "the streaming command's end", func() bool { return f.server.commands() == 0 })
	if string(stream.Stderr()) != "ready\n" {
		t.Errorf("stderr %q", stream.Stderr())
	}

	// A stream that ends by itself.
	stream, err = board.Stream(testContext(t), []string{"sh", "-c", "echo done"})
	if err != nil {
		t.Fatal(err)
	}
	all, err := io.ReadAll(stream)
	if err != nil || string(all) != "done\n" {
		t.Errorf("read %q, %v", all, err)
	}
	_ = stream.Close()
}

func TestStreamEndsWithItsContext(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	stream, err := f.board(t).Stream(ctx, []string{"sleep", "30"})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := io.ReadAll(stream); err != nil {
		t.Errorf("read after the end: %v", err)
	}
	eventually(t, "the command's end", func() bool { return f.server.commands() == 0 })
}

// startRecorder is a transport whose start records its context and fails.
type startRecorder struct {
	transport
	deadline time.Time
	bounded  bool
}

func (r *startRecorder) start(ctx context.Context, _ []string) (process, error) {
	r.deadline, r.bounded = ctx.Deadline()
	return nil, errors.New("not started")
}

func TestAStreamsStartIsBoundedThoughItsLifeIsNot(t *testing.T) {
	recorder := &startRecorder{}
	b := newBoard(Target{Mode: ModeSSH, Host: "devkit", Port: 22, User: "sima"}, recorder, "")
	before := time.Now()
	if _, err := b.Stream(context.Background(), []string{"gst-launch-1.0"}); err == nil {
		t.Fatal("the recorder's failure was lost")
	}
	if !recorder.bounded || recorder.deadline.After(before.Add(streamStartTimeout).Add(time.Second)) {
		t.Fatalf("the start's deadline: %v (bounded %v), want within %s", recorder.deadline, recorder.bounded, streamStartTimeout)
	}
}

// serveSentinel serves an HTTP API on socket that answers with what it was asked.
func serveSentinel(t *testing.T, socket string) {
	t.Helper()
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, r.Method+" "+r.Host+" "+r.URL.RequestURI()+" "+r.Header.Get("Content-Type")+" "+string(body))
	}))
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
}

func checkSentinel(t *testing.T, board *Board) {
	t.Helper()
	response, err := board.Sentinel(testContext(t), "POST", "/v1/traces?x=1", strings.NewReader(`{"name":"a"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusAccepted ||
		string(body) != `POST localhost /v1/traces?x=1 application/json {"name":"a"}` {
		t.Errorf("%d %q", response.StatusCode, body)
	}
}

func TestSentinelOverSSH(t *testing.T) {
	f := newFixture(t)
	serveSentinel(t, f.socket)
	board := f.board(t)
	checkSentinel(t, board)
	checkSentinel(t, board)
	if n := f.server.connections(); n != 1 {
		t.Errorf("%d connections; want one shared", n)
	}
	if n := f.server.commands(); n != 0 {
		t.Errorf("%d commands ran for Sentinel; want none", n)
	}
}

func TestSentinelSocketFailuresOverSSH(t *testing.T) {
	f := newFixture(t)
	board := f.board(t)
	ask := func() error {
		response, err := board.Sentinel(testContext(t), "GET", "/v1/health", nil)
		if err == nil {
			response.Body.Close()
		}
		return err
	}

	if err := ask(); codeOf(err) != CodeSentinelMissing || !strings.Contains(err.Error(), "does not exist") {
		t.Errorf("no socket: %v", err)
	}

	// A socket file nothing listens on, as a stopped daemon leaves it.
	listener, err := net.Listen("unix", f.socket)
	if err != nil {
		t.Fatal(err)
	}
	listener.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = listener.Close()
	if err := ask(); codeOf(err) != CodeSentinelMissing || !strings.Contains(err.Error(), "could not be opened over SSH") {
		t.Errorf("nothing listening: %v", err)
	}

	if err := os.Chmod(f.socket, 0); err != nil {
		t.Fatal(err)
	}
	if os.Getuid() != 0 { // root may open it anyway
		if err := ask(); codeOf(err) != CodeSentinelDenied {
			t.Errorf("no permission: %v", err)
		}
	}
}

func TestAcceptNewHostKey(t *testing.T) {
	f := newFixture(t)
	mustRun(t, f.board(t), "true")
	content, err := os.ReadFile(f.knownHosts)
	if err != nil {
		t.Fatal(err)
	}
	want := "[127.0.0.1]:" + strconv.Itoa(f.server.port()) + " " +
		strings.TrimSpace(string(ssh.MarshalAuthorizedKey(f.server.publicHostKey())))
	if strings.TrimSpace(string(content)) != want {
		t.Errorf("known_hosts:\n%s\nwant:\n%s", content, want)
	}

	// A later start finds the key and connects.
	again := f.newRegistry(t)
	board, _ := again.Selected()
	mustRun(t, board, "true")
	identity, err := board.Identity(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	if identity.HostKey != ssh.FingerprintSHA256(f.server.publicHostKey()) || identity.Hostname == "" {
		t.Errorf("identity %+v", identity)
	}
	if status := board.Status(); status.State != StateConnected || status.Identity == nil {
		t.Errorf("status %+v", status)
	}
}

func TestChangedHostKeyRefusedThenTrusted(t *testing.T) {
	f := newFixture(t)
	old := f.board(t)
	mustRun(t, old, "true")
	oldKey := f.server.publicHostKey()

	reflashed := newSigner(t)
	f.server.setHostKey(reflashed)
	f.server.dropConnections()
	_, err := old.Run(testContext(t), []string{"true"})
	var failure *apierr.Error
	if !errors.As(err, &failure) || failure.Code != CodeHostKeyChanged || failure.HostKey == nil {
		t.Fatalf("got %v, want a changed host key", err)
	}
	change := failure.HostKey
	if change.Presented != ssh.FingerprintSHA256(reflashed.PublicKey()) ||
		change.Expected != ssh.FingerprintSHA256(oldKey) ||
		change.Host != "[127.0.0.1]:"+strconv.Itoa(f.server.port()) {
		t.Errorf("change %+v", change)
	}
	if status := old.Status(); status.State != StateError || status.Err.Code != CodeHostKeyChanged {
		t.Errorf("status %+v", status)
	}
	if _, err := old.Run(testContext(t), []string{"true"}); codeOf(err) != CodeHostKeyChanged {
		t.Errorf("a second try: %v", err)
	}

	if _, err := f.registry.TrustHostKey(old.ID(), change.Expected); codeOf(err) != CodeInvalidRequest {
		t.Errorf("trusting another key: %v", err)
	}
	trusted, err := f.registry.TrustHostKey(old.ID(), change.Presented)
	if err != nil {
		t.Fatal(err)
	}
	if trusted == old || trusted.ID() != old.ID() {
		t.Errorf("the board was not replaced")
	}
	if _, err := old.Run(testContext(t), []string{"true"}); codeOf(err) != CodeBoardChanged {
		t.Errorf("the replaced board: %v", err)
	}
	mustRun(t, trusted, "true")
	content, _ := os.ReadFile(f.knownHosts)
	if strings.Count(string(content), "\n") != 1 || !strings.Contains(string(content),
		strings.TrimSpace(string(ssh.MarshalAuthorizedKey(reflashed.PublicKey())))) {
		t.Errorf("known_hosts after trusting:\n%s", content)
	}
}

func TestLostConnectionReconnects(t *testing.T) {
	f := newFixture(t)
	board := f.board(t)
	mustRun(t, board, "true")
	f.server.dropConnections()
	if result := mustRun(t, board, "echo", "back"); string(result.Stdout) != "back\n" {
		t.Errorf("after the loss: %+v", result)
	}
	if n := f.server.connections(); n != 2 {
		t.Errorf("%d connections; want a second after the loss", n)
	}
}

func TestClosedBoardEndsItsCommands(t *testing.T) {
	f := newFixture(t)
	board := f.board(t)
	stream, err := board.Stream(testContext(t), []string{"sleep", "30"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.registry.Select(Target{Mode: ModeSSH, Host: "127.0.0.2", Port: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(stream); err != nil {
		t.Errorf("read: %v", err)
	}
	_ = stream.Close()
	eventually(t, "the command's end", func() bool { return f.server.commands() == 0 })
	if _, err := board.Run(testContext(t), []string{"true"}); codeOf(err) != CodeBoardChanged {
		t.Errorf("the replaced board: %v", err)
	}
}

func TestAuthFailures(t *testing.T) {
	f := newFixture(t)
	writeClientKey(t, f.sshDir) // a new key the server does not know
	_, err := f.board(t).Run(testContext(t), []string{"true"})
	var failure *apierr.Error
	if !errors.As(err, &failure) || failure.Code != CodeAuthFailed || !strings.Contains(failure.Command, "ssh-copy-id -p") {
		t.Errorf("an unknown key: %v", err)
	}

	if err := os.Remove(filepath.Join(f.sshDir, "id_ed25519")); err != nil {
		t.Fatal(err)
	}
	_, err = f.board(t).Run(testContext(t), []string{"true"})
	if !errors.As(err, &failure) || failure.Code != CodeAuthFailed || !strings.Contains(failure.Command, "ssh-keygen") {
		t.Errorf("no key: %v", err)
	}
	if status := f.board(t).Status(); status.State != StateError || status.Err.Code != CodeAuthFailed {
		t.Errorf("status %+v", status)
	}
}

func TestUnreachable(t *testing.T) {
	f := newFixture(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close() // nothing listens there now
	board, err := f.registry.Select(Target{Mode: ModeSSH, Host: "127.0.0.1", Port: port})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := board.Run(testContext(t), []string{"true"}); codeOf(err) != CodeUnreachable {
		t.Errorf("got %v", err)
	}
}

func TestLocalBoard(t *testing.T) {
	socket := filepath.Join(socketDir(t), "api.sock")
	registry := NewRegistry(Config{SavedFile: filepath.Join(t.TempDir(), "board.json"), OnBoard: true,
		Env: func(string) string { return "" }, SentinelSocket: socket})
	t.Cleanup(registry.Close)
	board, err := registry.Selected()
	if err != nil {
		t.Fatal(err)
	}
	if board.ID() != "local" {
		t.Fatalf("id %q", board.ID())
	}

	if result := mustRun(t, board, "sh", "-c", "echo out; echo err >&2; exit 4"); result.Exit != 4 ||
		string(result.Stdout) != "out\n" || string(result.Stderr) != "err\n" {
		t.Errorf("run: %+v", result)
	}
	if result := mustRun(t, board, "no-such-program-here"); result.Exit != 127 ||
		!strings.Contains(string(result.Stderr), "command not found") {
		t.Errorf("a missing program: %+v", result)
	}
	// Its stdin is empty, so a command that reads it ends at once.
	if piped, err := board.Run(testContext(t), []string{"cat"}); err != nil || piped.Exit != 0 || len(piped.Stdout) != 0 {
		t.Errorf("stdin: %+v %v", piped, err)
	}
	if _, err := board.Run(testContext(t), []string{"head", "-c", strconv.Itoa(MaxOutput + 1), "/dev/zero"}); codeOf(err) != CodeCommandFailed {
		t.Errorf("too much output: %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	if _, err := board.Run(ctx, []string{"sleep", "30"}); codeOf(err) != CodeTimeout {
		t.Errorf("timeout: %v", err)
	}

	// A stream's command ends with the stream, the process it started too.
	stream, err := board.Stream(testContext(t), []string{"sh", "-c", "sleep 30 & echo $!; wait"})
	if err != nil {
		t.Fatal(err)
	}
	line := make([]byte, 0, 16)
	for !bytes.HasSuffix(line, []byte("\n")) {
		var b [1]byte
		if _, err := stream.Read(b[:]); err != nil {
			t.Fatal(err)
		}
		line = append(line, b[0])
	}
	sleeper, _ := strconv.Atoi(strings.TrimSpace(string(line)))
	_ = stream.Close()
	eventually(t, "the stream's child's end", func() bool {
		state, err := os.ReadFile("/proc/" + strconv.Itoa(sleeper) + "/stat")
		return err != nil || strings.Contains(string(state), ") Z ") // gone, or a zombie awaiting its reaper
	})

	response, err := board.Sentinel(testContext(t), "GET", "/v1/health", nil)
	if codeOf(err) != CodeSentinelMissing {
		t.Errorf("no socket: %v", err)
	}
	if err == nil {
		response.Body.Close()
	}
	serveSentinel(t, socket)
	checkSentinel(t, board)

	identity, err := board.Identity(testContext(t))
	if err != nil || identity.Hostname == "" || identity.HostKey != "" {
		t.Errorf("identity %+v %v", identity, err)
	}
}
