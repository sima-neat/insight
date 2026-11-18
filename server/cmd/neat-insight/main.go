// Command neat-insight is the Neat Insight server: the web UI and its API over HTTPS, and the
// services behind them, run as supervised children.
//
// The `neat-insight` command of the Python package runs this binary with the same arguments and
// names its interpreter in NEAT_INSIGHT_PYTHON, which runs the old backend until the rewrite
// has moved everything here.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"insight/internal/certs"
	"insight/internal/channels"
	"insight/internal/config"
	"insight/internal/legacy"
	"insight/internal/spa"
	"insight/internal/supervisor"
	"insight/internal/web"
)

// version is set at build time (-ldflags "-X main.version=...").
var version = "dev"

// reservedPorts are ports Insight's own services take, which the UI cannot have.
var reservedPorts = map[int]string{
	8554: "MediaMTX's RTSP port, where apps read the sources",
	8889: "MediaMTX's WHIP port, where browsers publish webcams",
	9901: "Insight's internal MediaMTX API port",
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "neat-insight:", err)
		os.Exit(1)
	}
}

func run() error {
	port := flag.Int("port", 9900, "the HTTPS port of the web UI and the API")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return nil
	}
	if what, taken := reservedPorts[*port]; taken {
		return fmt.Errorf("--port %d is %s; choose another port", *port, what)
	}

	paths, err := config.SystemPaths()
	if err != nil {
		return err
	}
	cfg, err := config.Load(*port, paths, os.Getenv, config.SystemAddresses{})
	if err != nil {
		return err
	}
	pair, err := certs.Resolve(certs.Options{SDKDir: "/sdk-cert", DataDir: cfg.DataDir, Hosts: []string{cfg.CertHost}})
	if err != nil {
		return err
	}
	slog.Info("starting", "version", version, "place", cfg.Place, "data", cfg.DataDir, "certificate", pair.Source)

	python := os.Getenv("NEAT_INSIGHT_PYTHON")
	if python == "" {
		return errors.New("NEAT_INSIGHT_PYTHON is not set: start Insight with the neat-insight command")
	}

	bin, err := binaryFolder()
	if err != nil {
		return err
	}
	sup, err := supervisor.New(filepath.Join(cfg.DataDir, "run"))
	if err != nil {
		return err
	}
	sup.StopLeftovers(10 * time.Second)
	// Whatever ends the run, the children end with it (StopAll again does nothing more).
	defer stopChildren(sup)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	viewer, err := channels.Listen(ctx, channels.Options{
		Count: cfg.Channels.Count, VideoBase: 9000, MetadataBase: 9100,
		WebRTCPortStart: cfg.WebRTCPorts.Start, WebRTCPortEnd: cfg.WebRTCPorts.End,
		ICEAddress: cfg.Network.BrowserICEAddress,
	})
	if err != nil {
		return err
	}
	slog.Info("channels", "count", cfg.Channels.Count, "source", cfg.Channels.Source,
		"webrtc", fmt.Sprintf("%d-%d", cfg.WebRTCPorts.Start, cfg.WebRTCPorts.End))

	srcs, err := startSources(cfg, pair, sup, bin)
	if err != nil {
		return err
	}
	var closeOnce sync.Once
	closeSources := func() {
		closeOnce.Do(func() {
			closing, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			srcs.close(closing)
		})
	}
	defer closeSources()

	backend, err := legacy.Start(ctx, sup, legacy.Options{
		Python: python, CertFile: pair.CertFile, KeyFile: pair.KeyFile, Output: os.Stdout,
	})
	if err != nil {
		return err
	}

	server := &http.Server{
		Addr: ":" + strconv.Itoa(cfg.Port),
		Handler: web.NewHandler(web.Deps{
			Config:         cfg,
			Ready:          backend.Ready,
			Channels:       viewer,
			Slots:          srcs.slots,
			Library:        srcs.library,
			Jobs:           srcs.jobs,
			Legacy:         backend.Handler(),
			LegacyPrefixes: legacy.Prefixes,
			UI:             spa.Handler(spa.Files()),
		}),
		ReadHeaderTimeout: 10 * time.Second,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12},
	}
	served := make(chan error, 1)
	go func() { served <- server.ListenAndServeTLS(pair.CertFile, pair.KeyFile) }()
	fmt.Printf("neat-insight %s: https://%s\n", version, net.JoinHostPort(cfg.CertHost, strconv.Itoa(cfg.Port)))

	var serveErr error
	select {
	case <-ctx.Done():
		slog.Info("stopping")
	case serveErr = <-served:
	case <-backend.Process().Done():
		serveErr = errors.New("the backend stopped and will not restart")
	}

	// Streams (MJPEG) never finish on their own: give requests a moment, then close them all.
	closing, cancelClosing := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelClosing()
	if server.Shutdown(closing) != nil {
		server.Close()
	}
	// Then what the requests used: the slots' publishers and encodes, the relays, the jobs;
	// then the children, MediaMTX and the old backend (which stops its own, webssh).
	closeSources()
	stopChildren(sup)
	stop() // ends the channels' readers, if a signal has not already
	viewer.Wait()
	if errors.Is(serveErr, http.ErrServerClosed) {
		return nil
	}
	return serveErr
}

func stopChildren(sup *supervisor.Supervisor) {
	stopping, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sup.StopAll(stopping)
}
