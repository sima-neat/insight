// Package system is System Info's backend: what Insight knows about itself (its version and
// build, where it runs, the ports and addresses it resolved at start), what the neat command
// says about the machine it runs on, and that machine's CPU, memory and disk.
//
// `neat --json` is run once at start and again on request, never per read: it goes online for
// its update check and takes up to 15 s. Only an allowlist of its fields is passed on, the ones
// System Info shows; its code UI section, which holds a password, and anything else it may add
// are not.
package system

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"runtime"
	"runtime/debug"
	"sync"
	"syscall"
	"time"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/config"
	"insight/internal/procgroup"
)

// NeatTimeout bounds one run of `neat --json`.
const NeatTimeout = 15 * time.Second

// Info is System Info's answer.
type Info struct {
	Insight Insight `json:"insight"`
	Neat    Neat    `json:"neat"`
}

// Insight is what Insight knows about itself.
type Insight struct {
	Version string `json:"version"`
	Build   Build  `json:"build"`
	// Place is where it runs: board, sdk or host.
	Place   string `json:"place"`
	DataDir string `json:"data_dir"`
	Port    int    `json:"port"`
	// WebUIURL is where browsers open Insight: the public origin when a proxy serves it,
	// else the address the request came to.
	WebUIURL string  `json:"web_ui_url"`
	Network  Network `json:"network"`
	Ports    Ports   `json:"ports"`
}

// Build is how the server's binary was built.
type Build struct {
	GoVersion string `json:"go_version"`
	Platform  string `json:"platform"`
	// Revision and Time are the commit it was built from, when the build recorded it.
	Revision string `json:"revision,omitempty"`
	Time     string `json:"time,omitempty"`
	Modified bool   `json:"modified,omitempty"`
}

// Network is how browsers reach Insight, as resolved at start.
type Network struct {
	CertificateHost         string `json:"certificate_host"`
	BrowserICEAddress       string `json:"browser_ice_address,omitempty"`
	BrowserICEAddressSource string `json:"browser_ice_address_source"`
	PublicOrigin            string `json:"public_origin,omitempty"`
	URLRouting              string `json:"url_routing,omitempty"`
}

// Ports are the ports Insight serves on, as resolved at start.
type Ports struct {
	Channels       int    `json:"channels"`
	ChannelsSource string `json:"channels_source"`
	WebRTCStart    int    `json:"webrtc_start"`
	WebRTCEnd      int    `json:"webrtc_end"`
	// The host ports the SDK publishes MediaMTX's listeners on; 0 where none is named.
	RTSP    int `json:"rtsp"`
	WHIP    int `json:"whip"`
	WHIPICE int `json:"whip_ice"`
}

// Neat is what `neat --json` said, allowlisted.
type Neat struct {
	// State is reading (the first run has not finished), ready, missing (neat is not
	// installed) or failed (Error says why).
	State  string           `json:"state"`
	ReadAt *time.Time       `json:"read_at,omitempty"`
	Error  *api.ErrorDetail `json:"error,omitempty"`
	// The sections System Info shows, once ready. ExposedPorts are neat's, else the port map's.
	Environment  *Environment         `json:"environment,omitempty"`
	Components   map[string]Component `json:"components,omitempty"`
	Service      *Service             `json:"insight,omitempty"`
	UpdateCheck  *UpdateCheck         `json:"update_check,omitempty"`
	ExposedPorts []ExposedPort        `json:"exposed_ports"`
}

// Environment is what neat found it runs on.
type Environment struct {
	Mode               *string `json:"mode"`
	Label              *string `json:"label"`
	SDKVersion         *string `json:"sdkVersion"`
	DevKitBuildVersion *string `json:"devkitBuildVersion"`
	Sysroot            *string `json:"sysroot"`
}

// Component is one piece of software neat knows.
type Component struct {
	Name            *string `json:"name"`
	Version         *string `json:"version"`
	Detail          *string `json:"detail,omitempty"`
	Channel         *string `json:"channel,omitempty"`
	Tag             *string `json:"tag,omitempty"`
	ChannelAssumed  *bool   `json:"channelAssumed,omitempty"`
	LatestTag       *string `json:"latestTag,omitempty"`
	LatestVersion   *string `json:"latestVersion,omitempty"`
	MetadataURL     *string `json:"metadataUrl,omitempty"`
	UpdateAvailable *bool   `json:"updateAvailable,omitempty"`
	Installed       *bool   `json:"installed,omitempty"`
	ServiceState    *string `json:"serviceState,omitempty"`
	Venv            *string `json:"venv,omitempty"`
}

// Service is the Insight service as neat sees it.
type Service struct {
	ServiceState *string `json:"serviceState"`
	Venv         *string `json:"venv"`
	WebUIURL     *string `json:"webUiUrl"`
}

// UpdateCheck is neat's online check for newer versions.
type UpdateCheck struct {
	Offline *bool    `json:"offline"`
	Status  *string  `json:"status"`
	Errors  []string `json:"errors,omitempty"`
}

// ExposedPort is a port the SDK container publishes.
type ExposedPort struct {
	Name          string `json:"name"`
	Protocol      string `json:"protocol,omitempty"`
	HostPortStart *int   `json:"hostPortStart"`
	HostPortEnd   *int   `json:"hostPortEnd"`
}

// neatAnswer is the part of `neat --json` (schema sima.neat.status.v1) that is passed on.
type neatAnswer struct {
	Environment  *Environment         `json:"environment"`
	Components   map[string]Component `json:"components"`
	Insight      *Service             `json:"insight"`
	UpdateCheck  *UpdateCheck         `json:"updateCheck"`
	ExposedPorts []ExposedPort        `json:"exposedPorts"`
}

// Options say what System Info reports.
type Options struct {
	Version string
	Config  config.Config
	// RunNeat runs `neat --json` and gives its output; exec.ErrNotFound when neat is not
	// installed. Nil runs the neat on PATH.
	RunNeat func(ctx context.Context) ([]byte, error)
}

// Reader answers System Info.
type Reader struct {
	opts    Options
	insight Insight

	mu      sync.Mutex
	neat    Neat
	reading chan struct{} // closed when the read in progress ends; nil when none runs
}

// New makes a Reader and starts the first read of neat.
func New(opts Options) *Reader {
	if opts.RunNeat == nil {
		opts.RunNeat = runNeat
	}
	cfg := opts.Config
	r := &Reader{opts: opts, neat: Neat{State: "reading", ExposedPorts: portMapPorts(cfg.ExposedPorts)}}
	r.insight = Insight{
		Version: opts.Version, Build: buildOf(), Place: string(cfg.Place), DataDir: cfg.DataDir, Port: cfg.Port,
		Network: Network{
			CertificateHost: cfg.CertHost, BrowserICEAddress: cfg.Network.BrowserICEAddress,
			BrowserICEAddressSource: cfg.Network.BrowserICEAddressSource, PublicOrigin: cfg.Network.PublicOrigin,
			URLRouting: cfg.Network.URLRouting,
		},
		Ports: Ports{
			Channels: cfg.Channels.Count, ChannelsSource: cfg.Channels.Source,
			WebRTCStart: int(cfg.WebRTCPorts.Start), WebRTCEnd: int(cfg.WebRTCPorts.End),
			RTSP: cfg.Published.RTSP, WHIP: cfg.Published.WHIP, WHIPICE: cfg.Published.WHIPICE,
		},
	}
	r.startRead()
	return r
}

// Info is System Info for a request that reached Insight at host: from memory, or, with
// refresh, after reading neat again (or waiting for the read in progress).
func (r *Reader) Info(ctx context.Context, host string, refresh bool) Info {
	if refresh {
		done := r.startRead()
		select {
		case <-done:
		case <-ctx.Done():
		}
	}
	insight := r.insight
	insight.WebUIURL = "https://" + host + "/"
	if insight.Network.PublicOrigin != "" && insight.Network.URLRouting != "direct" {
		insight.WebUIURL = insight.Network.PublicOrigin
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return Info{Insight: insight, Neat: r.neat}
}

// startRead starts a read of neat unless one runs, and gives the channel its end closes.
func (r *Reader) startRead() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.reading != nil {
		return r.reading
	}
	done := make(chan struct{})
	r.reading = done
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), NeatTimeout)
		defer cancel()
		neat := r.read(ctx)
		r.mu.Lock()
		r.neat, r.reading = neat, nil
		r.mu.Unlock()
		close(done)
	}()
	return done
}

func (r *Reader) read(ctx context.Context) Neat {
	now := time.Now()
	neat := Neat{ReadAt: &now, ExposedPorts: portMapPorts(r.opts.Config.ExposedPorts)}
	output, err := r.opts.RunNeat(ctx)
	if errors.Is(err, exec.ErrNotFound) {
		neat.State = "missing"
		return neat
	}
	if err == nil {
		var answer neatAnswer
		if err = json.Unmarshal(output, &answer); err == nil {
			neat.State = "ready"
			neat.Environment, neat.Components, neat.Service, neat.UpdateCheck = answer.Environment, answer.Components, answer.Insight, answer.UpdateCheck
			if len(answer.ExposedPorts) > 0 {
				neat.ExposedPorts = answer.ExposedPorts
			}
			return neat
		}
		err = fmt.Errorf("its answer is not the JSON Insight reads: %w", err)
	}
	slog.Warn("neat --json failed", "error", err)
	body := apierr.New("neat_failed", "The neat command failed: "+err.Error()+".",
		"Run `neat --json` in a terminal on this machine to see more.")
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		body = apierr.New("timeout", fmt.Sprintf("The neat command did not answer within %s.", NeatTimeout),
			"It checks online for updates; check this machine's network, then refresh.")
	}
	neat.State, neat.Error = "failed", &body.Error
	return neat
}

// runNeat runs the neat on PATH, a shell script, in a process group of its own: at ctx's end the
// whole group is killed, and what neat started (its update check's downloads) goes with it when
// neat exits, rather than hold its output open.
func runNeat(ctx context.Context) ([]byte, error) {
	path, err := exec.LookPath("neat")
	if err != nil {
		return nil, exec.ErrNotFound
	}
	cmd := exec.Command(path, "--json")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = time.Second
	group, err := procgroup.Start(cmd)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = group.Signal(syscall.SIGKILL) })
	err = group.Wait()
	stop()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		detail := stderr.String()
		if len(detail) > 500 {
			detail = detail[len(detail)-500:]
		}
		return nil, fmt.Errorf("%w: %s", err, detail)
	}
	if err != nil {
		return nil, err
	}
	return stdout.Bytes(), nil
}

func portMapPorts(ports []config.ExposedPort) []ExposedPort {
	out := make([]ExposedPort, 0, len(ports))
	for _, port := range ports {
		row := ExposedPort{Name: port.Name, Protocol: port.Protocol}
		if port.Start > 0 {
			start := port.Start
			row.HostPortStart = &start
		}
		if port.End > 0 {
			end := port.End
			row.HostPortEnd = &end
		}
		out = append(out, row)
	}
	return out
}

func buildOf() Build {
	build := Build{GoVersion: runtime.Version(), Platform: runtime.GOOS + "/" + runtime.GOARCH}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return build
	}
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			build.Revision = setting.Value
		case "vcs.time":
			build.Time = setting.Value
		case "vcs.modified":
			build.Modified = setting.Value == "true"
		}
	}
	return build
}
