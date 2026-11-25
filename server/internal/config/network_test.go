package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func loadNetworkFrom(t *testing.T, files map[string]string, env map[string]string) (Network, error) {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		write(t, filepath.Join(dir, name), content)
	}
	return loadNetwork(dir, envOf(env))
}

func TestBrowserICEAddress(t *testing.T) {
	cases := []struct {
		name       string
		files      map[string]string
		env        map[string]string
		wantAddr   string
		wantSource string
	}{
		{"none", nil, nil, "", "none"},
		{"the file", map[string]string{"browser-ice-address": "203.0.113.7\n"}, map[string]string{"CONTAINER_HOST_IP": "10.1.1.1"}, "203.0.113.7", "browser-ice-address"},
		{"the environment", nil, map[string]string{"CONTAINER_HOST_IP": "10.1.1.1"}, "10.1.1.1", "CONTAINER_HOST_IP"},
		{"a loopback environment is none", nil, map[string]string{"CONTAINER_HOST_IP": "127.0.0.1"}, "", "none"},
		{"an environment that is no address is none", nil, map[string]string{"CONTAINER_HOST_IP": "host"}, "", "none"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			network, err := loadNetworkFrom(t, c.files, c.env)
			if err != nil {
				t.Fatal(err)
			}
			if network.BrowserICEAddress != c.wantAddr || network.BrowserICEAddressSource != c.wantSource {
				t.Fatalf("got %q from %q, want %q from %q", network.BrowserICEAddress,
					network.BrowserICEAddressSource, c.wantAddr, c.wantSource)
			}
		})
	}
	for _, bad := range []string{"::1\n", "127.0.0.1\n", "0.0.0.0\n", "224.0.0.1\n", "169.254.1.1\n", "240.0.0.1\n", "host\n", "", "1.2.3.4\n5.6.7.8\n"} {
		t.Run("the file rejects "+strings.TrimSpace(bad), func(t *testing.T) {
			if _, err := loadNetworkFrom(t, map[string]string{"browser-ice-address": bad}, nil); err == nil {
				t.Fatalf("%q was accepted", bad)
			}
		})
	}
}

func TestPublicOrigin(t *testing.T) {
	cases := map[string]string{
		"https://Insight.Example.com/some/path?x=1": "https://insight.example.com/",
		"HTTP://10.0.0.5:8443":                      "http://10.0.0.5:8443/",
		"https://[::1]:8443/":                       "https://[::1]:8443/",
	}
	for launch, want := range cases {
		t.Run(launch, func(t *testing.T) {
			network, err := loadNetworkFrom(t, map[string]string{"launch-url": launch + "\n"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if network.PublicOrigin != want || network.URLRouting != "proxy" {
				t.Fatalf("origin %q routing %q, want %q proxy", network.PublicOrigin, network.URLRouting, want)
			}
		})
	}
	for _, bad := range []string{"ftp://host/", "https://user:pw@host/", "https://host:0/", "https://host:70000/", "https://1.2.3/", "https://-bad-.com/", "/relative", "https://ho st/"} {
		t.Run("ignores "+bad, func(t *testing.T) {
			network, err := loadNetworkFrom(t, map[string]string{"launch-url": bad + "\n"}, nil)
			if err != nil {
				t.Fatalf("a bad launch URL must not stop the start: %v", err)
			}
			if network.PublicOrigin != "" {
				t.Fatalf("origin = %q", network.PublicOrigin)
			}
		})
	}
}

func TestURLRouting(t *testing.T) {
	t.Run("direct ignores the launch URL", func(t *testing.T) {
		network, err := loadNetworkFrom(t, map[string]string{"launch-url": "https://host/\n", "url-routing": "direct\n"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if network.PublicOrigin != "" || network.URLRouting != "direct" {
			t.Fatalf("got %+v", network)
		}
	})
	t.Run("anything else fails", func(t *testing.T) {
		if _, err := loadNetworkFrom(t, map[string]string{"url-routing": "sideways\n"}, nil); err == nil {
			t.Fatal("accepted")
		}
	})
}
