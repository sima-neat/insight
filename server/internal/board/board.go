// Package board is Insight's connection to a SiMa DevKit board, which Peripherals, Stats and
// the Board dialog use: the known boards and the selected one (Registry), and the operations
// on one (Board): run a command, stream a long-running one, ask Sentinel, read the identity.
//
// A board over SSH has one connection, made on first use, shared by every operation (each a
// channel of its own), made again after it was lost and closed when the board is replaced.
// Insight signs in with the service account's keys only, and pins host keys in a known_hosts
// file of its own. Sentinel's API socket is reached through that connection's Unix-socket
// forwarding, so no process starts on the board per request. When Insight runs on the board
// itself, the same operations run as local processes and on the local socket.
package board

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"

	"insight/internal/apierr"
)

// SentinelSocket is where Sentinel's API listens on a board.
const SentinelSocket = "/run/simaai-sentinel/api.sock"

// transport is how a board's operations reach it: over SSH, or locally.
type transport interface {
	start(ctx context.Context, argv []string) (process, error)
	dialSentinel(ctx context.Context) (net.Conn, error)
	// hostKey is the SHA256 fingerprint of the board's host key, "" before a connection or
	// for the local board.
	hostKey() string
	// presentedKey is the host key the last refused connection presented, or nil.
	presentedKey() ssh.PublicKey
	close()
}

// Board is one board and its connection. A Board that was replaced (another board selected,
// its host key trusted) is closed: what still runs on it ends, and every operation fails
// with CodeBoardChanged.
type Board struct {
	t        transport
	socket   string
	sentinel *http.Client

	mu     sync.Mutex
	target Target
	status Status
	closed bool
}

// ConnectionState is what the last contact with a board found.
type ConnectionState string

const (
	// StateUnknown: no contact yet.
	StateUnknown ConnectionState = "unknown"
	// StateConnected: the last identity read succeeded.
	StateConnected ConnectionState = "connected"
	// StateError: the last connection or identity read failed.
	StateError ConnectionState = "error"
)

// Status is a board's last connection result, for the Board dialog.
type Status struct {
	State ConnectionState
	// CheckedAt is when it was found; zero while StateUnknown.
	CheckedAt time.Time
	// Err is the failure while StateError.
	Err *apierr.Error
	// Identity is the last identity read, kept through later failures.
	Identity *Identity
}

// Identity is what a board says about itself. A fact it does not report is "".
type Identity struct {
	Hostname string
	// Machine is /etc/build's MACHINE ("modalix"), Build its SIMA_BUILD_VERSION.
	Machine, Build string
	// HostKey is the SHA256 fingerprint of the board's SSH host key; "" for the local board.
	// With host keys pinned it tells two boards at one address apart.
	HostKey string
}

func newBoard(target Target, t transport, socket string) *Board {
	b := &Board{t: t, socket: socket, target: target, status: Status{State: StateUnknown}}
	b.sentinel = &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return b.dialSentinel(ctx) },
		// A connection is a channel on the board's SSH connection, which may be replaced
		// between requests; a new one per request costs one round trip.
		DisableKeepAlives: true,
	}}
	return b
}

// ID is the board's target's ID.
func (b *Board) ID() string { return b.Target().ID() }

// Target is the board's target.
func (b *Board) Target() Target {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.target
}

// Status is the board's last connection result.
func (b *Board) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.status
}

// Run runs argv on the board, its stdin empty, and gives its exit status and output once it
// ends. It fails, and the command is killed, when ctx ends first (CodeTimeout
// for a deadline) or the output grows past MaxOutput (CodeCommandFailed). A program the board
// does not have is no failure: it exits 127, as a shell reports it. Over SSH, argv is quoted
// into one command line for the account's shell.
func (b *Board) Run(ctx context.Context, argv []string) (Result, error) {
	p, err := b.start(ctx, argv)
	if err != nil {
		return Result{}, err
	}
	result, err := collect(ctx, p, argv)
	if err != nil {
		return Result{}, b.failed(ctx, err, argv[0])
	}
	return result, nil
}

// streamStartTimeout bounds the start of a Stream, which a caller's context may not: a preview
// outlives its request. A board that takes the connection but answers no session leaves the
// start waiting otherwise.
const streamStartTimeout = 15 * time.Second

// Stream starts argv on the board and gives its stdout as it comes, for output that does not
// end by itself (a camera preview, a microphone recording). The start fails after
// streamStartTimeout, or when ctx ends first; closing the stream, or the end of ctx, kills the
// command.
func (b *Board) Stream(ctx context.Context, argv []string) (*Stream, error) {
	start, cancel := context.WithTimeout(ctx, streamStartTimeout)
	defer cancel()
	p, err := b.start(start, argv)
	if err != nil {
		return nil, err
	}
	return newStream(ctx, p), nil
}

func (b *Board) start(ctx context.Context, argv []string) (process, error) {
	if len(argv) == 0 {
		return nil, boardError(CodeInvalidRequest, "No command to run.", "", nil)
	}
	if b.isClosed() {
		return nil, boardChanged()
	}
	p, err := b.t.start(ctx, argv)
	if err != nil {
		return nil, b.failed(ctx, err, argv[0])
	}
	return p, nil
}

// failed is what an operation's caller gets for err: CodeBoardChanged once the board was
// replaced, CodeTimeout for ctx's deadline, err otherwise. A connection failure is recorded
// in the status.
func (b *Board) failed(ctx context.Context, err error, what string) error {
	if b.isClosed() {
		return boardChanged()
	}
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() != nil {
		return boardError(CodeTimeout, fmt.Sprintf("`%s` did not finish in time on %s.", what, b.Target().Label()),
			"The board may be busy. Retry the action; if it keeps timing out, check the board's load over SSH.", err)
	}
	var failure *apierr.Error
	if errors.As(err, &failure) {
		switch failure.Code {
		case CodeUnreachable, CodeAuthFailed, CodeHostKeyChanged:
			b.record(Status{State: StateError, Err: failure})
		}
	}
	return err
}

// Sentinel sends one request to the board's Sentinel API, path with its query
// ("/v1/samples/latest"), body as JSON or nil. The answer is Sentinel's as it is, whatever its
// status; the caller closes its body and bounds how much of it it reads. ctx bounds the
// request and the body's read. A socket that cannot be reached fails with
// CodeSentinelMissing, CodeSentinelDenied or CodeSentinelFailed.
func (b *Board) Sentinel(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, boardError(CodeInvalidRequest, fmt.Sprintf("Sentinel path %q does not start with /.", path), "", nil)
	}
	// Sentinel's own client sends Host: localhost.
	request, err := http.NewRequestWithContext(ctx, method, "http://localhost"+path, body)
	if err != nil {
		return nil, boardError(CodeInvalidRequest, "Not a Sentinel request.", "", err)
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := b.sentinel.Do(request)
	if err == nil {
		return response, nil
	}
	var failure *apierr.Error
	switch {
	case errors.As(err, &failure):
		return nil, failure
	case b.isClosed():
		return nil, boardChanged()
	case errors.Is(err, context.DeadlineExceeded) && ctx.Err() != nil:
		return nil, b.sentinelError(CodeTimeout, "%s on %s did not answer before the request timed out.",
			"Check `systemctl status simaai-sentinel` on the board.", err)
	case ctx.Err() != nil:
		return nil, ctx.Err()
	default:
		return nil, b.sentinelError(CodeSentinelFailed, "%s on %s could not be used.",
			"Check `systemctl status simaai-sentinel` on the board.", err)
	}
}

func (b *Board) dialSentinel(ctx context.Context) (net.Conn, error) {
	if b.isClosed() {
		return nil, boardChanged()
	}
	conn, err := b.t.dialSentinel(ctx)
	if err == nil {
		return conn, nil
	}
	var failure *apierr.Error
	switch {
	case ctx.Err() != nil:
		return nil, ctx.Err()
	case errors.As(err, &failure):
		return nil, b.failed(ctx, err, "Sentinel")
	case errors.Is(err, syscall.ENOENT), errors.Is(err, syscall.ENOTDIR):
		return nil, b.sentinelMissing(err)
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return nil, b.sentinelDenied(err)
	case errors.Is(err, syscall.ECONNREFUSED):
		return nil, b.sentinelError(CodeSentinelMissing, "Nothing is listening on %s on %s.", startHint, err)
	}
	var refused *ssh.OpenChannelError
	if errors.As(err, &refused) {
		return nil, b.diagnoseSocket(ctx, err)
	}
	return nil, b.sentinelError(CodeSentinelFailed, "%s on %s could not be used.",
		"Check `systemctl status simaai-sentinel` on the board.", err)
}

// socketScript tells why the board's SSH server could not open the socket "$1": its refusal
// does not say (OpenSSH answers "open failed" for any failure).
const socketScript = `if [ ! -S "$1" ]; then echo missing; elif [ ! -w "$1" ]; then echo denied; else echo present; fi`

const startHint = "Start it on the board with `sudo systemctl start simaai-sentinel`, then retry."

func (b *Board) diagnoseSocket(ctx context.Context, cause error) error {
	result, err := b.Run(ctx, []string{"sh", "-c", socketScript, "sh", b.socket})
	if err != nil {
		return err
	}
	switch strings.TrimSpace(string(result.Stdout)) {
	case "missing":
		return b.sentinelMissing(cause)
	case "denied":
		return b.sentinelDenied(cause)
	case "present":
		return b.sentinelError(CodeSentinelMissing, "%s on %s exists, but could not be opened over SSH.",
			"Start Sentinel on the board with `sudo systemctl start simaai-sentinel`. If it runs, the board's SSH "+
				"server may not allow Unix-socket forwarding (AllowStreamLocalForwarding in sshd_config).", cause)
	default:
		return b.sentinelError(CodeSentinelFailed, "%s on %s could not be used.",
			"Check `systemctl status simaai-sentinel` on the board.", cause)
	}
}

func (b *Board) sentinelMissing(cause error) *apierr.Error {
	return b.sentinelError(CodeSentinelMissing, "%s does not exist on %s.",
		"Install Sentinel on the board with `sima-cli neat install sentinel`, then retry.", cause)
}

func (b *Board) sentinelDenied(cause error) *apierr.Error {
	return b.sentinelError(CodeSentinelDenied, "%s on %s cannot be opened by this user.",
		"The socket is normally mode 0666. Check its permissions on the board, or connect as a user that may open it.", cause)
}

// sentinelError words a socket failure; message takes the socket's name and the board's label.
func (b *Board) sentinelError(code, message, hint string, cause error) *apierr.Error {
	socket := fmt.Sprintf("Sentinel's API socket %s", b.socket)
	return boardError(code, fmt.Sprintf(message, socket, b.Target().Label()), hint, cause)
}

// identityScript prints the board's host name, then /etc/build, where a SiMa board names its
// machine and build.
const identityScript = "hostname; echo @@; cat /etc/build /etc/buildinfo 2>/dev/null"

// Identity reads what the board says about itself and records the result in the status.
func (b *Board) Identity(ctx context.Context) (Identity, error) {
	result, err := b.Run(ctx, []string{"sh", "-c", identityScript})
	if err != nil {
		return Identity{}, err
	}
	hostname, build, _ := strings.Cut(string(result.Stdout), "@@")
	identity := Identity{Hostname: strings.TrimSpace(hostname), HostKey: b.t.hostKey()}
	for line := range strings.Lines(build) {
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		switch strings.TrimSpace(key) {
		case "MACHINE":
			identity.Machine = strings.TrimSpace(value)
		case "SIMA_BUILD_VERSION":
			identity.Build = strings.TrimSpace(value)
		}
	}
	if identity.Hostname == "" && identity.Machine == "" && identity.Build == "" {
		failure := boardError(CodeCommandFailed, "Could not read the board's identity.",
			"Check that `sh`, `hostname` and `cat` run for this user on the board over SSH.", nil)
		b.record(Status{State: StateError, Err: failure})
		return Identity{}, failure
	}
	b.record(Status{State: StateConnected, Identity: &identity})
	return identity, nil
}

// record sets the status, keeping the last identity through a failure.
func (b *Board) record(status Status) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	status.CheckedAt = time.Now()
	if status.Identity == nil {
		status.Identity = b.status.Identity
	}
	b.status = status
}

func (b *Board) isClosed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.closed
}

// close ends the board's connection and what runs on it.
func (b *Board) close() {
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	b.t.close()
}

// setSource changes where the board's target comes from, keeping its connection: the same
// address is the same board.
func (b *Board) setSource(source Source) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.target.Source = source
}
