package board

import (
	"log/slog"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

// Mode is how Insight reaches a board.
type Mode string

const (
	// ModeSSH reaches a board over SSH.
	ModeSSH Mode = "ssh"
	// ModeLocal is Insight running on the board itself.
	ModeLocal Mode = "local"
)

// Source is where a target comes from.
type Source string

const (
	// SourceManual is a board the user entered; it is kept in the registry's saved file.
	SourceManual Source = "manual"
	// SourceOnBoard is the board Insight runs on.
	SourceOnBoard Source = "on-board"
	// SourceSDKEnv is the DevKit the SDK is paired with (DEVKIT_SYNC_DEVKIT_*).
	SourceSDKEnv Source = "sdk-env"
)

// DefaultPort and DefaultUser are a DevKit's SSH port and account.
const (
	DefaultPort = 22
	DefaultUser = "sima"
)

// Target says which board to reach and how. A local target has no host, port or user.
type Target struct {
	Mode   Mode   `json:"mode"`
	Host   string `json:"host,omitempty"`
	Port   int    `json:"port,omitempty"`
	User   string `json:"user,omitempty"`
	Source Source `json:"source"`
}

// ID names the board in URLs: "ssh:sima@192.168.1.20:22", "ssh:sima@[fe80::1%eth0]:22" or
// "local". The source is not part of it: the same address is the same board.
func (t Target) ID() string {
	if t.Mode == ModeLocal {
		return "local"
	}
	return "ssh:" + t.User + "@" + t.address()
}

// Label is the board's name for people: "This board", or user@host with :port off port 22.
func (t Target) Label() string {
	if t.Mode == ModeLocal {
		return "This board"
	}
	if t.Port == DefaultPort {
		return t.User + "@" + t.Host
	}
	return t.User + "@" + t.address()
}

// address is host:port as a dialer takes it.
func (t Target) address() string { return net.JoinHostPort(t.Host, strconv.Itoa(t.Port)) }

// LocalTarget is the board Insight runs on.
func LocalTarget() Target { return Target{Mode: ModeLocal, Source: SourceOnBoard} }

var (
	hostPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$`)
	userPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$`)
)

// SSHTarget checks an SSH address and makes its target. A port of 0 is DefaultPort and an
// empty user DefaultUser. The host is a host name or any IP address, a zoned IPv6 one too.
func SSHTarget(host string, port int, user string, source Source) (Target, error) {
	host, user = strings.TrimSpace(host), strings.TrimSpace(user)
	if port == 0 {
		port = DefaultPort
	}
	if user == "" {
		user = DefaultUser
	}
	if !validHost(host) {
		return Target{}, &Error{Code: CodeInvalidRequest,
			Message: "Enter the board's IP address or host name.", Hint: "For example 192.168.2.2"}
	}
	if port < 1 || port > 65535 {
		return Target{}, &Error{Code: CodeInvalidRequest,
			Message: "The SSH port must be between 1 and 65535.", Hint: "DevKits use port 22."}
	}
	if !userPattern.MatchString(user) {
		return Target{}, &Error{Code: CodeInvalidRequest,
			Message: "Enter a valid SSH user name.", Hint: "DevKits use the 'sima' account."}
	}
	return Target{Mode: ModeSSH, Host: host, Port: port, User: user, Source: source}, nil
}

func validHost(host string) bool {
	if hostPattern.MatchString(host) {
		return true
	}
	// An IPv6 address with a zone ("fe80::1%eth0") has a % the pattern refuses.
	_, err := netip.ParseAddr(host)
	return err == nil
}

// sdkTarget is the DevKit the SDK is paired with: sima-cli's SDK setup exports
// DEVKIT_SYNC_DEVKIT_IP (an IP address), and devkit.sh DEVKIT_SYNC_DEVKIT_PORT and _USER. An
// unusable value is logged and ignored, so Insight starts without that board.
func sdkTarget(env func(string) string) (Target, bool) {
	host := strings.TrimSpace(env("DEVKIT_SYNC_DEVKIT_IP"))
	if host == "" {
		return Target{}, false
	}
	if _, err := netip.ParseAddr(host); err != nil {
		slog.Warn("ignoring DEVKIT_SYNC_DEVKIT_IP: not an IP address", "value", host)
		return Target{}, false
	}
	port := DefaultPort
	if value := strings.TrimSpace(env("DEVKIT_SYNC_DEVKIT_PORT")); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			slog.Warn("ignoring the SDK's DevKit: DEVKIT_SYNC_DEVKIT_PORT is not a number", "value", value)
			return Target{}, false
		}
		port = parsed
	}
	target, err := SSHTarget(host, port, env("DEVKIT_SYNC_DEVKIT_USER"), SourceSDKEnv)
	if err != nil {
		slog.Warn("ignoring the SDK's DevKit from the environment", "error", err)
		return Target{}, false
	}
	return target, true
}

// shellJoin quotes argv into one command line for the remote shell, as Python's shlex.join.
func shellJoin(argv []string) string {
	quoted := make([]string, len(argv))
	for i, arg := range argv {
		quoted[i] = shellQuote(arg)
	}
	return strings.Join(quoted, " ")
}

var shellSafe = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

func shellQuote(arg string) string {
	if shellSafe.MatchString(arg) {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'"'"'`) + "'"
}
