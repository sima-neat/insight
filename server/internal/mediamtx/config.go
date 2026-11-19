package mediamtx

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

const (
	// passwordPlaceholder is the unusable hash webrtc/mediamtx.yml ships as the API user's
	// password; a MediaMTX started on the shipped file has an API no one can use.
	passwordPlaceholder = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	// publisherPlaceholder stands in the shipped file for the publisher tag of the stream
	// MediaMTX itself starts, the webcam normalizer's output on srcN.
	publisherPlaceholder = publisherKey + "=insight-unrendered"
	// RuntimeConfigName is the name of the rendered copy WriteConfig writes.
	RuntimeConfigName = "mediamtx.yml"
)

var (
	passwordChars  = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	publisherChars = regexp.MustCompile(`^[a-z0-9-]+$`)
)

// RenderConfig returns MediaMTX's shipped configuration with this run's secrets in place: the
// API user's password, and the publisher tag on the webcam normalizer's output, so that stream
// reads as Insight's own and not as an external publisher on the webcam's slot.
//
// Text substitution is enough, and a YAML library would rewrite the file's comments and layout:
// each placeholder is a string no other line holds, and the values are limited to characters
// that need no escaping in a double-quoted YAML string or in the normalizer's command line.
// The password is quoted so that one like "null" or "true" stays a string rather than turning
// into YAML's null (no password, an open API) or a boolean.
func RenderConfig(shipped []byte, s Secrets) ([]byte, error) {
	if !passwordChars.MatchString(s.APIPassword) {
		return nil, fmt.Errorf("the API password may hold letters, digits, '-' and '_' only")
	}
	if !publisherChars.MatchString(s.Publisher) {
		return nil, fmt.Errorf("the publisher tag may hold lowercase letters, digits and '-' only")
	}
	// Exactly one: a second placeholder would hand the API password to another user.
	if n := bytes.Count(shipped, []byte(passwordPlaceholder)); n != 1 {
		return nil, fmt.Errorf("the configuration holds the API password placeholder %d times, not once", n)
	}
	if !bytes.Contains(shipped, []byte(publisherPlaceholder)) {
		return nil, fmt.Errorf("the configuration has no publisher tag placeholder (%s)", publisherPlaceholder)
	}
	rendered := bytes.Replace(shipped, []byte(passwordPlaceholder), []byte(`"`+s.APIPassword+`"`), 1)
	return bytes.ReplaceAll(rendered, []byte(publisherPlaceholder), []byte(s.PublisherQuery())), nil
}

// WriteConfig renders the shipped configuration at shippedPath and writes it to
// dir/mediamtx.yml (dir is created), readable by the owner only since it holds the API
// password. It returns the written file's path. The file is replaced whole, never left half
// written.
func WriteConfig(shippedPath, dir string, s Secrets) (string, error) {
	shipped, err := os.ReadFile(shippedPath)
	if err != nil {
		return "", fmt.Errorf("reading MediaMTX's configuration: %w", err)
	}
	rendered, err := RenderConfig(shipped, s)
	if err != nil {
		return "", fmt.Errorf("%s: %w; the package is broken, rebuild it with build.sh", shippedPath, err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("creating %s: %w", dir, err)
	}
	// CreateTemp makes the file readable and writable by its owner only.
	tmp, err := os.CreateTemp(dir, RuntimeConfigName+".*.tmp")
	if err != nil {
		return "", fmt.Errorf("writing MediaMTX's runtime configuration: %w", err)
	}
	_, err = tmp.Write(rendered)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	path := filepath.Join(dir, RuntimeConfigName)
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		_ = os.Remove(tmp.Name()) // the temporary file this call made
		return "", fmt.Errorf("writing MediaMTX's runtime configuration: %w", err)
	}
	return path, nil
}
