package slots

import (
	"bufio"
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// camera is an RTSP server in the test that answers DESCRIBE: open, or behind Digest or Basic
// with one user and password, or with a status of its own.
type camera struct {
	t        *testing.T
	listener net.Listener
	scheme   string // "", "digest" or "basic"
	qop      bool   // the Digest challenge offers qop=auth
	user     string
	password string
	status   string // answers every request with this status line's code and reason, when set
	requests chan textproto.MIMEHeader
}

func newCamera(t *testing.T, scheme string) *camera {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	c := &camera{t: t, listener: listener, scheme: scheme, user: "admin", password: "s3cret:pw", requests: make(chan textproto.MIMEHeader, 8)}
	t.Cleanup(func() { listener.Close() })
	go c.serve()
	return c
}

func (c *camera) url(userinfo string) string {
	return "rtsp://" + userinfo + c.listener.Addr().String() + "/live?token=1"
}

func (c *camera) serve() {
	for {
		conn, err := c.listener.Accept()
		if err != nil {
			return
		}
		go c.answer(conn)
	}
}

const testNonce = "a1b2c3"

func (c *camera) answer(conn net.Conn) {
	defer conn.Close()
	reader := textproto.NewReader(bufio.NewReader(conn))
	for {
		line, err := reader.ReadLine()
		if err != nil {
			return
		}
		header, err := reader.ReadMIMEHeader()
		if err != nil {
			return
		}
		header.Set("X-Request-Line", line)
		c.requests <- header
		method, uri, _ := strings.Cut(line, " ")
		uri, _, _ = strings.Cut(uri, " ")
		reply := func(status string, extra ...string) {
			fmt.Fprintf(conn, "RTSP/1.0 %s\r\nCSeq: %s\r\n%s", status, header.Get("CSeq"), strings.Join(extra, ""))
		}
		switch {
		case method != "DESCRIBE":
			reply("405 Method Not Allowed", "\r\n")
		case c.status != "":
			reply(c.status, "\r\n")
		case c.scheme == "" || c.authorized(header.Get("Authorization"), uri):
			sdp := "v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n"
			reply("200 OK", fmt.Sprintf("Content-Type: application/sdp\r\nContent-Length: %d\r\n\r\n%s", len(sdp), sdp))
		case c.scheme == "digest":
			qop := ""
			if c.qop {
				qop = `, qop="auth"`
			}
			body := "denied"
			reply("401 Unauthorized", fmt.Sprintf("WWW-Authenticate: Digest realm=\"cam\", nonce=\"%s\"%s\r\nContent-Length: %d\r\n\r\n%s", testNonce, qop, len(body), body))
		default:
			reply("401 Unauthorized", "WWW-Authenticate: Basic realm=\"cam\"\r\n\r\n")
		}
	}
}

// authorized checks an Authorization header as RFC 2617 says, for the camera's one user.
func (c *camera) authorized(value, uri string) bool {
	if c.scheme == "basic" {
		return value == "Basic "+base64.StdEncoding.EncodeToString([]byte(c.user+":"+c.password))
	}
	params, ok := strings.CutPrefix(value, "Digest ")
	if !ok {
		return false
	}
	fields := map[string]string{}
	for _, part := range strings.Split(params, ", ") {
		key, val, _ := strings.Cut(part, "=")
		fields[key] = strings.Trim(val, `"`)
	}
	hash := func(s string) string { sum := md5.Sum([]byte(s)); return hex.EncodeToString(sum[:]) }
	ha1, ha2 := hash(c.user+":cam:"+c.password), hash("DESCRIBE:"+uri)
	want := hash(ha1 + ":" + testNonce + ":" + ha2)
	if c.qop {
		want = hash(ha1 + ":" + testNonce + ":" + fields["nc"] + ":" + fields["cnonce"] + ":auth:" + ha2)
	}
	return fields["username"] == c.user && fields["uri"] == uri && fields["response"] == want
}

func probeErrorOf(t *testing.T, err error) *ProbeError {
	t.Helper()
	var probeErr *ProbeError
	if !errors.As(err, &probeErr) {
		t.Fatalf("not a ProbeError: %v", err)
	}
	return probeErr
}

func TestDescribeCameraAnswersTheChallenge(t *testing.T) {
	for _, test := range []struct {
		name   string
		scheme string
		qop    bool
	}{{"open", "", false}, {"digest", "digest", false}, {"digest with qop", "digest", true}, {"basic", "basic", false}} {
		t.Run(test.name, func(t *testing.T) {
			c := newCamera(t, test.scheme)
			c.qop = test.qop
			if err := DescribeCamera(context.Background(), c.url("admin:s3cret%3Apw@")); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDescribeCameraTellsRefusedCredentials(t *testing.T) {
	c := newCamera(t, "digest")
	if err := DescribeCamera(context.Background(), c.url("admin:wrong@")); !probeErrorOf(t, err).Auth {
		t.Fatalf("wrong credentials: %v", err)
	}
	if err := DescribeCamera(context.Background(), c.url("")); !probeErrorOf(t, err).Auth {
		t.Fatalf("no credentials: %v", err)
	}
	c.status = "403 Forbidden"
	if err := DescribeCamera(context.Background(), c.url("admin:s3cret%3Apw@")); !probeErrorOf(t, err).Auth {
		t.Fatalf("forbidden: %v", err)
	}
}

func TestDescribeCameraSaysWhyItDidNotAnswer(t *testing.T) {
	c := newCamera(t, "")
	c.status = "404 Not Found"
	err := DescribeCamera(context.Background(), c.url("admin:s3cret%3Apw@"))
	if probe := probeErrorOf(t, err); probe.Auth || probe.Detail != "The camera answered 404 Not Found" {
		t.Fatalf("a missing stream: %+v", probe)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := "rtsp://admin:s3cret@" + listener.Addr().String() + "/live"
	listener.Close()
	err = DescribeCamera(context.Background(), closed)
	if probe := probeErrorOf(t, err); probe.Auth || probe.Detail != "Connection refused" {
		t.Fatalf("a closed port: %+v", probe)
	}
}

func TestDescribeCameraSendsTheURLWithoutItsCredentials(t *testing.T) {
	c := newCamera(t, "basic")
	if err := DescribeCamera(context.Background(), c.url("admin:s3cret%3Apw@")); err != nil {
		t.Fatal(err)
	}
	close(c.requests)
	for header := range c.requests {
		for name, values := range header {
			for _, value := range values {
				if strings.Contains(value, "s3cret") {
					t.Errorf("%s: %q carries the password in clear", name, value)
				}
			}
		}
	}
}

func TestDescribeCameraStopsWithItsContext(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() { // accepts and never answers
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := DescribeCamera(ctx, "rtsp://"+listener.Addr().String()+"/live"); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled probe: %v", err)
	}
}

func TestFFprobeNeverTakesCredentials(t *testing.T) {
	ran := filepath.Join(t.TempDir(), "ran")
	ffprobe := filepath.Join(t.TempDir(), "ffprobe")
	must(t, os.WriteFile(ffprobe, []byte("#!/bin/sh\ntouch "+ran+"\n"), 0o755))
	_, err := FFprobeStream(ffprobe)(context.Background(), "rtsp://admin:s3cret@127.0.0.1:8554/src1")
	if probe := probeErrorOf(t, err); !strings.Contains(probe.Detail, "credentials") {
		t.Fatalf("a URL with credentials: %+v", probe)
	}
	if _, err := os.Stat(ran); err == nil {
		t.Fatal("ffprobe ran with the credentials on its command line")
	}
}

// rawCamera answers each connection with answer, whatever was asked.
func rawCamera(t *testing.T, answer func(net.Conn)) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				answer(conn)
			}()
		}
	}()
	return listener.Addr().String()
}

// readRequest reads one request's head off conn.
func readRequest(conn net.Conn) (string, error) {
	reader := textproto.NewReader(bufio.NewReader(conn))
	line, err := reader.ReadLine()
	if err == nil {
		_, err = reader.ReadMIMEHeader()
	}
	return line, err
}

func TestDescribeCameraOfMalformedAnswers(t *testing.T) {
	for _, test := range []struct {
		name   string
		answer func(net.Conn)
		want   string // the start of the detail
	}{
		{"an endless header", func(conn net.Conn) {
			_, _ = readRequest(conn)
			fmt.Fprint(conn, "RTSP/1.0 200 OK\r\nCSeq: 1\r\n")
			for {
				if _, err := fmt.Fprint(conn, "X-Filler: "+strings.Repeat("x", 1000)+"\r\n"); err != nil {
					return
				}
			}
		}, "The camera's answer is too large"},
		{"a huge body", func(conn net.Conn) {
			_, _ = readRequest(conn)
			fmt.Fprint(conn, "RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 999999999999\r\n\r\n")
		}, "The camera's answer is too large"},
		{"not RTSP", func(conn net.Conn) {
			_, _ = readRequest(conn)
			fmt.Fprint(conn, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
		}, "The camera's answer is not RTSP"},
		{"garbage", func(conn net.Conn) {
			_, _ = readRequest(conn)
			fmt.Fprint(conn, "\x00\x01\x02 nonsense\r\n\r\n")
		}, "The camera's answer is not RTSP"},
		{"silent", func(conn net.Conn) {
			_, _ = readRequest(conn)
			time.Sleep(time.Second)
		}, "Timed out"},
		{"a challenge, then gone", func(conn net.Conn) {
			_, _ = readRequest(conn)
			fmt.Fprint(conn, "RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Basic realm=\"cam\"\r\n\r\n")
		}, "The camera closed the connection"},
		{"closed at once", func(net.Conn) {}, "The camera closed the connection"},
	} {
		t.Run(test.name, func(t *testing.T) {
			address := rawCamera(t, test.answer)
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			defer cancel()
			err := DescribeCamera(ctx, "rtsp://admin:s3cret@"+address+"/live")
			if probe := probeErrorOf(t, err); probe.Auth || !strings.HasPrefix(probe.Detail, test.want) {
				t.Fatalf("%+v, want %q", probe, test.want)
			}
		})
	}
}

func TestDescribeCameraAsksForSlashWithoutAPath(t *testing.T) {
	lines := make(chan string, 1)
	address := rawCamera(t, func(conn net.Conn) {
		line, _ := readRequest(conn)
		lines <- line
		fmt.Fprint(conn, "RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n")
	})
	if err := DescribeCamera(context.Background(), "rtsp://"+address); err != nil {
		t.Fatal(err)
	}
	if line := <-lines; line != "DESCRIBE rtsp://"+address+"/ RTSP/1.0" {
		t.Fatalf("asked %q", line)
	}
}
