package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Network is how browsers reach Insight, from the files sima-cli and the hosting setup write
// into the configuration folder, and from the environment.
type Network struct {
	// BrowserICEAddress is the address the channels and MediaMTX offer browsers for WebRTC media, or
	// empty to offer the machine's own.
	BrowserICEAddress string
	// BrowserICEAddressSource says where BrowserICEAddress came from: "browser-ice-address"
	// (the file), "CONTAINER_HOST_IP" (the environment) or "none".
	BrowserICEAddressSource string
	// PublicOrigin is the origin a shared proxy serves Insight under ("https://host/"), or
	// empty when browsers reach Insight directly.
	PublicOrigin string
	// URLRouting is "proxy" (links go through PublicOrigin, when there is one) or "direct"
	// (links name Insight's own ports even when a launch URL exists).
	URLRouting string
}

const (
	browserICEAddressFile = "browser-ice-address"
	launchURLFile         = "launch-url"
	urlRoutingFile        = "url-routing"
)

func loadNetwork(configDir string, env Env) (Network, error) {
	var network Network

	iceFile := filepath.Join(configDir, browserICEAddressFile)
	value, err := readSingleValue(iceFile)
	switch {
	case err != nil:
		return Network{}, err
	case value != "":
		address, err := browserReachableIPv4(value)
		if err != nil {
			return Network{}, fmt.Errorf("%s: %w", iceFile, err)
		}
		network.BrowserICEAddress, network.BrowserICEAddressSource = address, browserICEAddressFile
	default:
		// The environment's address is used when it is one a browser can reach; anything else
		// (empty, loopback, not an address) means none, as it always has.
		network.BrowserICEAddressSource = "none"
		if address, err := netip.ParseAddr(strings.TrimSpace(env("CONTAINER_HOST_IP"))); err == nil &&
			!address.IsLoopback() && !address.IsUnspecified() {
			network.BrowserICEAddress, network.BrowserICEAddressSource = address.String(), "CONTAINER_HOST_IP"
		}
	}

	routingFile := filepath.Join(configDir, urlRoutingFile)
	routing, err := readSingleValue(routingFile)
	if err != nil {
		return Network{}, err
	}
	switch routing {
	case "":
		routing = "proxy"
	case "direct", "proxy":
	default:
		return Network{}, fmt.Errorf("%s must contain 'direct' or 'proxy', not %q", routingFile, routing)
	}
	network.URLRouting = routing

	if routing == "proxy" {
		launchFile := filepath.Join(configDir, launchURLFile)
		// The launch URL is advisory: launch surfaces read it too, and a value Insight cannot use
		// must not stop it from starting. It is logged and ignored.
		value, err := readSingleValue(launchFile)
		if err == nil && value != "" {
			value, err = publicOrigin(value)
		}
		if err != nil {
			slog.Warn("ignoring the launch URL", "file", launchFile, "error", err)
		} else {
			network.PublicOrigin = value
		}
	}
	return network, nil
}

// readSingleValue returns the one line a configuration file holds, or "" when there is no file.
func readSingleValue(path string) (string, error) {
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", path, err)
	}
	lines := strings.Split(strings.TrimRight(string(content), "\r\n"), "\n")
	if len(lines) != 1 || strings.TrimSpace(lines[0]) == "" {
		return "", fmt.Errorf("%s must hold exactly one non-empty line", path)
	}
	return strings.TrimSpace(lines[0]), nil
}

func browserReachableIPv4(value string) (string, error) {
	address, err := netip.ParseAddr(value)
	if err != nil || !address.Is4() {
		return "", fmt.Errorf("%q is not an IPv4 address", value)
	}
	if address.IsLoopback() || address.IsUnspecified() || address.IsMulticast() ||
		address.IsLinkLocalUnicast() || isReserved(address) {
		return "", fmt.Errorf("%q is not an address a browser can reach", value)
	}
	return address.String(), nil
}

// isReserved is 240.0.0.0/4 and the broadcast address, the IPv4 "reserved" block.
func isReserved(address netip.Addr) bool {
	return netip.MustParsePrefix("240.0.0.0/4").Contains(address)
}

var hostLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// publicOrigin reduces an absolute http(s) URL to its origin with a trailing slash.
func publicOrigin(value string) (string, error) {
	for _, r := range value {
		if r <= ' ' || r == 0x7f {
			return "", errors.New("the URL holds whitespace or control characters")
		}
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", errors.New("not a valid URL")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if (scheme != "http" && scheme != "https") || parsed.Hostname() == "" {
		return "", errors.New("not an absolute http or https URL")
	}
	if parsed.User != nil {
		return "", errors.New("the URL holds credentials")
	}
	host := parsed.Hostname()
	if address, err := netip.ParseAddr(host); err == nil {
		host = address.String()
		if address.Is6() {
			host = "[" + host + "]"
		}
	} else {
		host = strings.ToLower(host)
		labels := strings.Split(strings.TrimSuffix(host, "."), ".")
		if len(strings.TrimSuffix(host, ".")) > 253 || allDigitsAndDots(host) {
			return "", errors.New("invalid host name")
		}
		for _, label := range labels {
			if !hostLabel.MatchString(label) {
				return "", errors.New("invalid host name")
			}
		}
	}
	port := parsed.Port()
	if port != "" {
		if number, err := strconv.Atoi(port); err != nil || number < 1 || number > 65535 {
			return "", errors.New("invalid port")
		}
	}
	if port != "" {
		host = net.JoinHostPort(strings.Trim(host, "[]"), port)
	}
	return scheme + "://" + host + "/", nil
}

func allDigitsAndDots(host string) bool {
	return strings.Trim(host, "0123456789.") == ""
}
