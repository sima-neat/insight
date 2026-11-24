package slots

import (
	"bufio"
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
)

// A CameraProber checks that a pull's camera answers at its URL (rtsp:// or rtsps://, with the
// credentials in it) and takes the credentials. A failure is a *ProbeError.
type CameraProber func(ctx context.Context, url string) error

// maxRTSPResponse bounds what DescribeCamera reads of one answer: its head and its body.
const maxRTSPResponse = 64 << 10

var (
	errAnswerTooLarge = errors.New("the answer is too large")
	errNotRTSP        = errors.New("not an RTSP answer")
)

// cappedReader reads at most left bytes, then fails with errAnswerTooLarge rather than end, so
// that an answer cut by the cap is not taken for a closed connection.
type cappedReader struct {
	r    io.Reader
	left int64
}

func (c *cappedReader) Read(p []byte) (int, error) {
	if c.left <= 0 {
		return 0, errAnswerTooLarge
	}
	if int64(len(p)) > c.left {
		p = p[:c.left]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	return n, err
}

// DescribeCamera is the CameraProber Insight uses: an RTSP DESCRIBE, and a second one answering
// the camera's challenge (MD5 Digest, else Basic), from this process, so the credentials reach
// no command line (a process's arguments are any local user's to read). It asks for nothing
// but whether the camera answers; what the stream holds is probed once MediaMTX pulls it. A
// challenge it cannot answer (SHA-256, another scheme) passes: MediaMTX may still answer it.
func DescribeCamera(ctx context.Context, rawURL string) error {
	ctx, cancel := context.WithTimeout(ctx, streamProbeTimeout)
	defer cancel()
	target, err := url.Parse(rawURL)
	if err != nil {
		return &ProbeError{Detail: "The stream URL is not a valid URL"}
	}
	user := target.User.Username()
	password, _ := target.User.Password()
	target.User = nil
	if target.Path == "" {
		target.Path = "/" // as a camera expects the root asked for
	}
	uri := target.String()

	port := target.Port()
	if port == "" {
		port = strconv.Itoa(defaultPullPorts[target.Scheme])
	}
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(target.Hostname(), port))
	if err != nil {
		return dialFailure(ctx, err)
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if target.Scheme == "rtsps" {
		secure := tls.Client(conn, &tls.Config{ServerName: target.Hostname()})
		if err := secure.HandshakeContext(ctx); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			var untrusted *tls.CertificateVerificationError
			if errors.As(err, &untrusted) {
				return &ProbeError{Detail: "The camera's certificate is not trusted (TLS)"}
			}
			return &ProbeError{Detail: "The TLS handshake failed"}
		}
		conn = secure
	}

	reader := textproto.NewReader(bufio.NewReader(&cappedReader{r: conn, left: 2 * maxRTSPResponse}))
	status, reason, header, err := describe(conn, reader, uri, 1, "")
	if err == nil && status == 401 && len(header.Values("WWW-Authenticate")) > 0 {
		if user == "" {
			return &ProbeError{Auth: true}
		}
		authorization, ok := authorizationFor(header.Values("WWW-Authenticate"), user, password, uri)
		if !ok {
			return nil
		}
		status, reason, _, err = describe(conn, reader, uri, 2, authorization)
	}
	switch {
	case ctx.Err() != nil:
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return &ProbeError{Detail: fmt.Sprintf("Timed out after %s", streamProbeTimeout)}
		}
		return ctx.Err()
	case errors.Is(err, errAnswerTooLarge):
		return &ProbeError{Detail: "The camera's answer is too large"}
	case errors.Is(err, errNotRTSP):
		return &ProbeError{Detail: "The camera's answer is not RTSP"}
	case err != nil:
		return &ProbeError{Detail: "The camera closed the connection"}
	case status >= 200 && status < 300:
		return nil
	case status == 401 || status == 403:
		return &ProbeError{Auth: true}
	}
	return &ProbeError{Detail: strings.TrimSpace(fmt.Sprintf("The camera answered %d %s", status, reason))}
}

func dialFailure(ctx context.Context, err error) error {
	var dnsErr *net.DNSError
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return &ProbeError{Detail: fmt.Sprintf("Timed out after %s", streamProbeTimeout)}
	case ctx.Err() != nil:
		return ctx.Err()
	case errors.As(err, &dnsErr):
		return &ProbeError{Detail: "Could not resolve " + dnsErr.Name}
	case errors.Is(err, syscall.ECONNREFUSED):
		return &ProbeError{Detail: "Connection refused"}
	case errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH):
		return &ProbeError{Detail: "No route to the camera"}
	}
	return &ProbeError{Detail: "The camera did not answer"}
}

// describe sends one DESCRIBE and reads its answer, its body included, so that a second request
// on the connection reads its own.
func describe(conn net.Conn, reader *textproto.Reader, uri string, cseq int, authorization string) (int, string, textproto.MIMEHeader, error) {
	request := fmt.Sprintf("DESCRIBE %s RTSP/1.0\r\nCSeq: %d\r\nAccept: application/sdp\r\nUser-Agent: neat-insight\r\n", uri, cseq)
	if authorization != "" {
		request += "Authorization: " + authorization + "\r\n"
	}
	if _, err := io.WriteString(conn, request+"\r\n"); err != nil {
		return 0, "", nil, err
	}
	line, err := reader.ReadLine()
	if err != nil {
		return 0, "", nil, err
	}
	version, rest, _ := strings.Cut(line, " ")
	code, reason, _ := strings.Cut(rest, " ")
	status, err := strconv.Atoi(code)
	if !strings.HasPrefix(version, "RTSP/") || err != nil {
		return 0, "", nil, errNotRTSP
	}
	header, err := reader.ReadMIMEHeader()
	if err != nil {
		return 0, "", nil, err
	}
	if length, err := strconv.Atoi(header.Get("Content-Length")); err == nil && length > 0 {
		if length > maxRTSPResponse {
			return 0, "", nil, errAnswerTooLarge
		}
		if _, err := io.CopyN(io.Discard, reader.R, int64(length)); err != nil {
			return 0, "", nil, err
		}
	}
	return status, reason, header, nil
}

var challengeParam = regexp.MustCompile(`([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]*)`)

// authorizationFor answers the best challenge it can: MD5 Digest (RFC 2617, without qop or with
// qop=auth), then Basic; false when none of them is one of those.
func authorizationFor(challenges []string, user, password, uri string) (string, bool) {
	type challenge struct {
		scheme string
		params map[string]string
	}
	var parsed []challenge
	for _, value := range challenges {
		scheme, rest, _ := strings.Cut(strings.TrimSpace(value), " ")
		params := map[string]string{}
		for _, match := range challengeParam.FindAllStringSubmatch(rest, -1) {
			params[strings.ToLower(match[1])] = strings.Trim(match[2], `"`)
		}
		parsed = append(parsed, challenge{strings.ToLower(scheme), params})
	}
	for _, c := range parsed {
		qops := strings.Split(strings.ToLower(strings.ReplaceAll(c.params["qop"], " ", "")), ",")
		withQop := c.params["qop"] != ""
		md5Algorithm := c.params["algorithm"] == "" || strings.EqualFold(c.params["algorithm"], "md5")
		if c.scheme == "digest" && md5Algorithm && (!withQop || slices.Contains(qops, "auth")) {
			return digest(c.params, user, password, uri, withQop), true
		}
	}
	for _, c := range parsed {
		if c.scheme == "basic" {
			return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password)), true
		}
	}
	return "", false
}

func digest(params map[string]string, user, password, uri string, withQop bool) string {
	hash := func(s string) string { sum := md5.Sum([]byte(s)); return hex.EncodeToString(sum[:]) }
	realm, nonce := params["realm"], params["nonce"]
	ha1, ha2 := hash(user+":"+realm+":"+password), hash("DESCRIBE:"+uri)
	fields := []string{"username=" + quoted(user), "realm=" + quoted(realm), "nonce=" + quoted(nonce), "uri=" + quoted(uri)}
	response := hash(ha1 + ":" + nonce + ":" + ha2)
	if withQop {
		var b [8]byte
		_, _ = rand.Read(b[:])
		cnonce, nc := hex.EncodeToString(b[:]), "00000001"
		response = hash(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":auth:" + ha2)
		fields = append(fields, "qop=auth", "nc="+nc, "cnonce="+quoted(cnonce))
	}
	fields = append(fields, "response="+quoted(response))
	if params["algorithm"] != "" {
		fields = append(fields, "algorithm=MD5")
	}
	if opaque := params["opaque"]; opaque != "" {
		fields = append(fields, "opaque="+quoted(opaque))
	}
	return "Digest " + strings.Join(fields, ", ")
}

// quoted is s as an RFC 2617 quoted-string.
func quoted(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}
