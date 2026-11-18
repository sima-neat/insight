package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)

// writePair writes a self-signed pair covering subjects, valid until notAfter.
func writePair(t *testing.T, certFile, keyFile string, subjects []string, notAfter time.Time) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test"},
		NotBefore:    notAfter.Add(-48 * time.Hour),
		NotAfter:     notAfter,
	}
	for _, subject := range subjects {
		if ip := net.ParseIP(subject); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else {
			template.DNSNames = append(template.DNSNames, subject)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	// A slice, not a map: the key may go into the certificate's own file.
	for _, item := range []struct {
		path  string
		block *pem.Block
	}{
		{certFile, &pem.Block{Type: "CERTIFICATE", Bytes: der}},
		{keyFile, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}},
	} {
		path, block := item.path, item.block
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		if err := pem.Encode(file, block); err != nil {
			t.Fatal(err)
		}
		file.Close()
	}
}

// fakeMkcert records its calls and writes a pair where mkcert would.
func fakeMkcert(t *testing.T, calls *[][]string) func(args ...string) error {
	return func(args ...string) error {
		*calls = append(*calls, args)
		if len(args) > 4 && args[0] == "-cert-file" && args[2] == "-key-file" {
			writePair(t, args[1], args[3], args[4:], now.Add(365*24*time.Hour))
		}
		return nil
	}
}

func TestSDKCertificateWins(t *testing.T) {
	sdk, data := t.TempDir(), t.TempDir()
	writePair(t, filepath.Join(sdk, SDKCertName), filepath.Join(sdk, "neat-sdk.key"), []string{"x"}, now.Add(time.Hour))
	var calls [][]string
	pair, err := Resolve(Options{SDKDir: sdk, DataDir: data, Hosts: []string{"10.0.0.1"}, Mkcert: fakeMkcert(t, &calls), Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if pair.Source != "sdk" || pair.KeyFile != filepath.Join(sdk, "neat-sdk.key") || len(calls) != 0 {
		t.Fatalf("pair %+v, mkcert calls %v", pair, calls)
	}
}

func TestSDKKeyInsideTheCertificateFile(t *testing.T) {
	sdk := t.TempDir()
	both := filepath.Join(sdk, SDKCertName)
	writePair(t, both, both, []string{"x"}, now.Add(time.Hour))
	pair, err := Resolve(Options{SDKDir: sdk, DataDir: t.TempDir(), Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if pair.KeyFile != both {
		t.Fatalf("key file %q", pair.KeyFile)
	}
}

func TestAnUnusableSDKCertificateFails(t *testing.T) {
	sdk := t.TempDir()
	if err := os.WriteFile(filepath.Join(sdk, SDKCertName), []byte("not a certificate"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Resolve(Options{SDKDir: sdk, DataDir: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), SDKCertName) {
		t.Fatalf("err = %v", err)
	}
}

func TestAnExistingPairIsReused(t *testing.T) {
	data := t.TempDir()
	writePair(t, filepath.Join(data, "cert.pem"), filepath.Join(data, "key.pem"), []string{"10.0.0.1", "127.0.0.1", "localhost"}, now.Add(time.Hour))
	var calls [][]string
	pair, err := Resolve(Options{DataDir: data, Hosts: []string{"10.0.0.1"}, Mkcert: fakeMkcert(t, &calls), Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if pair.Source != "existing" || len(calls) != 0 {
		t.Fatalf("pair %+v, mkcert calls %v", pair, calls)
	}
}

func TestAPairIsRemadeWhen(t *testing.T) {
	cases := map[string]struct {
		subjects []string
		notAfter time.Time
	}{
		"it has expired":            {[]string{"10.0.0.1", "127.0.0.1", "localhost"}, now.Add(-time.Hour)},
		"it misses the host":        {[]string{"10.0.0.2", "127.0.0.1", "localhost"}, now.Add(time.Hour)},
		"it misses localhost":       {[]string{"10.0.0.1", "127.0.0.1"}, now.Add(time.Hour)},
		"it is a pair of two hosts": {[]string{"127.0.0.1", "localhost"}, now.Add(time.Hour)},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			data := t.TempDir()
			writePair(t, filepath.Join(data, "cert.pem"), filepath.Join(data, "key.pem"), c.subjects, c.notAfter)
			var calls [][]string
			pair, err := Resolve(Options{DataDir: data, Hosts: []string{"10.0.0.1"}, Mkcert: fakeMkcert(t, &calls), Now: func() time.Time { return now }})
			if err != nil {
				t.Fatal(err)
			}
			if pair.Source != "mkcert" {
				t.Fatalf("source %q", pair.Source)
			}
			if problem := check(pair, Subjects([]string{"10.0.0.1"}), now); problem != "" {
				t.Fatalf("the new pair is not usable: %s", problem)
			}
		})
	}
}

func TestMkcertRuns(t *testing.T) {
	data := filepath.Join(t.TempDir(), "neat-insight")
	var calls [][]string
	if _, err := Resolve(Options{DataDir: data, Hosts: []string{"10.0.0.1"}, Mkcert: fakeMkcert(t, &calls), Now: func() time.Time { return now }}); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || !slices.Equal(calls[0], []string{"-install"}) {
		t.Fatalf("calls %v", calls)
	}
	if got := calls[1][4:]; !slices.Equal(got, []string{"10.0.0.1", "127.0.0.1", "localhost"}) {
		t.Fatalf("subjects %v", got)
	}
	info, err := os.Stat(filepath.Join(data, "key.pem"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", info, err)
	}
	entries, _ := os.ReadDir(data)
	if len(entries) != 2 {
		t.Fatalf("data folder holds %v, want the two files only", entries)
	}
}

func TestAFailedMkcertKeepsTheOldPair(t *testing.T) {
	data := t.TempDir()
	certFile := filepath.Join(data, "cert.pem")
	writePair(t, certFile, filepath.Join(data, "key.pem"), []string{"127.0.0.1"}, now.Add(time.Hour))
	before, _ := os.ReadFile(certFile)
	failing := func(args ...string) error {
		if args[0] == "-install" {
			return nil
		}
		return errors.New("mkcert broke")
	}
	if _, err := Resolve(Options{DataDir: data, Hosts: []string{"10.0.0.1"}, Mkcert: failing, Now: func() time.Time { return now }}); err == nil {
		t.Fatal("no error")
	}
	after, _ := os.ReadFile(certFile)
	if string(before) != string(after) {
		t.Fatal("the old certificate changed")
	}
}

func TestSubjects(t *testing.T) {
	if got := Subjects([]string{"127.0.0.1", ""}); !slices.Equal(got, []string{"127.0.0.1", "localhost"}) {
		t.Fatalf("got %v", got)
	}
}
