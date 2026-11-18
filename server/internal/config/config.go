// Package config resolves, once at start, where Insight runs and how browsers reach it.
//
// Nothing here is read again while the server runs: a change to a configuration file takes
// effect at the next start, as the files' writers (sima-cli, the hosting setup) expect.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Place is the kind of machine Insight runs on.
type Place string

const (
	// Board is a SiMa DevKit: /etc/build or /etc/buildinfo names a SiMa build.
	Board Place = "board"
	// SDK is the Neat SDK container: /etc/sdk-release exists.
	SDK Place = "sdk"
	// Host is any other machine (a laptop, CI).
	Host Place = "host"
)

// Config is what the server knows about its surroundings.
type Config struct {
	// Port is the HTTPS port the UI and the API listen on.
	Port int
	// Place is the kind of machine Insight runs on.
	Place Place
	// DataDir holds Insight's own files: certificates, saved state.
	DataDir string
	// CertHost is the address the certificate must cover besides 127.0.0.1 and localhost.
	CertHost string
	// Network is how browsers reach Insight.
	Network Network
	// Channels is how many viewer channels Insight serves.
	Channels Channels
	// WebRTCPorts is the UDP range browsers receive channel media from.
	WebRTCPorts PortRange
}

// Paths are the fixed places Config reads. Tests point them into a temporary folder.
type Paths struct {
	Home           string   // the user's home folder
	BuildFiles     []string // /etc/build, /etc/buildinfo
	SDKReleaseFile string   // /etc/sdk-release
	NVMeRoot       string   // /media/nvme, a DevKit's NVMe drive
	ConfigDir      string   // /home/docker/.insight-config, written by sima-cli and hosting
}

// SystemPaths are the paths on a real machine.
func SystemPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, fmt.Errorf("finding the home folder: %w", err)
	}
	return Paths{
		Home:           home,
		BuildFiles:     []string{"/etc/build", "/etc/buildinfo"},
		SDKReleaseFile: "/etc/sdk-release",
		NVMeRoot:       "/media/nvme",
		ConfigDir:      "/home/docker/.insight-config",
	}, nil
}

// Env reads the environment. Tests pass a map.
type Env func(name string) string

// Load resolves the configuration for a server on port.
func Load(port int, paths Paths, env Env, addrs AddressFinder) (Config, error) {
	if port < 1 || port > 65535 {
		return Config{}, fmt.Errorf("port %d is out of range", port)
	}
	place, err := detectPlace(paths)
	if err != nil {
		return Config{}, err
	}
	dataDir, err := dataDir(place, paths)
	if err != nil {
		return Config{}, err
	}
	certHost, err := certHost(env, addrs)
	if err != nil {
		return Config{}, err
	}
	network, err := loadNetwork(paths.ConfigDir, env)
	if err != nil {
		return Config{}, err
	}
	ports, havePorts := loadPortMap(paths.ConfigDir, env)
	return Config{
		Port:        port,
		Place:       place,
		DataDir:     dataDir,
		CertHost:    certHost,
		Network:     network,
		Channels:    resolveChannels(place, ports, havePorts),
		WebRTCPorts: resolveWebRTCPorts(ports, havePorts),
	}, nil
}

func detectPlace(paths Paths) (Place, error) {
	for _, path := range paths.BuildFiles {
		content, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", fmt.Errorf("reading %s: %w", path, err)
		}
		if strings.Contains(string(content), "SIMA_BUILD_VERSION") {
			return Board, nil
		}
	}
	info, err := os.Stat(paths.SDKReleaseFile)
	if err == nil && info.Mode().IsRegular() {
		return SDK, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("checking %s: %w", paths.SDKReleaseFile, err)
	}
	return Host, nil
}

// dataDir is ~/neat-insight on a board, on the NVMe drive when the board has one, and
// ~/.simaai/neat-insight elsewhere. The folder is created.
func dataDir(place Place, paths Paths) (string, error) {
	if place != Board {
		dir := filepath.Join(paths.Home, ".simaai", "neat-insight")
		return dir, os.MkdirAll(dir, 0o755)
	}
	dir := filepath.Join(paths.Home, "neat-insight")
	if info, err := os.Stat(paths.NVMeRoot); err == nil && info.IsDir() {
		return dir, linkToNVMe(dir, filepath.Join(paths.NVMeRoot, "neat-insight"))
	}
	if info, err := os.Lstat(dir); err == nil && info.Mode()&os.ModeSymlink != 0 {
		// A link to an NVMe drive that is gone: the folder lives in the home folder again.
		if err := os.Remove(dir); err != nil {
			return "", fmt.Errorf("removing the stale link %s: %w", dir, err)
		}
	}
	return dir, os.MkdirAll(dir, 0o755)
}

// linkToNVMe makes dir a symbolic link to target, the folder on the NVMe drive. An existing
// folder with files in it is kept as it is: nothing is moved or deleted.
func linkToNVMe(dir, target string) error {
	if err := os.MkdirAll(target, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", target, err)
	}
	info, err := os.Lstat(dir)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return os.Symlink(target, dir)
	case err != nil:
		return fmt.Errorf("checking %s: %w", dir, err)
	case info.Mode()&os.ModeSymlink != 0:
		current, err := os.Readlink(dir)
		if err != nil {
			return fmt.Errorf("reading the link %s: %w", dir, err)
		}
		if current == target {
			return nil
		}
		if err := os.Remove(dir); err != nil {
			return fmt.Errorf("replacing the link %s: %w", dir, err)
		}
		return os.Symlink(target, dir)
	case info.IsDir():
		entries, err := os.ReadDir(dir)
		if err != nil {
			return fmt.Errorf("reading %s: %w", dir, err)
		}
		if len(entries) > 0 {
			return nil
		}
		// os.Remove deletes only an empty folder, so this cannot lose a file.
		if err := os.Remove(dir); err != nil {
			return fmt.Errorf("replacing the empty folder %s: %w", dir, err)
		}
		return os.Symlink(target, dir)
	default:
		return fmt.Errorf("%s exists but is neither a folder nor a link", dir)
	}
}
