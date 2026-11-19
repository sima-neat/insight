package board

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"

	"insight/api"
)

// knownHosts is Insight's own known_hosts file, not the user's: the first key a board presents
// is trusted and saved (accept-new), a different one later is refused until the user trusts it.
//
// Insight writes it with plain host names, one per line, as the old backend (paramiko) did, so
// its file carries over. Hashed names, patterns and markers, which Insight never writes, match
// nothing here.
type knownHosts struct {
	path string
	mu   sync.Mutex
}

// check decides on the key a board at address (host:port) presents: nil when it is trusted or
// was just saved as the first one, the change when another one is trusted.
func (k *knownHosts) check(address string, key ssh.PublicKey) (*api.HostKeyChange, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	name := knownhosts.Normalize(address)
	content, err := k.read()
	if err != nil {
		return nil, err
	}
	trusted := keysFor(content, name)
	if len(trusted) == 0 {
		line := knownhosts.Line([]string{address}, key) + "\n"
		if len(content) > 0 && !bytes.HasSuffix(content, []byte("\n")) {
			line = "\n" + line
		}
		return nil, k.write(append(content, line...))
	}
	marshaled := key.Marshal()
	for _, known := range trusted {
		if bytes.Equal(known.Marshal(), marshaled) {
			return nil, nil
		}
	}
	// The connection asks only for the trusted keys' types (algorithms), so one of them is the
	// type presented; the first stands in when none is.
	expected := trusted[0]
	for _, known := range trusted {
		if known.Type() == key.Type() {
			expected = known
			break
		}
	}
	return &api.HostKeyChange{
		Host:      name,
		Expected:  ssh.FingerprintSHA256(expected),
		Presented: ssh.FingerprintSHA256(key),
	}, nil
}

// algorithms are the host key algorithms to ask a board at address for: those of the keys
// trusted for it, so a board that has keys of several types presents the trusted one, not
// whichever the client prefers, which would read as a changed key. None asks for any.
func (k *knownHosts) algorithms(address string) ([]string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	content, err := k.read()
	if err != nil {
		return nil, err
	}
	var algorithms []string
	for _, key := range keysFor(content, knownhosts.Normalize(address)) {
		for _, algorithm := range algorithmsFor(key.Type()) {
			if !slices.Contains(algorithms, algorithm) {
				algorithms = append(algorithms, algorithm)
			}
		}
	}
	return algorithms, nil
}

func algorithmsFor(keyType string) []string {
	if keyType == ssh.KeyAlgoRSA {
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA}
	}
	return []string{keyType}
}

// replace makes key the one key trusted for address, dropping the others.
func (k *knownHosts) replace(address string, key ssh.PublicKey) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	name := knownhosts.Normalize(address)
	content, err := k.read()
	if err != nil {
		return err
	}
	var out bytes.Buffer
	for _, line := range bytes.SplitAfter(content, []byte("\n")) {
		hosts, rest, ok := entry(line)
		if !ok || !slices.Contains(hosts, name) {
			out.Write(line)
			continue
		}
		// A line that names other hosts too keeps them.
		if others := slices.DeleteFunc(hosts, func(h string) bool { return h == name }); len(others) > 0 {
			out.WriteString(strings.Join(others, ",") + " " + rest)
		}
	}
	if out.Len() > 0 && !bytes.HasSuffix(out.Bytes(), []byte("\n")) {
		out.WriteString("\n")
	}
	out.WriteString(knownhosts.Line([]string{address}, key) + "\n")
	return k.write(out.Bytes())
}

// keysFor are the keys content trusts for the known_hosts name ("host" or "[host]:port").
func keysFor(content []byte, name string) []ssh.PublicKey {
	var keys []ssh.PublicKey
	for _, line := range bytes.Split(content, []byte("\n")) {
		marker, hosts, key, _, _, err := ssh.ParseKnownHosts(line)
		if err != nil || marker != "" || !slices.Contains(hosts, name) {
			continue
		}
		keys = append(keys, key)
	}
	return keys
}

// entry splits a plain known_hosts line into its host names and the rest (key type, key,
// comment, line end); ok is false for a comment, a blank line, a marker or a malformed line.
func entry(line []byte) (hosts []string, rest string, ok bool) {
	marker, _, _, _, _, err := ssh.ParseKnownHosts(line)
	if err != nil || marker != "" {
		return nil, "", false
	}
	text := strings.TrimLeft(string(line), " \t")
	field, rest, found := strings.Cut(text, " ")
	if !found {
		return nil, "", false
	}
	return strings.Split(field, ","), strings.TrimLeft(rest, " \t"), true
}

func (k *knownHosts) read() ([]byte, error) {
	content, err := os.ReadFile(k.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading Insight's known_hosts: %w", err)
	}
	return content, nil
}

func (k *knownHosts) write(content []byte) error {
	if err := writeFileAtomic(k.path, content); err != nil {
		return fmt.Errorf("saving Insight's known_hosts: %w", err)
	}
	return nil
}

// writeFileAtomic replaces path with content, readable by the owner only: a reader sees the
// old file or the new one, never part of one.
func writeFileAtomic(path string, content []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	_, err = tmp.Write(content)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		_ = os.Remove(tmp.Name()) // the temporary file this call just created
	}
	return err
}
