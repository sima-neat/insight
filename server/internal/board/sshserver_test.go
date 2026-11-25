package board

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"insight/internal/procgroup"
)

// testServer is an SSH server on loopback that stands in for a board: it signs in the keys it
// was given, runs each exec request with sh -c in a temporary folder, and forwards
// direct-streamlocal channels to the Unix socket they name, refusing them as OpenSSH does
// ("open failed") when that socket cannot be opened.
type testServer struct {
	t        *testing.T
	listener net.Listener
	dir      string

	mu         sync.Mutex
	hostKey    ssh.Signer
	authorized [][]byte
	conns      map[net.Conn]bool
	accepted   int
	running    int
}

func newTestServer(t *testing.T) *testServer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &testServer{t: t, listener: listener, dir: t.TempDir(), hostKey: newSigner(t), conns: map[net.Conn]bool{}}
	go s.serve()
	t.Cleanup(func() {
		_ = listener.Close()
		s.dropConnections()
	})
	return s
}

func (s *testServer) port() int { return s.listener.Addr().(*net.TCPAddr).Port }

func (s *testServer) authorize(key ssh.PublicKey) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.authorized = append(s.authorized, key.Marshal())
}

func (s *testServer) setHostKey(signer ssh.Signer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hostKey = signer
}

func (s *testServer) publicHostKey() ssh.PublicKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hostKey.PublicKey()
}

// dropConnections closes every connection at the TCP level, as a board that went away.
func (s *testServer) dropConnections() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for conn := range s.conns {
		_ = conn.Close()
	}
}

// connections is how many connections the server accepted.
func (s *testServer) connections() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.accepted
}

// commands is how many commands still run.
func (s *testServer) commands() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

func (s *testServer) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns[conn] = true
		s.accepted++
		config := &ssh.ServerConfig{PublicKeyCallback: s.checkKey}
		config.AddHostKey(s.hostKey)
		s.mu.Unlock()
		go s.handle(conn, config)
	}
}

func (s *testServer) checkKey(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, authorized := range s.authorized {
		if string(authorized) == string(key.Marshal()) {
			return &ssh.Permissions{}, nil
		}
	}
	return nil, errors.New("key not authorized")
}

func (s *testServer) handle(conn net.Conn, config *ssh.ServerConfig) {
	defer func() {
		s.mu.Lock()
		delete(s.conns, conn)
		s.mu.Unlock()
		_ = conn.Close()
	}()
	_, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(requests)
	for channel := range channels {
		switch channel.ChannelType() {
		case "session":
			go s.session(channel)
		case "direct-streamlocal@openssh.com":
			go s.streamLocal(channel)
		default:
			_ = channel.Reject(ssh.UnknownChannelType, "unknown channel type")
		}
	}
}

func (s *testServer) session(newChannel ssh.NewChannel) {
	channel, requests, err := newChannel.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	var cmd *exec.Cmd
	exited := make(chan struct{})
	kill := func() {
		if cmd != nil && cmd.Process != nil {
			select {
			case <-exited:
			default:
				_ = procgroup.Signal(cmd.Process.Pid, syscall.SIGKILL)
			}
		}
	}
	for request := range requests {
		switch request.Type {
		case "exec":
			var payload struct{ Command string }
			if cmd != nil || ssh.Unmarshal(request.Payload, &payload) != nil {
				_ = request.Reply(false, nil)
				continue
			}
			cmd = exec.Command("sh", "-c", payload.Command)
			cmd.Dir, cmd.Stdin, cmd.Stdout, cmd.Stderr = s.dir, channel, channel, channel.Stderr()
			cmd.WaitDelay = time.Second
			procgroup.Own(cmd)
			if err := cmd.Start(); err != nil {
				_ = request.Reply(false, nil)
				return
			}
			_ = request.Reply(true, nil)
			s.mu.Lock()
			s.running++
			s.mu.Unlock()
			go func() {
				err := cmd.Wait()
				close(exited)
				s.mu.Lock()
				s.running--
				s.mu.Unlock()
				status := 0
				var exit *exec.ExitError
				if errors.As(err, &exit) {
					status = exit.ExitCode()
					if ws, ok := exit.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
						status = 128 + int(ws.Signal())
					}
				}
				_, _ = channel.SendRequest("exit-status", false, binary.BigEndian.AppendUint32(nil, uint32(status)))
				_ = channel.Close()
			}()
		case "signal":
			kill()
		default:
			if request.WantReply {
				_ = request.Reply(false, nil)
			}
		}
	}
	kill() // the client closed the channel
}

func (s *testServer) streamLocal(newChannel ssh.NewChannel) {
	var payload struct {
		SocketPath string
		Reserved0  string
		Reserved1  uint32
	}
	if err := ssh.Unmarshal(newChannel.ExtraData(), &payload); err != nil {
		_ = newChannel.Reject(ssh.Prohibited, "bad request")
		return
	}
	conn, err := net.Dial("unix", payload.SocketPath)
	if err != nil {
		_ = newChannel.Reject(ssh.Prohibited, "open failed")
		return
	}
	channel, requests, err := newChannel.Accept()
	if err != nil {
		_ = conn.Close()
		return
	}
	go ssh.DiscardRequests(requests)
	var copies sync.WaitGroup
	copies.Go(func() {
		_, _ = io.Copy(conn, channel)
		_ = conn.(*net.UnixConn).CloseWrite()
	})
	copies.Go(func() {
		_, _ = io.Copy(channel, conn)
		_ = channel.CloseWrite()
	})
	copies.Wait()
	_ = channel.Close()
	_ = conn.Close()
}

func newSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

// writeClientKey writes a new ed25519 key as dir/id_ed25519 and returns its public half.
func writeClientKey(t *testing.T, dir string) ssh.PublicKey {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(private, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "id_ed25519"), pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return signer.PublicKey()
}

// socketDir is a new folder for Unix sockets, with a path short enough for one (108 bytes),
// which a test's TempDir may not be. It is removed after the test.
func socketDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "board")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) }) // the folder MkdirTemp just made
	return dir
}

// eventually fails the test unless check holds within 5 s.
func eventually(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen within 5 s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
