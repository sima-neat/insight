package board

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"insight/api"
	"insight/internal/apierr"
)

const (
	// connectTimeout bounds a connection's TCP connect and SSH handshake.
	connectTimeout = 8 * time.Second
	// keepAliveEvery is how often an idle connection is checked; one that does not answer
	// within the same time is closed, so the next operation reconnects.
	keepAliveEvery = 15 * time.Second
)

// keyFiles are the service account's keys Insight signs in with, as the old backend (paramiko)
// looked for them. A passphrase-protected key is skipped: Insight cannot ask for it.
var keyFiles = []string{"id_ed25519", "id_ecdsa", "id_rsa"}

// sshTransport is one SSH connection to a board, shared by every operation on it: each command
// and each Sentinel request is a channel of its own on that connection. It connects on first
// use and again after the connection was lost. It uses keys only: no agent, no password.
type sshTransport struct {
	target Target
	hosts  *knownHosts
	sshDir string
	socket string

	connecting chan struct{} // holds a token while a connection is made: one at a time

	mu        sync.Mutex
	client    *ssh.Client
	key       ssh.PublicKey // the board's host key, once connected
	presented ssh.PublicKey // the key the last refused connection presented
	closed    bool
}

func newSSHTransport(target Target, hosts *knownHosts, sshDir, socket string) *sshTransport {
	return &sshTransport{target: target, hosts: hosts, sshDir: sshDir, socket: socket,
		connecting: make(chan struct{}, 1)}
}

func (s *sshTransport) start(ctx context.Context, argv []string) (process, error) {
	var p *sshProcess
	err := s.use(ctx, func(c *ssh.Client) error {
		var err error
		p, err = s.open(ctx, c, shellJoin(argv))
		return err
	})
	if err != nil {
		return nil, err
	}
	return p, nil
}

// open starts command in a new session on c.
func (s *sshTransport) open(ctx context.Context, c *ssh.Client, command string) (*sshProcess, error) {
	session, err := await(ctx, c.NewSession, func(session *ssh.Session) { _ = session.Close() })
	if err != nil {
		return nil, err
	}
	p := &sshProcess{session: session, host: s.target.Host}
	if p.out, err = session.StdoutPipe(); err == nil {
		p.errs, err = session.StderrPipe()
	}
	if err == nil {
		// Start waits for the board's reply; closing the session ends that wait.
		stop := context.AfterFunc(ctx, func() { _ = session.Close() })
		err = session.Start(command)
		if !stop() {
			err = ctx.Err()
		}
	}
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	return p, nil
}

func (s *sshTransport) dialSentinel(ctx context.Context) (net.Conn, error) {
	var conn net.Conn
	err := s.use(ctx, func(c *ssh.Client) error {
		var err error
		conn, err = c.DialContext(ctx, "unix", s.socket)
		return err
	})
	return conn, err
}

// use runs f on the connection, and once more on a new one when f failed because the
// connection was lost before the keepalive noticed. A board that refused a channel or a
// command keeps its connection: the other operations on it go on.
func (s *sshTransport) use(ctx context.Context, f func(*ssh.Client) error) error {
	for attempt := 0; ; attempt++ {
		c, err := s.connected(ctx)
		if err != nil {
			return err
		}
		err = f(c)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var refused *ssh.OpenChannelError
		if errors.As(err, &refused) {
			return err
		}
		if alive(ctx, c) {
			return boardError(CodeCommandFailed, fmt.Sprintf("%s refused to run the command over SSH.", s.target.Host),
				fmt.Sprintf("Check that `ssh -p %d %s true` runs a command on the board.", s.target.Port, s.target.login()), err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.drop(c)
		if attempt > 0 {
			return s.unreachable(fmt.Sprintf("The SSH connection to %s was lost: %v", s.target.Host, err), err)
		}
	}
}

// connected is the board's connection, made now if there is none.
func (s *sshTransport) connected(ctx context.Context) (*ssh.Client, error) {
	if c, err := s.current(); c != nil || err != nil {
		return c, err
	}
	select {
	case s.connecting <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-s.connecting }()
	if c, err := s.current(); c != nil || err != nil {
		return c, err // made while this call waited
	}
	c, key, err := s.connect(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = c.Close()
		return nil, boardChanged()
	}
	s.client, s.key, s.presented = c, key, nil
	s.mu.Unlock()
	go s.watch(c)
	return c, nil
}

func (s *sshTransport) current() (*ssh.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, boardChanged()
	}
	return s.client, nil
}

// watch forgets c once it ends, and closes it when it stops answering keepalives.
func (s *sshTransport) watch(c *ssh.Client) {
	ended := make(chan struct{})
	go func() {
		_ = c.Wait()
		close(ended)
	}()
	ticker := time.NewTicker(keepAliveEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ended:
			s.drop(c)
			return
		case <-ticker.C:
			if !alive(context.Background(), c) {
				slog.Warn("the board stopped answering over SSH; closing the connection", "board", s.target.ID())
				_ = c.Close()
			}
		}
	}
}

// alive says whether c's board answers a keepalive within keepAliveEvery and before ctx ends.
// The board's answer is a refusal (OpenSSH knows no such request); that it answers is what
// counts.
func alive(ctx context.Context, c *ssh.Client) bool {
	answered := make(chan error, 1)
	go func() {
		_, _, err := c.SendRequest("keepalive@openssh.com", true, nil)
		answered <- err
	}()
	timer := time.NewTimer(keepAliveEvery)
	defer timer.Stop()
	select {
	case err := <-answered:
		return err == nil
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

func (s *sshTransport) drop(c *ssh.Client) {
	s.mu.Lock()
	if s.client == c {
		s.client = nil
	}
	s.mu.Unlock()
	_ = c.Close()
}

func (s *sshTransport) hostKey() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.key == nil {
		return ""
	}
	return ssh.FingerprintSHA256(s.key)
}

func (s *sshTransport) presentedKey() ssh.PublicKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.presented
}

// close ends the connection and every command on it; the board's commands then get EOF on
// their pipes and end at their next write.
func (s *sshTransport) close() {
	s.mu.Lock()
	s.closed = true
	c := s.client
	s.client = nil
	s.mu.Unlock()
	if c != nil {
		_ = c.Close()
	}
}

// handshake is what a connection's host key check saw, read once the handshake returned.
type handshake struct {
	mu        sync.Mutex
	presented ssh.PublicKey
	accepted  bool
	change    *api.HostKeyChange
}

func (s *sshTransport) connect(ctx context.Context) (*ssh.Client, ssh.PublicKey, error) {
	signers := loadSigners(s.sshDir)
	if len(signers) == 0 {
		return nil, nil, s.noKey()
	}
	address := s.target.address()
	algorithms, err := s.hosts.algorithms(address)
	if err != nil {
		return nil, nil, err
	}
	attempt, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	var dialer net.Dialer
	conn, err := dialer.DialContext(attempt, "tcp", address)
	if err != nil {
		return nil, nil, s.connectFailed(ctx, err)
	}
	stop := context.AfterFunc(attempt, func() { _ = conn.Close() })

	seen := &handshake{}
	config := &ssh.ClientConfig{
		User:              s.target.User,
		Auth:              []ssh.AuthMethod{ssh.PublicKeys(signers...)},
		HostKeyAlgorithms: algorithms,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			change, err := s.hosts.check(address, key)
			seen.mu.Lock()
			defer seen.mu.Unlock()
			seen.presented, seen.change, seen.accepted = key, change, err == nil && change == nil
			if err != nil {
				return err
			}
			if change != nil {
				return errors.New("the board presented another host key than the one trusted")
			}
			return nil
		},
	}
	cc, channels, requests, err := ssh.NewClientConn(conn, address, config)
	if !stop() { // the attempt ended during the handshake, which then failed or is dropped
		if err == nil {
			_ = cc.Close()
		}
		err = context.DeadlineExceeded
	}
	if err != nil {
		_ = conn.Close()
		seen.mu.Lock()
		defer seen.mu.Unlock()
		// A board that now presents a trusted key leaves no earlier refused one to trust.
		s.mu.Lock()
		if seen.change != nil {
			s.presented = seen.presented
		} else if seen.accepted {
			s.presented = nil
		}
		s.mu.Unlock()
		switch {
		case seen.change != nil:
			changed := boardError(CodeHostKeyChanged,
				fmt.Sprintf("%s presented a different SSH host key than the one Insight trusted.", s.target.Host),
				"This is expected after the board is reflashed. If you reflashed it, trust the new key; "+
					"otherwise check that the address still points to your board.", nil)
			changed.HostKey = seen.change
			return nil, nil, changed
		case seen.accepted && strings.Contains(err.Error(), "unable to authenticate"):
			return nil, nil, s.authFailed(err)
		default:
			return nil, nil, s.connectFailed(ctx, err)
		}
	}
	seen.mu.Lock()
	defer seen.mu.Unlock()
	return ssh.NewClient(cc, channels, requests), seen.presented, nil
}

// connectFailed words a failed connect: the caller's own end of ctx as it is, a board that
// did not answer, a name that does not resolve, anything else as unreachable.
func (s *sshTransport) connectFailed(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var dns *net.DNSError
	switch {
	case errors.As(err, &dns):
		return boardError(CodeUnreachable, fmt.Sprintf("The host name %s could not be resolved.", s.target.Host),
			"Use the board's IP address, or check DNS on this machine.", err)
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) || errors.Is(err, net.ErrClosed):
		return s.unreachable(fmt.Sprintf("%s did not answer on port %d within %s.",
			s.target.Host, s.target.Port, connectTimeout), err)
	default:
		return s.unreachable(fmt.Sprintf("Could not connect to %s:%d: %v", s.target.Host, s.target.Port, err), err)
	}
}

func (s *sshTransport) unreachable(message string, err error) *apierr.Error {
	return boardError(CodeUnreachable, message,
		fmt.Sprintf("Check that the board is powered on and on the network, and that `ssh -p %d %s` works from this machine.",
			s.target.Port, s.target.login()), err)
}

func (s *sshTransport) authFailed(err error) *apierr.Error {
	account := localAccount()
	command := fmt.Sprintf("ssh-copy-id -p %d %s", s.target.Port, s.target.login())
	if account == "root" {
		command = "sudo -H " + command
	}
	failed := boardError(CodeAuthFailed, fmt.Sprintf("SSH key authentication as %s on %s failed.", s.target.User, s.target.Host),
		fmt.Sprintf("Insight signs in with the SSH keys of the '%s' account on this machine. "+
			"Authorize one on the board, then retry: %s", account, command), err)
	failed.Command = command
	return failed
}

func (s *sshTransport) noKey() *apierr.Error {
	account := localAccount()
	sudo := ""
	if account == "root" {
		sudo = "sudo -H "
	}
	key := shellQuote(filepath.Join(s.sshDir, "id_ed25519"))
	command := fmt.Sprintf(`%sssh-keygen -t ed25519 -N "" -f %s && %sssh-copy-id -p %d %s`,
		sudo, key, sudo, s.target.Port, s.target.login())
	missing := boardError(CodeAuthFailed,
		fmt.Sprintf("The '%s' account on this machine has no SSH key to sign in to %s with.", account, s.target.Host),
		fmt.Sprintf("Insight signs in with the SSH keys of the '%s' account, and it has none. "+
			"Create one and authorize it on the board, then retry: %s", account, command), nil)
	missing.Command = command
	return missing
}

func localAccount() string {
	if account, err := user.Current(); err == nil {
		return account.Username
	}
	return "Insight service"
}

// loadSigners reads the keys of keyFiles in dir, skipping those that are missing or cannot be
// used without a passphrase. They are read at every connect, so a key made after Insight
// started is found.
func loadSigners(dir string) []ssh.Signer {
	var signers []ssh.Signer
	for _, name := range keyFiles {
		path := filepath.Join(dir, name)
		content, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			slog.Warn("skipping an SSH key Insight cannot read", "key", path, "error", err)
			continue
		}
		signer, err := ssh.ParsePrivateKey(content)
		var passphrase *ssh.PassphraseMissingError
		switch {
		case errors.As(err, &passphrase):
			slog.Warn("skipping a passphrase-protected SSH key", "key", path)
		case err != nil:
			slog.Warn("skipping an SSH key Insight cannot parse", "key", path, "error", err)
		default:
			signers = append(signers, signer)
		}
	}
	return signers
}

// sshProcess is a command in a session of its own.
type sshProcess struct {
	session *ssh.Session
	host    string
	out     io.Reader
	errs    io.Reader
	once    sync.Once
}

func (p *sshProcess) stdout() io.Reader { return p.out }
func (p *sshProcess) stderr() io.Reader { return p.errs }

func (p *sshProcess) wait() (int, error) {
	err := p.session.Wait()
	var exit *ssh.ExitError
	switch {
	case err == nil:
		return 0, nil
	case errors.As(err, &exit):
		return exit.ExitStatus(), nil
	default:
		return 0, boardError(CodeUnreachable, fmt.Sprintf("The SSH session to %s ended before the command finished.", p.host),
			"Check that the board is still powered on and on the network, then retry.", err)
	}
}

// kill asks the board's SSH server to kill the command, then closes its session: a command
// that still writes ends on the closed pipe even where the server ignores the signal.
func (p *sshProcess) kill() {
	p.once.Do(func() {
		_ = p.session.Signal(ssh.SIGKILL)
		_ = p.session.Close()
	})
}

// await runs f, returning early with ctx's error when ctx ends first; what f returns after
// that is handed to discard.
func await[T any](ctx context.Context, f func() (T, error), discard func(T)) (T, error) {
	type result struct {
		value T
		err   error
	}
	done := make(chan result, 1)
	go func() {
		value, err := f()
		done <- result{value, err}
	}()
	select {
	case r := <-done:
		return r.value, r.err
	case <-ctx.Done():
		go func() {
			if r := <-done; r.err == nil {
				discard(r.value)
			}
		}()
		var zero T
		return zero, ctx.Err()
	}
}
