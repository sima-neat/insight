// Package legacy runs the old Flask backend behind the new server while the rewrite moves its
// routes over, and passes it every request the new server does not handle yet.
//
// It goes away in the rewrite's last phase, with the Flask backend.
package legacy

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"insight/internal/apierr"
	"insight/internal/supervisor"
)

// Prefixes are the paths the old backend serves: the API routes the new server does not have
// yet, and its API docs' assets.
var Prefixes = []string{"/api/", "/swagger-ui-assets/"}

// Options say how to run the old backend.
type Options struct {
	// Python is the interpreter of Insight's Python environment.
	Python string
	// CertFile and KeyFile are the certificate the old backend's own child, webssh, serves
	// with.
	CertFile, KeyFile string
	// Output receives the old backend's log lines.
	Output io.Writer
	// Port is the loopback port it listens on; 0 picks a free one.
	Port int
}

// Backend is the running old backend.
type Backend struct {
	target  *url.URL
	process *supervisor.Process
	ready   atomic.Bool
}

// Start runs the old backend under sup and starts watching whether it answers.
func Start(ctx context.Context, sup *supervisor.Supervisor, opts Options) (*Backend, error) {
	port := opts.Port
	if port == 0 {
		var err error
		if port, err = freeLoopbackPort(); err != nil {
			return nil, err
		}
	}
	process, err := sup.Start(supervisor.Spec{
		Name: "legacy-backend",
		Path: opts.Python,
		Args: []string{"-c", "from neat_insight.app import main; main()",
			"--port", strconv.Itoa(port), "--behind-proxy", "--cert", opts.CertFile, "--key", opts.KeyFile},
		Env:     append(os.Environ(), "PYTHONUNBUFFERED=1"),
		Restart: true,
		// It stops vf, MediaMTX and the stream ffmpegs before exiting.
		Grace:  15 * time.Second,
		Output: opts.Output,
	})
	if err != nil {
		return nil, err
	}
	b := &Backend{
		target:  &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port))},
		process: process,
	}
	go b.watch(ctx)
	return b, nil
}

// Ready says whether the old backend answered its health check the last time it was asked.
func (b *Backend) Ready() bool { return b.ready.Load() }

// Process is the supervised child.
func (b *Backend) Process() *supervisor.Process { return b.process }

// watch asks the old backend's own health route once a second.
func (b *Backend) watch(ctx context.Context) {
	client := &http.Client{Timeout: 2 * time.Second}
	health := b.target.JoinPath("/api/health").String()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		b.ready.Store(answers(client, health))
		select {
		case <-ctx.Done():
			return
		case <-b.process.Done():
			b.ready.Store(false)
			return
		case <-ticker.C:
		}
	}
}

func answers(client *http.Client, url string) bool {
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// Handler passes requests to the old backend: the original host stays, so the links it builds
// name the address the browser used, and X-Forwarded-Proto says the browser came over HTTPS.
// Answers stream as they come (MJPEG, upload progress).
func (b *Backend) Handler() http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(b.target)
			r.Out.Host = r.In.Host
			r.SetXForwarded()
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() != nil {
				return // the browser went away
			}
			status, code, message := http.StatusBadGateway, "backend_failed",
				"Insight's backend did not answer."
			if !b.Ready() {
				status, code, message = http.StatusServiceUnavailable, "backend_starting",
					"Insight is still starting. Try again in a moment."
			}
			apierr.Write(w, status, code, message, "")
		},
	}
}

func freeLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("finding a free port for the old backend: %w", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}
