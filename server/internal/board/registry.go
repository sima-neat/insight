package board

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"

	"golang.org/x/crypto/ssh"
)

// Config says where a Registry finds its boards and keeps what it learns.
type Config struct {
	// SavedFile keeps the board the user entered, as {"host", "port", "user"} (the old
	// backend's board-target.json). Written atomically.
	SavedFile string
	// KnownHosts is Insight's own known_hosts file, not the user's.
	KnownHosts string
	// SSHDir holds the keys Insight signs in with: the service account's ~/.ssh.
	SSHDir string
	// OnBoard says Insight runs on a SiMa board, which is then a target of its own.
	OnBoard bool
	// Env reads the environment, for the DevKit the SDK is paired with; read once.
	Env func(string) string
	// SentinelSocket is Sentinel's API socket on the boards; "" is SentinelSocket.
	SentinelSocket string
}

// Registry holds the known targets and the one selected board: the one the user entered,
// else the board Insight runs on, else the DevKit the SDK is paired with. Only the selected
// board has a Board, and so a connection.
type Registry struct {
	config  Config
	hosts   *knownHosts
	derived []Target // the board Insight runs on, then the SDK's DevKit

	mu       sync.Mutex
	manual   *Target
	selected *Board
}

// NewRegistry reads the saved board and the environment. A saved file that cannot be read is
// logged and ignored, as an environment value that names no board.
func NewRegistry(config Config) *Registry {
	if config.SentinelSocket == "" {
		config.SentinelSocket = SentinelSocket
	}
	r := &Registry{config: config, hosts: &knownHosts{path: config.KnownHosts}}
	if config.OnBoard {
		r.derived = append(r.derived, LocalTarget())
	}
	if target, ok := sdkTarget(config.Env); ok {
		r.derived = append(r.derived, target)
	}
	if target, err := r.load(); err != nil {
		slog.Warn("ignoring the saved board", "file", config.SavedFile, "error", err)
	} else {
		r.manual = target
	}
	r.mu.Lock()
	r.sync()
	r.mu.Unlock()
	return r
}

// Targets are the known targets in the order the selection prefers them, the selected one
// first. A board found twice (entered and paired) is listed once, by its first source.
func (r *Registry) Targets() []Target {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.targets()
}

func (r *Registry) targets() []Target {
	var targets []Target
	seen := map[string]bool{}
	candidates := r.derived
	if r.manual != nil {
		candidates = append([]Target{*r.manual}, candidates...)
	}
	for _, target := range candidates {
		if !seen[target.ID()] {
			seen[target.ID()] = true
			targets = append(targets, target)
		}
	}
	return targets
}

// Selected is the selected board; CodeNoTarget when there is none.
func (r *Registry) Selected() (*Board, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.selected == nil {
		return nil, boardError(CodeNoTarget, "No board is selected.",
			"Enter the board's address, pair the SDK with `sima-cli sdk setup --devkit <ip>`, or run Insight on the board.", nil)
	}
	return r.selected, nil
}

// Board is the selected board when id names it; CodeNotFound otherwise, which is also what a
// request about a board replaced since gets.
func (r *Registry) Board(id string) (*Board, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.board(id)
}

func (r *Registry) board(id string) (*Board, error) {
	if r.selected == nil || r.selected.ID() != id {
		return nil, boardError(CodeNotFound, fmt.Sprintf("%s is not the selected board.", id),
			"Read the boards again and use the selected one.", nil)
	}
	return r.selected, nil
}

// Select saves an SSH target as the board the user entered and selects it. A different board
// than the one selected replaces it: the old one is closed.
func (r *Registry) Select(target Target) (*Board, error) {
	if target.Mode != ModeSSH {
		return nil, boardError(CodeInvalidRequest, "Only a board reached over SSH can be entered.",
			"Forget the entered board to use the board Insight runs on.", nil)
	}
	target, err := SSHTarget(target.Host, target.Port, target.User, SourceManual)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.save(&target); err != nil {
		return nil, err
	}
	r.manual = &target
	r.sync()
	return r.selected, nil
}

// Forget drops the board the user entered; the selection falls back to the board Insight runs
// on or the SDK's DevKit, if any.
func (r *Registry) Forget() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.save(nil); err != nil {
		return err
	}
	r.manual = nil
	r.sync()
	return nil
}

// TrustHostKey trusts the host key the board id presented when it was refused, which the
// user confirmed by its fingerprint (the host key change's presented fingerprint), and replaces the board: the
// trusted key may be another board's, so nothing carries over from the old one.
func (r *Registry) TrustHostKey(id, fingerprint string) (*Board, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	old, err := r.board(id)
	if err != nil {
		return nil, err
	}
	key := old.t.presentedKey()
	if key == nil || ssh.FingerprintSHA256(key) != fingerprint {
		return nil, boardError(CodeInvalidRequest, "That host key is not the one the board presented.",
			"Check the connection again and confirm the fingerprint it reports.", nil)
	}
	if err := r.hosts.replace(old.Target().address(), key); err != nil {
		return nil, err
	}
	old.close()
	r.selected = r.newBoard(old.Target())
	return r.selected, nil
}

// Close closes the selected board, at shutdown.
func (r *Registry) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.selected != nil {
		r.selected.close()
		r.selected = nil
	}
}

// sync makes the selected board the first target's, replacing a board of another id.
func (r *Registry) sync() {
	targets := r.targets()
	if len(targets) == 0 {
		if r.selected != nil {
			r.selected.close()
			r.selected = nil
		}
		return
	}
	wanted := targets[0]
	if r.selected != nil && r.selected.ID() == wanted.ID() {
		r.selected.setSource(wanted.Source)
		return
	}
	if r.selected != nil {
		r.selected.close()
	}
	r.selected = r.newBoard(wanted)
}

func (r *Registry) newBoard(target Target) *Board {
	if target.Mode == ModeLocal {
		return newBoard(target, newLocalTransport(r.config.SentinelSocket), r.config.SentinelSocket)
	}
	t := newSSHTransport(target, r.hosts, r.config.SSHDir, r.config.SentinelSocket)
	return newBoard(target, t, r.config.SentinelSocket)
}

// savedTarget is the saved file's content.
type savedTarget struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`
}

func (r *Registry) load() (*Target, error) {
	content, err := os.ReadFile(r.config.SavedFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var saved savedTarget
	if err := json.Unmarshal(content, &saved); err != nil {
		return nil, err
	}
	target, err := SSHTarget(saved.Host, saved.Port, saved.User, SourceManual)
	if err != nil {
		return nil, err
	}
	return &target, nil
}

// save writes target to the saved file, or removes the file for nil.
func (r *Registry) save(target *Target) error {
	if target == nil {
		if err := os.Remove(r.config.SavedFile); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("forgetting the saved board: %w", err)
		}
		return nil
	}
	content, err := json.MarshalIndent(savedTarget{Host: target.Host, Port: target.Port, User: target.User}, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(r.config.SavedFile, append(content, '\n')); err != nil {
		return fmt.Errorf("saving the board: %w", err)
	}
	return nil
}
