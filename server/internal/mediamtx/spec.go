package mediamtx

import (
	"io"
	"os"
	"strconv"
	"strings"

	"insight/internal/supervisor"
)

// Options say how to run MediaMTX.
type Options struct {
	// Binary is the MediaMTX program (neat_insight/bin/mediamtx in the package).
	Binary string
	// Config is the rendered runtime configuration, as WriteConfig wrote it.
	Config string
	// CertFile and KeyFile are Insight's certificate pair, which the WHIP listener serves, so
	// a browser that trusts Insight's pages trusts its webcam endpoint too.
	CertFile, KeyFile string
	// ICEAddress is the address MediaMTX offers browsers for WHIP media besides its own
	// (config.Network.BrowserICEAddress), so it matches what the channels offer; empty for
	// none.
	ICEAddress string
	// WHIPICEPort is the UDP port MediaMTX takes WHIP media on: the SDK port map's
	// webrtcWhipIce, or 0 to keep the configuration's 8189. MediaMTX writes the port into its
	// answer and Docker forwards a published port without rewriting that, so the SDK
	// publishes it identity-mapped and MediaMTX must bind the number the port map names.
	WHIPICEPort uint16
	// Output receives MediaMTX's log lines.
	Output io.Writer
}

// Spec says how the supervisor runs MediaMTX: from the runtime configuration, with the
// certificate, the ICE address and the WHIP media port as MediaMTX's environment overrides
// (it reads any configuration key as MTX_<KEY IN CAPITALS>), restarted when it exits. It
// inherits Insight's environment, so an MTX_ variable set there for debugging still reaches
// it; the overrides here replace any of the same name.
func Spec(o Options) supervisor.Spec {
	overrides := []string{
		// The shipped file says no so that it also starts without a certificate. The page is
		// served over https and posts its WHIP offer to https, so with Insight the listener is
		// always TLS.
		"MTX_WEBRTCENCRYPTION=yes",
		"MTX_WEBRTCSERVERCERT=" + o.CertFile,
		"MTX_WEBRTCSERVERKEY=" + o.KeyFile,
	}
	if o.ICEAddress != "" {
		overrides = append(overrides, "MTX_WEBRTCADDITIONALHOSTS="+o.ICEAddress)
	}
	if o.WHIPICEPort != 0 {
		overrides = append(overrides, "MTX_WEBRTCLOCALUDPADDRESS=:"+strconv.Itoa(int(o.WHIPICEPort)))
	}
	return supervisor.Spec{
		Name:    "mediamtx",
		Path:    o.Binary,
		Args:    []string{o.Config},
		Env:     withOverrides(os.Environ(), overrides),
		Restart: true,
		Output:  o.Output,
	}
}

// withOverrides returns env without the variables overrides set, followed by overrides.
func withOverrides(env, overrides []string) []string {
	replaced := make(map[string]bool, len(overrides))
	for _, entry := range overrides {
		name, _, _ := strings.Cut(entry, "=")
		replaced[name] = true
	}
	out := make([]string, 0, len(env)+len(overrides))
	for _, entry := range env {
		if name, _, _ := strings.Cut(entry, "="); !replaced[name] {
			out = append(out, entry)
		}
	}
	return append(out, overrides...)
}
