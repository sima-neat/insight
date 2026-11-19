package slots

import (
	"strings"
	"testing"
	"time"

	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/mediamtx"
)

func TestPullURLs(t *testing.T) {
	cases := []struct {
		url, user, password string
		full, host, path    string
		kept                string // the URL kept on disk
		problem             string
	}{
		{url: " rtsp://cam.local/live ", full: "rtsp://cam.local/live", host: "cam.local:554", path: "/live", kept: "rtsp://cam.local/live"},
		{url: "RTSPS://cam.local:7441/a b", full: "rtsps://cam.local:7441/a%20b", host: "cam.local:7441", path: "/a%20b", kept: "rtsps://cam.local:7441/a%20b"},
		{url: "rtsps://cam.local/x", host: "cam.local:322", full: "rtsps://cam.local/x", path: "/x", kept: "rtsps://cam.local/x"},
		{url: "rtsp://[fe80::1]/x", host: "[fe80::1]:554", full: "rtsp://[fe80::1]/x", path: "/x", kept: "rtsp://[fe80::1]/x"},
		{url: "rtsp://old:pw@cam/x", user: "admin", password: "p@ss:word", full: "rtsp://admin:p%40ss%3Aword@cam/x", host: "cam:554", path: "/x"},
		{url: "rtsp://old:pw@cam/x", full: "rtsp://old:pw@cam/x", host: "cam:554", path: "/x"},
		{url: "rtsp://cam/x", user: "viewer", full: "rtsp://viewer@cam/x", host: "cam:554", path: "/x"},
		{url: "rtsp://cam/x?token=abc&channel=1&flag", full: "rtsp://cam/x?token=abc&channel=1&flag", host: "cam:554", path: "/x?token=***&channel=***&***"},
		{url: "rtsp://cam/x#frag", full: "rtsp://cam/x", host: "cam:554", path: "/x", kept: "rtsp://cam/x"},
		{url: "http://cam/x", problem: "Only rtsp:// and rtsps://"},
		{url: "cam.local/live", problem: "Only rtsp:// and rtsps://"},
		{url: "rtsp:///live", problem: "needs a host"},
		{url: "rtsp://cam:99999/x", problem: "port"},
		{url: "rtsp://cam:0/x", problem: "port"},
		{url: "rtsp://cam\x7f/x", problem: "not a valid URL"},
	}
	for _, c := range cases {
		got, err := parsePullURL(c.url, c.user, c.password)
		if c.problem != "" {
			if err == nil || !strings.Contains(err.Error(), c.problem) {
				t.Errorf("%q: %v, want an error about %q", c.url, err, c.problem)
			}
			wantCode(t, err, CodeInvalidPullURL)
			continue
		}
		if err != nil {
			t.Errorf("%q: %v", c.url, err)
			continue
		}
		if got.full != c.full || got.target.Host != c.host || got.target.Path != c.path || got.target.URL != c.kept {
			t.Errorf("%q: %+v %+v", c.url, got, got.target)
		}
	}
	p, _ := parsePullURL("rtsp://cam/x", "admin", "hunter2")
	if got := p.redact("rtsp://admin:hunter2@cam/x: refused for hunter2"); got != "rtsp://cam:554/x: refused for ***" {
		t.Errorf("redacted: %q", got)
	}
}

func TestProbeFailuresAreClassified(t *testing.T) {
	url := "rtsp://admin:hunter2@cam/x"
	cases := []struct {
		stderr string
		auth   bool
		detail string
	}{
		{"[rtsp @ 0x55d1c0] method DESCRIBE failed: 401 Unauthorized\n" + url + ": Server returned 401 Unauthorized (authorization failed)", true, ""},
		{url + ": Server returned 403 Forbidden (access denied)", true, ""},
		{url + ": Connection refused", false, "Connection refused"},
		{"[tcp @ 0x1] Failed to resolve hostname cam: Name or service not known\n" + url + ": Input/output error", false, "Input/output error"},
		{"[rtsp @ 0x2] method DESCRIBE failed: 404 Not Found\n" + url + ": Server returned 404 Not Found", false, "Server returned 404 Not Found"},
		{"rtsp://other:secret@host/y: Connection timed out", false, "Connection timed out"},
		{"", false, ""},
	}
	for _, c := range cases {
		got := classifyProbeFailure(c.stderr, url)
		if got.Auth != c.auth || got.Detail != c.detail {
			t.Errorf("%q: %+v", c.stderr, got)
		}
		if strings.Contains(got.Error(), "hunter2") || strings.Contains(got.Error(), "secret") {
			t.Errorf("%q: the message holds a password: %s", c.stderr, got)
		}
	}
	info, err := parseStreamProbe([]byte(`{"streams":[{"codec_name":"hevc","width":1920,"height":1080,"avg_frame_rate":"0/0","r_frame_rate":"30000/1001"}]}`))
	if err != nil || info.Codec != "h265" || info.Width != 1920 || info.FPS < 29.9 || info.FPS > 30 {
		t.Errorf("a probe: %+v %v", info, err)
	}
	if _, err := parseStreamProbe([]byte(`{"streams":[]}`)); err == nil {
		t.Error("a stream without video was probed")
	}
}

func TestRenditionNames(t *testing.T) {
	st := stamp{size: 100, mtime: 5}
	name := renditionName("clips/My clip (1).mp4", st, 15, "h264")
	if !renditionFile.MatchString(name) || !strings.HasPrefix(name, "My_clip__1__") || !strings.HasSuffix(name, "_15fps_h264.mp4") {
		t.Errorf("a rendition's name: %s", name)
	}
	if !renditionTemp.MatchString("." + name + ".tmp") {
		t.Errorf("an unfinished rendition's name is not recognized: .%s.tmp", name)
	}
	if renditionName("clips/a.mp4", st, 15, "h264") == renditionName("other/a.mp4", st, 15, "h264") {
		t.Error("two files of one name share a rendition")
	}
	if renditionName("a.mp4", st, 15, "h264") == renditionName("a.mp4", stamp{size: 100, mtime: 6}, 15, "h264") {
		t.Error("two versions of a file share a rendition")
	}
	for _, stem := range []string{"...", "", "日本"} {
		if got := safeStem(stem); got == "" || strings.HasPrefix(got, ".") {
			t.Errorf("the stem of %q is %q", stem, got)
		}
	}
	if len(safeStem(strings.Repeat("a", 200))) != 48 {
		t.Error("a long stem is not cut")
	}
}

func TestURLs(t *testing.T) {
	direct := newURLs(URLOptions{})
	mapped := newURLs(URLOptions{RTSPPort: 30554, WHIPPort: 30889})
	hosted := newURLs(URLOptions{PublicOrigin: "https://lab.example.com/"})
	cases := []struct {
		u                urls
		host             string
		rtsp, http, whip string
	}{
		{direct, "10.0.0.5:9900", "rtsp://10.0.0.5:8554/src3", "https://10.0.0.5:9900/stream/http/src3.mjpg", "https://10.0.0.5:8889/cam3/whip"},
		{direct, "devkit", "rtsp://devkit:8554/src3", "https://devkit/stream/http/src3.mjpg", "https://devkit:8889/cam3/whip"},
		{direct, "[fd00::5]:9900", "rtsp://[fd00::5]:8554/src3", "https://[fd00::5]:9900/stream/http/src3.mjpg", "https://[fd00::5]:8889/cam3/whip"},
		{direct, "", "rtsp://127.0.0.1:8554/src3", "https://127.0.0.1/stream/http/src3.mjpg", "https://127.0.0.1:8889/cam3/whip"},
		{mapped, "host:30900", "rtsp://host:30554/src3", "https://host:30900/stream/http/src3.mjpg", "https://host:30889/cam3/whip"},
		{hosted, "10.0.0.5:9900", "rtsp://10.0.0.5:8554/src3", "https://lab.example.com/stream/http/src3.mjpg", "https://lab.example.com/cam3/whip"},
	}
	for _, c := range cases {
		if got := c.u.rtsp(c.host, 3); got != c.rtsp {
			t.Errorf("rtsp at %q: %s", c.host, got)
		}
		if got := c.u.httpMJPEG(c.host, 3); got != c.http {
			t.Errorf("http at %q: %s", c.host, got)
		}
		if got := c.u.whip(c.host, 3); got != c.whip {
			t.Errorf("whip at %q: %s", c.host, got)
		}
	}
}

func TestSlotStatesAreDerived(t *testing.T) {
	video := media.Info{Kind: media.KindVideo, Codec: "h264", Width: 1280, Height: 720, FPS: 29.97}
	live := mediamtx.Path{Name: "src1", Ready: true, Codec: "h264", Source: &mediamtx.Source{Type: "rtspSession", ID: "s", Protocol: "rtsp", Address: "127.0.0.1", Insight: true}}
	idle := mediamtx.Path{Name: "src1"}
	pulled := mediamtx.Path{Name: "src1", Ready: true, Codec: "h265", Source: &mediamtx.Source{Type: "rtspSource", Protocol: "rtspSource"}}
	foreign := mediamtx.Path{Name: "src1", Ready: true, Codec: "mjpeg", Source: &mediamtx.Source{Type: "rtspSession", ID: "x", Protocol: "rtsp", Address: "10.0.0.3"}}
	running := &procState{running: true}
	crashed := &procState{lastExit: "exit status 1", tail: []string{"first", "Connection refused"}}
	encoding := &jobs.Snapshot{ID: "job-1", State: jobs.Running}
	finished := &jobs.Snapshot{ID: "job-1", State: jobs.Done}
	file := Desired{Kind: KindFile, File: "a.mp4", Run: true}
	pull := Desired{Kind: KindPull, Run: true, Pull: &PullTarget{Scheme: "rtsp", Host: "cam:554", Path: "/x"}}
	stoppedPull := pull
	stoppedPull.Run = false

	cases := []struct {
		name  string
		o     observation
		state State
		error string
		pull  PullStatus
		job   string
	}{
		{name: "nothing", o: observation{desired: Desired{Kind: KindNone}, path: &idle}, state: Idle},
		{name: "a file, stopped", o: observation{desired: Desired{Kind: KindFile, File: "a.mp4"}, info: &video, problem: "ignored"}, state: Idle},
		{name: "a file, probing", o: observation{desired: file}, state: Starting},
		{name: "a file, its problem", o: observation{desired: file, problem: "a.mp4 is not in the media library any more."}, state: Failed, error: "not in the media library"},
		{name: "a file, blocked first", o: observation{desired: file, blocked: "could not start", problem: "other"}, state: Failed, error: "could not start"},
		{name: "a file, encoding", o: observation{desired: file, info: &video, job: encoding}, state: Preparing, job: "job-1"},
		{name: "a file, encoded", o: observation{desired: file, info: &video, job: finished}, state: Starting},
		{name: "a file, publishing", o: observation{desired: file, info: &video, proc: running, path: &idle}, state: Starting},
		{name: "a file, live", o: observation{desired: file, info: &video, proc: running, path: &live}, state: Live},
		{name: "a file, its publisher exited", o: observation{desired: file, info: &video, proc: crashed}, state: Failed, error: "Connection refused"},
		{name: "a file, held", o: observation{desired: file, info: &video, path: &foreign, external: true}, state: External},
		{name: "a webcam, stopped", o: observation{desired: Desired{Kind: KindWebcam}, cam: true}, state: Idle},
		{name: "a webcam, waiting", o: observation{desired: Desired{Kind: KindWebcam, Run: true}}, state: Idle},
		{name: "a webcam, publishing", o: observation{desired: Desired{Kind: KindWebcam, Run: true}, cam: true, path: &idle}, state: Starting},
		{name: "a webcam, live", o: observation{desired: Desired{Kind: KindWebcam, Run: true}, cam: true, path: &live}, state: Live},
		{name: "a pull, connecting", o: observation{desired: pull, fullURL: true, probe: pullProbe{status: PullConnecting}}, state: Starting, pull: PullConnecting},
		{name: "a pull, unreachable", o: observation{desired: pull, fullURL: true, probe: pullProbe{status: PullUnreachable, err: "Connection refused"}}, state: Starting, pull: PullUnreachable, error: "Connection refused"},
		{name: "a pull, refused", o: observation{desired: pull, fullURL: true, probe: pullProbe{status: PullAuthFailed, err: "rejected"}}, state: Failed, pull: PullAuthFailed, error: "rejected"},
		{name: "a pull, live", o: observation{desired: pull, fullURL: true, path: &pulled, probe: pullProbe{status: PullUnreachable, err: "old"}}, state: Live, pull: PullLive},
		{name: "a pull, stopped", o: observation{desired: stoppedPull, fullURL: true}, state: Idle, pull: PullStopped},
		{name: "a pull, no credentials", o: observation{desired: stoppedPull}, state: Idle, pull: PullNeedsCredentials, error: "enter the stream URL again"},
		{name: "a pull, MediaMTX refused it", o: observation{desired: pull, fullURL: true, blocked: "MediaMTX refused"}, state: Failed, pull: PullUnreachable, error: "MediaMTX refused"},
	}
	for _, c := range cases {
		c.o.n = 1
		s := derive(c.o)
		if s.State != c.state || !strings.Contains(s.Error, c.error) || (c.error == "" && s.Error != "") || s.Job != c.job {
			t.Errorf("%s: %s %q job %q, want %s %q", c.name, s.State, s.Error, s.Job, c.state, c.error)
		}
		if c.pull != "" && (s.Pull == nil || s.Pull.Status != c.pull) {
			t.Errorf("%s: the pull %+v, want %s", c.name, s.Pull, c.pull)
		}
		if s.Readers == nil {
			t.Errorf("%s: readers are null", c.name)
		}
	}

	rate := 2_000_000.0
	s := derive(observation{n: 1, desired: Desired{Kind: KindFile, File: "a.mp4", FPS: 15, Run: true}, info: &video,
		proc: running, path: &live, bitrate: &rate, active: ".renditions/a.mp4"})
	if *s.NativeFPS != 30 || *s.FPS != 15 || s.Publisher.FPS != 15 || s.Publisher.BitrateBPS != rate || s.ActiveFile != ".renditions/a.mp4" {
		t.Errorf("a live file slot: %+v %+v", s, s.Publisher)
	}
	foreign.Readers = []mediamtx.Reader{{Protocol: "rtsp", Address: "10.0.0.4"}, {Protocol: "rtsp", Address: "127.0.0.1", Label: mediamtx.PreviewLabel}}
	stats := StreamInfo{Width: 320, Height: 240, FPS: 10}
	s = derive(observation{n: 1, desired: Desired{Kind: KindNone}, path: &foreign, external: true, stats: &stats})
	if s.State != External || s.Codec != "mjpeg" || s.URLs.HTTPMJPEG == "" || s.Publisher.Width != 320 || len(s.Readers) != 2 || s.Readers[1].Label != mediamtx.PreviewLabel {
		t.Errorf("an external MJPEG slot: %+v %+v", s, s.Publisher)
	}
	if !s.Publisher.Since.IsZero() && time.Since(s.Publisher.Since) < 0 {
		t.Error("since lies ahead")
	}
}
