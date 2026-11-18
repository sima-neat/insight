// Package certs finds the TLS certificate Insight serves HTTPS with.
//
// In order: the SDK's own certificate, a valid one Insight made before, or a new one made with
// mkcert. Insight never installs mkcert itself: when it is missing, the error says how to.
package certs

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Pair is a certificate file and its private key file.
type Pair struct {
	CertFile string
	KeyFile  string
	// Source says where the pair came from: "sdk", "existing" or "mkcert".
	Source string
}

// Options say where to look.
type Options struct {
	// SDKDir holds the SDK's certificate (/sdk-cert).
	SDKDir string
	// DataDir is where Insight keeps the pair it made.
	DataDir string
	// Hosts the certificate must cover: the machine's address; 127.0.0.1 and localhost are added.
	Hosts []string
	// Mkcert runs mkcert; nil looks it up on PATH.
	Mkcert func(args ...string) error
	// Now is the current time; nil is time.Now.
	Now func() time.Time
}

// SDKCertName is the SDK's certificate; its key is one of SDKKeyNames, or inside it.
const SDKCertName = "neat-sdk.pem"

// SDKKeyNames are where the SDK's private key may be, in order.
var SDKKeyNames = []string{"neat-sdk-key.pem", "neat-sdk.key", "key.pem", SDKCertName}

// Resolve finds or makes the pair.
func Resolve(opts Options) (Pair, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if pair, ok, err := sdkPair(opts.SDKDir); ok || err != nil {
		return pair, err
	}
	subjects := Subjects(opts.Hosts)
	pair := Pair{
		CertFile: filepath.Join(opts.DataDir, "cert.pem"),
		KeyFile:  filepath.Join(opts.DataDir, "key.pem"),
	}
	if _, err := os.Stat(pair.CertFile); err == nil {
		problem := check(pair, subjects, opts.Now())
		if problem == "" {
			pair.Source = "existing"
			return pair, nil
		}
		slog.Warn("making a new certificate", "reason", problem)
	}
	mkcert := opts.Mkcert
	if mkcert == nil {
		path, err := exec.LookPath("mkcert")
		if err != nil {
			return Pair{}, errors.New("mkcert is not installed: Insight needs it to make a trusted " +
				"HTTPS certificate. Install it (https://github.com/FiloSottile/mkcert#installation, " +
				"or `sudo apt install mkcert` on Ubuntu) and start Insight again")
		}
		mkcert = func(args ...string) error {
			out, err := exec.Command(path, args...).CombinedOutput()
			if err != nil {
				return fmt.Errorf("mkcert %s: %w\n%s", strings.Join(args, " "), err, out)
			}
			return nil
		}
	}
	if err := makePair(pair, subjects, mkcert); err != nil {
		return Pair{}, err
	}
	pair.Source = "mkcert"
	return pair, nil
}

// Subjects are the names a certificate covers: hosts, then 127.0.0.1 and localhost, once each.
func Subjects(hosts []string) []string {
	var subjects []string
	for _, subject := range append(slices.Clone(hosts), "127.0.0.1", "localhost") {
		if subject != "" && !slices.Contains(subjects, subject) {
			subjects = append(subjects, subject)
		}
	}
	return subjects
}

func sdkPair(dir string) (Pair, bool, error) {
	if dir == "" {
		return Pair{}, false, nil
	}
	certFile := filepath.Join(dir, SDKCertName)
	if _, err := os.Stat(certFile); errors.Is(err, os.ErrNotExist) {
		return Pair{}, false, nil
	}
	var problems []string
	for _, name := range SDKKeyNames {
		keyFile := filepath.Join(dir, name)
		if _, err := os.Stat(keyFile); err != nil {
			continue
		}
		if _, err := tls.LoadX509KeyPair(certFile, keyFile); err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", keyFile, err))
			continue
		}
		return Pair{CertFile: certFile, KeyFile: keyFile, Source: "sdk"}, true, nil
	}
	if len(problems) == 0 {
		problems = append(problems, "no private key next to it")
	}
	return Pair{}, true, fmt.Errorf("%s is no usable certificate (%s)", certFile, strings.Join(problems, "; "))
}

// check says what is wrong with an existing pair, or "" when it can be used.
func check(pair Pair, subjects []string, now time.Time) string {
	loaded, err := tls.LoadX509KeyPair(pair.CertFile, pair.KeyFile)
	if err != nil {
		return err.Error()
	}
	cert, err := x509.ParseCertificate(loaded.Certificate[0])
	if err != nil {
		return err.Error()
	}
	if !now.Before(cert.NotAfter) {
		return "the certificate has expired"
	}
	var missing []string
	for _, subject := range subjects {
		if address, err := netip.ParseAddr(subject); err == nil {
			if !slices.ContainsFunc(cert.IPAddresses, func(ip net.IP) bool {
				covered, ok := netip.AddrFromSlice(ip)
				return ok && covered.Unmap() == address
			}) {
				missing = append(missing, subject)
			}
		} else if !slices.Contains(cert.DNSNames, subject) {
			missing = append(missing, subject)
		}
	}
	if len(missing) > 0 {
		return "the certificate does not cover " + strings.Join(missing, ", ")
	}
	return ""
}

// makePair has mkcert write a new pair into a temporary folder beside the old one, then moves
// it into place, so a failed run leaves the old pair as it was.
func makePair(pair Pair, subjects []string, mkcert func(args ...string) error) error {
	dir := filepath.Dir(pair.CertFile)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := mkcert("-install"); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(dir, "mkcert-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp) // the folder MkdirTemp just made, and only it
	tmpCert, tmpKey := filepath.Join(tmp, "cert.pem"), filepath.Join(tmp, "key.pem")
	args := append([]string{"-cert-file", tmpCert, "-key-file", tmpKey}, subjects...)
	if err := mkcert(args...); err != nil {
		return err
	}
	if err := os.Chmod(tmpKey, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmpCert, pair.CertFile); err != nil {
		return err
	}
	return os.Rename(tmpKey, pair.KeyFile)
}
