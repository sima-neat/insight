package slots

import (
	"net"
	"strconv"
	"strings"
)

// The ports MediaMTX listens on inside Insight's machine (webrtc/mediamtx.yml), which the URLs
// name when the port map says nothing else.
const (
	defaultRTSPPort = 8554
	defaultWHIPPort = 8889
)

// urls builds a slot's URLs for a browser that reached Insight at a host.
type urls struct {
	rtspPort, whipPort string
	origin             string // the public origin, with its trailing slash; "" for none
}

func newURLs(o URLOptions) urls {
	u := urls{rtspPort: strconv.Itoa(defaultRTSPPort), whipPort: strconv.Itoa(defaultWHIPPort), origin: o.PublicOrigin}
	if o.RTSPPort > 0 {
		u.rtspPort = strconv.Itoa(o.RTSPPort)
	}
	if o.WHIPPort > 0 {
		u.whipPort = strconv.Itoa(o.WHIPPort)
	}
	if u.origin != "" && !strings.HasSuffix(u.origin, "/") {
		u.origin += "/"
	}
	return u
}

// rtsp is source n's RTSP URL on the host the browser used: rtsp://<host>:<rtsp port>/srcN.
// RTSP never goes through the public origin, which proxies HTTP only.
func (u urls) rtsp(host string, n int) string {
	return "rtsp://" + net.JoinHostPort(hostName(host), u.rtspPort) + "/" + pathName(n)
}

// httpMJPEG is source n's HTTP MJPEG output: on the public origin when there is one, else on
// Insight's own port, as the browser reached it.
func (u urls) httpMJPEG(host string, n int) string {
	suffix := "stream/http/" + pathName(n) + ".mjpg"
	if u.origin != "" {
		return u.origin + suffix
	}
	if host == "" {
		host = "127.0.0.1"
	}
	return "https://" + host + "/" + suffix
}

// whip is where a browser publishes webcam n: on the public origin when there is one, else on
// MediaMTX's WHIP port of the host the browser used.
func (u urls) whip(host string, n int) string {
	suffix := camName(n) + "/whip"
	if u.origin != "" {
		return u.origin + suffix
	}
	return "https://" + net.JoinHostPort(hostName(host), u.whipPort) + "/" + suffix
}

// hostName is a Host header without its port ("[::1]:9900" is "::1"); 127.0.0.1 for none.
func hostName(host string) string {
	host = strings.TrimSpace(host)
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if host == "" {
		return "127.0.0.1"
	}
	return host
}
