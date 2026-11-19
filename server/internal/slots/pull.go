package slots

import (
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// The ports a camera URL without one means (RFC 7826).
var defaultPullPorts = map[string]int{"rtsp": 554, "rtsps": 322}

// pullURL is a camera URL checked and taken apart: the whole URL with its credentials, which
// stays in memory, and the parts Insight may keep and show.
type pullURL struct {
	full   string
	target PullTarget
	// user and password are the credentials in full, for telling them from a probe's message.
	user, password string
}

// parsePullURL checks a camera URL and puts the form's user and password into it; a user typed
// into the form replaces one in the URL. The URL may take no fragment and has to name a host.
func parsePullURL(raw, user, password string) (pullURL, error) {
	raw = strings.TrimSpace(raw)
	invalid := func(message string) error {
		return newError(http.StatusBadRequest, CodeInvalidPullURL, "%s", message)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return pullURL{}, invalid("The stream URL is not a valid URL.")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if _, ok := defaultPullPorts[scheme]; !ok {
		return pullURL{}, invalid("Only rtsp:// and rtsps:// stream URLs are supported.")
	}
	if parsed.Opaque != "" || parsed.Hostname() == "" {
		return pullURL{}, invalid("The stream URL needs a host, for example rtsp://192.168.1.10:554/stream1.")
	}
	port := defaultPullPorts[scheme]
	if text := parsed.Port(); text != "" {
		number, err := strconv.Atoi(text)
		if err != nil || number < 1 || number > 65535 {
			return pullURL{}, invalid("The port in the stream URL is invalid.")
		}
		port = number
	}
	user = strings.TrimSpace(user)
	switch {
	case user != "" && password != "":
		parsed.User = url.UserPassword(user, password)
	case user != "":
		parsed.User = url.User(user)
	case parsed.User != nil:
		user = parsed.User.Username()
		password, _ = parsed.User.Password()
	}
	parsed.Scheme, parsed.Fragment, parsed.RawFragment = scheme, "", ""

	shown := parsed.EscapedPath()
	if parsed.RawQuery != "" {
		shown += "?" + maskQuery(parsed.RawQuery)
	}
	target := PullTarget{
		Scheme: scheme,
		Host:   net.JoinHostPort(parsed.Hostname(), strconv.Itoa(port)),
		Path:   shown,
	}
	if parsed.User == nil && parsed.RawQuery == "" {
		target.URL = parsed.String()
	}
	return pullURL{full: parsed.String(), target: target, user: user, password: password}, nil
}

// maskQuery keeps a query's parameter names and masks every value: some cameras take a token
// in the query.
func maskQuery(query string) string {
	parts := strings.Split(query, "&")
	for i, part := range parts {
		if name, _, found := strings.Cut(part, "="); found {
			parts[i] = name + "=***"
		} else {
			parts[i] = "***"
		}
	}
	return strings.Join(parts, "&")
}

// redactURL removes a camera URL and its secrets from a message, wherever a tool repeated them.
func (p pullURL) redact(message string) string {
	if p.full != "" {
		message = strings.ReplaceAll(message, p.full, p.target.Scheme+"://"+p.target.Host+p.target.Path)
	}
	for _, secret := range []string{p.password, url.QueryEscape(p.password), url.PathEscape(p.password)} {
		if len(secret) >= 3 {
			message = strings.ReplaceAll(message, secret, "***")
		}
	}
	return message
}

// PullStatus is how a pull slot's camera connection stands.
type PullStatus string

const (
	// PullLive: MediaMTX is receiving the camera's stream.
	PullLive PullStatus = "live"
	// PullConnecting: MediaMTX is pulling and the camera answered the last probe.
	PullConnecting PullStatus = "connecting"
	// PullUnreachable: the camera did not answer the last probe; MediaMTX keeps trying.
	PullUnreachable PullStatus = "unreachable"
	// PullAuthFailed: the camera refused the credentials; the pull is paused until the URL
	// is given again or the slot is started again.
	PullAuthFailed PullStatus = "auth_failed"
	// PullNeedsCredentials: a pull restored after a restart whose URL held secrets, which
	// were not kept; it needs its URL again.
	PullNeedsCredentials PullStatus = "needs_credentials"
	// PullStopped: the slot is stopped.
	PullStopped PullStatus = "stopped"
)
