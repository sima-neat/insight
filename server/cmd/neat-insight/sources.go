package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"insight/internal/certs"
	"insight/internal/config"
	"insight/internal/jobs"
	"insight/internal/library"
	"insight/internal/media"
	"insight/internal/mediamtx"
	"insight/internal/relay"
	"insight/internal/slots"
	"insight/internal/supervisor"
)

// sdkWorkspace is the SDK container's workspace, which outlives the container; the media
// library lives in it there.
const sdkWorkspace = "/workspace"

// The relays' limits. Every slot's HTTP MJPEG output may be read at once (a copy, cheap), and a
// few previews besides (a decode and an encode each, opened by the UI).
const (
	maxRelays     = slots.Count + 16
	relayIdleStop = 5 * time.Second
	relayStall    = 15 * time.Second
)

// sources are the Streaming and Media pages' backend: the slots, the media library, and what
// they run on (MediaMTX, the MJPEG relays, the jobs and the probes).
type sources struct {
	slots      *slots.Manager
	library    *library.Library
	jobs       *jobs.Runner
	relays     *relay.Relays
	stopProbes context.CancelFunc
}

// startSources starts MediaMTX under sup and makes the slots and the library. The programs
// Insight ships (MediaMTX, its configuration, the TCP_NODELAY shim) are found in bin, the
// folder of the server's own binary; ffmpeg and ffprobe on PATH.
func startSources(cfg config.Config, pair certs.Pair, sup *supervisor.Supervisor, bin string) (*sources, error) {
	root, err := media.Root(cfg.Place, cfg.DataDir, sdkWorkspace)
	if err != nil {
		return nil, err
	}
	ffmpeg, ffprobe := lookPath("ffmpeg"), lookPath("ffprobe")

	secrets := mediamtx.NewSecrets()
	mtxConfig, err := mediamtx.WriteConfig(filepath.Join(bin, "mediamtx.yml"), filepath.Join(cfg.DataDir, "run"), secrets)
	if err != nil {
		return nil, err
	}
	if _, err := sup.Start(mediamtx.Spec(mediamtx.Options{
		Binary: filepath.Join(bin, "mediamtx"), Config: mtxConfig,
		CertFile: pair.CertFile, KeyFile: pair.KeyFile,
		ICEAddress: cfg.Network.BrowserICEAddress, WHIPICEPort: uint16(cfg.Published.WHIPICE),
		Output: os.Stdout,
	})); err != nil {
		return nil, fmt.Errorf("starting MediaMTX: %w", err)
	}

	probeCtx, stopProbes := context.WithCancel(context.Background())
	s := &sources{stopProbes: stopProbes}
	probes := media.NewCache(probeCtx, media.FFprobe(ffprobe))
	limits := library.JobLimits()
	limits[slots.RenditionJob] = 1
	s.jobs = jobs.New(limits)
	producers := &producers{ffmpeg: ffmpeg}
	if s.relays, err = relay.New(relay.Options{
		MaxRelays: maxRelays, IdleStop: relayIdleStop, StallTimeout: relayStall, Start: producers.start,
	}); err != nil {
		s.close(context.Background())
		return nil, err
	}
	if s.slots, err = slots.New(slots.Options{
		StorePath:      filepath.Join(cfg.DataDir, "sources.json"),
		MediaRoot:      root,
		Probes:         probes,
		MediaMTX:       mediamtx.NewClient(mediamtx.APIURL, secrets),
		PublisherQuery: secrets.PublisherQuery(),
		Start:          sup.Starter(),
		Jobs:           s.jobs,
		Relays:         s.relays,
		FFmpeg:         ffmpeg,
		FFprobe:        ffprobe,
		Preload:        filepath.Join(bin, "ffmpeg_nodelay.so"),
		URLs: slots.URLOptions{
			RTSPPort: cfg.Published.RTSP, WHIPPort: cfg.Published.WHIP, PublicOrigin: cfg.Network.PublicOrigin,
		},
		Output: os.Stdout,
	}); err != nil {
		s.close(context.Background())
		return nil, err
	}
	if s.library, err = library.New(library.Options{
		Root: root, Cache: probes, FFmpeg: ffmpeg, FFprobe: ffprobe, Start: sup.Starter(),
		Jobs: s.jobs, Relays: s.relays, Files: s.slots,
	}); err != nil {
		s.close(context.Background())
		return nil, err
	}
	producers.library = s.library // before the server serves: no relay starts earlier
	slog.Info("sources", "media", root, "rtsp port", cfg.Published.RTSP, "whip port", cfg.Published.WHIP)
	return s, nil
}

// close stops the slots' publishers and encodes, then the relays and the jobs, and the
// probes last. MediaMTX is the supervisor's child and stops with the others.
func (s *sources) close(ctx context.Context) {
	if s.slots != nil {
		if err := s.slots.Close(ctx); err != nil {
			slog.Warn("stopping the sources", "error", err)
		}
	}
	if s.relays != nil {
		s.relays.Close()
	}
	if s.jobs != nil {
		if err := s.jobs.Shutdown(ctx); err != nil {
			slog.Warn("stopping the jobs", "error", err)
		}
	}
	s.stopProbes()
}

// producers make the relays' producers: a library file's preview, or a slot's stream.
type producers struct {
	ffmpeg  string
	library *library.Library
}

func (p *producers) start(key, source string) (*exec.Cmd, error) {
	if strings.HasPrefix(key, library.PreviewKeyPrefix) {
		if p.library == nil {
			return nil, errors.New("the media library is not ready")
		}
		return p.library.PreviewCommand(source)
	}
	if p.ffmpeg == "" {
		return nil, errors.New("FFmpeg is not installed")
	}
	if cmd, ok := slots.RelayCommand(p.ffmpeg, key, source); ok {
		return cmd, nil
	}
	return nil, fmt.Errorf("no stream is relayed as %s", key)
}

// lookPath finds a program on PATH, or "" when it is not installed (logged).
func lookPath(name string) string {
	path, err := exec.LookPath(name)
	if err != nil {
		slog.Warn(name+" is not installed; the sources and the media library work without it as far as they can", "error", err)
		return ""
	}
	return path
}

// binaryFolder is the folder of the running binary, links resolved: neat_insight/bin in the
// package, where the programs Insight ships lie beside it.
func binaryFolder() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("finding the server's binary: %w", err)
	}
	if self, err = filepath.EvalSymlinks(self); err != nil {
		return "", fmt.Errorf("finding the server's binary: %w", err)
	}
	return filepath.Dir(self), nil
}
