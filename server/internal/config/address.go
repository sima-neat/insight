package config

import (
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strings"
)

// AddressFinder asks the machine for its addresses. Tests replace it.
type AddressFinder interface {
	// SourceAddress is the local address the route to target leaves from. It sends nothing.
	SourceAddress(target string) (netip.Addr, bool)
	// InterfaceAddresses are the IPv4 addresses of each network interface, by name.
	InterfaceAddresses() map[string][]netip.Addr
}

// certHost is the address the certificate covers besides 127.0.0.1 and localhost:
// NFS_SERVER_HOST_IP when set (the SDK sets it to the host's address), else the machine's own
// address on its network.
func certHost(env Env, addrs AddressFinder) (string, error) {
	if value := strings.TrimSpace(env("NFS_SERVER_HOST_IP")); value != "" {
		address, err := netip.ParseAddr(value)
		if err != nil {
			return "", fmt.Errorf("NFS_SERVER_HOST_IP must be an IP address, not %q", value)
		}
		return address.String(), nil
	}
	return lanAddress(env, addrs).String(), nil
}

// lanAddress is the address other machines on the network most likely reach this one at:
// CONTAINER_HOST_IP when it is one, else the address of a physical interface that the route to
// the paired DevKit or to the internet leaves from, else the first physical interface's,
// else 127.0.0.1.
func lanAddress(env Env, addrs AddressFinder) netip.Addr {
	if address, ok := reachableIPv4(env("CONTAINER_HOST_IP")); ok {
		return address
	}
	physical := physicalAddresses(addrs.InterfaceAddresses())
	targets := []string{"8.8.8.8:443"}
	if devkit := strings.TrimSpace(env("DEVKIT_SYNC_DEVKIT_IP")); devkit != "" {
		targets = append([]string{net.JoinHostPort(devkit, "22")}, targets...)
	}
	for _, target := range targets {
		if address, ok := addrs.SourceAddress(target); ok && slices.Contains(physical, address) {
			return address
		}
	}
	if len(physical) > 0 {
		return physical[0]
	}
	return netip.MustParseAddr("127.0.0.1")
}

func reachableIPv4(value string) (netip.Addr, bool) {
	address, err := netip.ParseAddr(strings.TrimSpace(value))
	if err != nil || !address.Is4() || address.IsLoopback() || address.IsLinkLocalUnicast() ||
		address.IsUnspecified() {
		return netip.Addr{}, false
	}
	return address, true
}

// Interface names: a physical one is Ethernet or Wi-Fi; bridges, tunnels, VPNs and container
// interfaces are not, though some of them start like one ("wg0", "br-…").
var (
	virtualPrefixes  = []string{"lo", "docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "tun", "tap", "ppp", "wg", "zt", "tailscale", "ipsec", "bridge"}
	physicalPrefixes = []string{"en", "eth", "wl"}
)

func physicalAddresses(interfaces map[string][]netip.Addr) []netip.Addr {
	names := make([]string, 0, len(interfaces))
	for name := range interfaces {
		names = append(names, name)
	}
	slices.Sort(names)
	var result []netip.Addr
	for _, name := range names {
		if !isPhysicalInterface(name) {
			continue
		}
		for _, address := range interfaces[name] {
			if address, ok := reachableIPv4(address.String()); ok {
				result = append(result, address)
			}
		}
	}
	return result
}

func isPhysicalInterface(name string) bool {
	name = strings.ToLower(name)
	for _, prefix := range virtualPrefixes {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	for _, prefix := range physicalPrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// SystemAddresses asks the operating system.
type SystemAddresses struct{}

// SourceAddress connects a UDP socket, which sends no packet, and reads its local address.
func (SystemAddresses) SourceAddress(target string) (netip.Addr, bool) {
	conn, err := net.Dial("udp4", target)
	if err != nil {
		return netip.Addr{}, false
	}
	defer conn.Close()
	local, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return netip.Addr{}, false
	}
	address, ok := netip.AddrFromSlice(local.IP)
	return address.Unmap(), ok
}

// InterfaceAddresses lists each interface's IPv4 addresses.
func (SystemAddresses) InterfaceAddresses() map[string][]netip.Addr {
	result := map[string][]netip.Addr{}
	interfaces, err := net.Interfaces()
	if err != nil {
		return result
	}
	for _, iface := range interfaces {
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			prefix, err := netip.ParsePrefix(address.String())
			if err != nil || !prefix.Addr().Is4() {
				continue
			}
			result[iface.Name] = append(result[iface.Name], prefix.Addr())
		}
	}
	return result
}
