package config

import (
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeAddresses struct {
	sources    map[string]string
	interfaces map[string][]string
}

func (f fakeAddresses) SourceAddress(target string) (netip.Addr, bool) {
	value, ok := f.sources[target]
	if !ok {
		return netip.Addr{}, false
	}
	return netip.MustParseAddr(value), true
}

func (f fakeAddresses) InterfaceAddresses() map[string][]netip.Addr {
	result := map[string][]netip.Addr{}
	for name, values := range f.interfaces {
		for _, value := range values {
			result[name] = append(result[name], netip.MustParseAddr(value))
		}
	}
	return result
}

func envOf(values map[string]string) Env {
	return func(name string) string { return values[name] }
}

// testPaths lays out an empty machine under a temporary folder.
func testPaths(t *testing.T) Paths {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	return Paths{
		Home:           home,
		BuildFiles:     []string{filepath.Join(root, "etc", "build"), filepath.Join(root, "etc", "buildinfo")},
		SDKReleaseFile: filepath.Join(root, "etc", "sdk-release"),
		NVMeRoot:       filepath.Join(root, "media", "nvme"),
		ConfigDir:      filepath.Join(root, "insight-config"),
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

var noAddresses = fakeAddresses{}

func TestPlace(t *testing.T) {
	t.Run("a SiMa build file makes a board", func(t *testing.T) {
		paths := testPaths(t)
		write(t, paths.BuildFiles[1], "MACHINE = modalix\nSIMA_BUILD_VERSION = 2.0\n")
		write(t, paths.SDKReleaseFile, "3.0.0\n")
		cfg, err := Load(9900, paths, envOf(nil), noAddresses)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Place != Board {
			t.Fatalf("place = %q, want board", cfg.Place)
		}
	})
	t.Run("an SDK release file makes the SDK", func(t *testing.T) {
		paths := testPaths(t)
		write(t, paths.BuildFiles[0], "something else\n")
		write(t, paths.SDKReleaseFile, "3.0.0\n")
		cfg, err := Load(9900, paths, envOf(nil), noAddresses)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Place != SDK {
			t.Fatalf("place = %q, want sdk", cfg.Place)
		}
		if want := filepath.Join(paths.Home, ".simaai", "neat-insight"); cfg.DataDir != want {
			t.Fatalf("data dir = %q, want %q", cfg.DataDir, want)
		}
	})
	t.Run("nothing makes another host", func(t *testing.T) {
		cfg, err := Load(9900, testPaths(t), envOf(nil), noAddresses)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Place != Host {
			t.Fatalf("place = %q, want host", cfg.Place)
		}
	})
}

func TestLoadRejectsAPortOutOfRange(t *testing.T) {
	for _, port := range []int{0, -1, 65536} {
		if _, err := Load(port, testPaths(t), envOf(nil), noAddresses); err == nil {
			t.Errorf("port %d was accepted", port)
		}
	}
}

func boardPaths(t *testing.T) Paths {
	t.Helper()
	paths := testPaths(t)
	write(t, paths.BuildFiles[0], "SIMA_BUILD_VERSION = 2.0\n")
	return paths
}

func TestBoardDataDir(t *testing.T) {
	t.Run("without NVMe it is a folder in the home folder", func(t *testing.T) {
		paths := boardPaths(t)
		cfg, err := Load(9900, paths, envOf(nil), noAddresses)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Lstat(cfg.DataDir)
		if err != nil || !info.IsDir() {
			t.Fatalf("data dir %q is not a folder: %v", cfg.DataDir, err)
		}
	})
	t.Run("with NVMe it links to the drive", func(t *testing.T) {
		paths := boardPaths(t)
		if err := os.MkdirAll(paths.NVMeRoot, 0o755); err != nil {
			t.Fatal(err)
		}
		cfg, err := Load(9900, paths, envOf(nil), noAddresses)
		if err != nil {
			t.Fatal(err)
		}
		target, err := os.Readlink(cfg.DataDir)
		if err != nil {
			t.Fatalf("data dir is not a link: %v", err)
		}
		if want := filepath.Join(paths.NVMeRoot, "neat-insight"); target != want {
			t.Fatalf("link to %q, want %q", target, want)
		}
	})
	t.Run("an empty folder becomes the link", func(t *testing.T) {
		paths := boardPaths(t)
		if err := os.MkdirAll(paths.NVMeRoot, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(paths.Home, "neat-insight"), 0o755); err != nil {
			t.Fatal(err)
		}
		cfg, err := Load(9900, paths, envOf(nil), noAddresses)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := os.Readlink(cfg.DataDir); err != nil {
			t.Fatalf("data dir is not a link: %v", err)
		}
	})
	t.Run("a folder with files is kept", func(t *testing.T) {
		paths := boardPaths(t)
		if err := os.MkdirAll(paths.NVMeRoot, 0o755); err != nil {
			t.Fatal(err)
		}
		kept := filepath.Join(paths.Home, "neat-insight", "cert.pem")
		write(t, kept, "x")
		if _, err := Load(9900, paths, envOf(nil), noAddresses); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("the file in the folder is gone: %v", err)
		}
	})
	t.Run("a link whose drive is gone becomes a folder", func(t *testing.T) {
		paths := boardPaths(t)
		dir := filepath.Join(paths.Home, "neat-insight")
		if err := os.Symlink(filepath.Join(paths.NVMeRoot, "neat-insight"), dir); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(9900, paths, envOf(nil), noAddresses); err != nil {
			t.Fatal(err)
		}
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() {
			t.Fatalf("data dir is not a folder: %v", err)
		}
	})
}

func TestCertHost(t *testing.T) {
	addresses := fakeAddresses{
		sources: map[string]string{"8.8.8.8:443": "192.168.1.20", "10.0.0.2:22": "10.0.0.1"},
		interfaces: map[string][]string{
			"docker0": {"172.17.0.1"},
			"eth0":    {"10.0.0.1"},
			"wlp2s0":  {"192.168.1.20"},
			"lo":      {"127.0.0.1"},
		},
	}
	cases := []struct {
		name      string
		env       map[string]string
		addresses AddressFinder
		want      string
	}{
		{"NFS_SERVER_HOST_IP wins", map[string]string{"NFS_SERVER_HOST_IP": "10.9.9.9", "CONTAINER_HOST_IP": "10.1.1.1"}, addresses, "10.9.9.9"},
		{"then CONTAINER_HOST_IP", map[string]string{"CONTAINER_HOST_IP": "10.1.1.1"}, addresses, "10.1.1.1"},
		{"a loopback CONTAINER_HOST_IP is skipped", map[string]string{"CONTAINER_HOST_IP": "127.0.0.1"}, addresses, "192.168.1.20"},
		{"then the route to the DevKit", map[string]string{"DEVKIT_SYNC_DEVKIT_IP": "10.0.0.2"}, addresses, "10.0.0.1"},
		{"then the route to the internet", nil, addresses, "192.168.1.20"},
		{"a route through a bridge is skipped", nil, fakeAddresses{
			sources:    map[string]string{"8.8.8.8:443": "172.17.0.1"},
			interfaces: map[string][]string{"docker0": {"172.17.0.1"}, "eth0": {"10.0.0.1"}},
		}, "10.0.0.1"},
		{"no network is 127.0.0.1", nil, noAddresses, "127.0.0.1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg, err := Load(9900, testPaths(t), envOf(c.env), c.addresses)
			if err != nil {
				t.Fatal(err)
			}
			if cfg.CertHost != c.want {
				t.Fatalf("cert host = %q, want %q", cfg.CertHost, c.want)
			}
		})
	}
	t.Run("an NFS_SERVER_HOST_IP that is no address fails", func(t *testing.T) {
		_, err := Load(9900, testPaths(t), envOf(map[string]string{"NFS_SERVER_HOST_IP": "sdk-host"}), noAddresses)
		if err == nil || !strings.Contains(err.Error(), "NFS_SERVER_HOST_IP") {
			t.Fatalf("err = %v", err)
		}
	})
}
