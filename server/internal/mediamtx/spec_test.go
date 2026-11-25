package mediamtx

import (
	"slices"
	"strings"
	"testing"
)

func TestSpec(t *testing.T) {
	// Inherited: a debugging override stays, one Spec sets is replaced, one it leaves unset
	// keeps its value.
	t.Setenv("MTX_LOGLEVEL", "debug")
	t.Setenv("MTX_WEBRTCENCRYPTION", "no")
	t.Setenv("MTX_WEBRTCADDITIONALHOSTS", "10.9.9.9")

	base := Options{Binary: "/pkg/bin/mediamtx", Config: "/data/run/mediamtx.yml", CertFile: "/c/cert.pem", KeyFile: "/c/key.pem"}
	for _, tc := range []struct {
		name   string
		change func(*Options)
		want   []string
	}{
		{"defaults", func(*Options) {}, []string{
			"MTX_WEBRTCENCRYPTION=yes", "MTX_WEBRTCSERVERCERT=/c/cert.pem", "MTX_WEBRTCSERVERKEY=/c/key.pem",
			"MTX_WEBRTCADDITIONALHOSTS=10.9.9.9", "MTX_LOGLEVEL=debug",
		}},
		{"an ICE address", func(o *Options) { o.ICEAddress = "192.168.1.20" }, []string{
			"MTX_WEBRTCADDITIONALHOSTS=192.168.1.20",
		}},
		{"the port map's WHIP ICE port", func(o *Options) { o.WHIPICEPort = 8190 }, []string{
			"MTX_WEBRTCLOCALUDPADDRESS=:8190",
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			options := base
			tc.change(&options)
			spec := Spec(options)
			if spec.Name != "mediamtx" || spec.Path != "/pkg/bin/mediamtx" || !slices.Equal(spec.Args, []string{"/data/run/mediamtx.yml"}) || !spec.Restart {
				t.Fatalf("spec %+v", spec)
			}
			for _, want := range tc.want {
				if !slices.Contains(spec.Env, want) {
					t.Errorf("the environment lacks %s", want)
				}
			}
			seen := map[string]bool{}
			for _, entry := range spec.Env {
				name, _, _ := strings.Cut(entry, "=")
				if seen[name] {
					t.Errorf("%s is set twice", name)
				}
				seen[name] = true
			}
			if options.WHIPICEPort == 0 && seen["MTX_WEBRTCLOCALUDPADDRESS"] {
				t.Error("no port map port still overrides the configuration's")
			}
		})
	}
}
