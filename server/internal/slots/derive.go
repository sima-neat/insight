package slots

import (
	"time"

	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/mediamtx"
)

// Slot is one slot as the API shows it: what was asked of it and how it stands.
type Slot struct {
	N    int  `json:"n"`
	Kind Kind `json:"kind"`
	// File is a file slot's library path.
	File string `json:"file,omitempty"`
	// FPS is a file slot's output rate when it is not the file's own, and a webcam slot's rate,
	// 30 or 60.
	FPS *int `json:"fps,omitempty"`
	// NativeFPS is the file's own rate, in whole frames per second, once it is probed.
	NativeFPS *int `json:"native_fps,omitempty"`
	// Codec is "h264", "h265", "mjpeg" or another codec's name: the file's, or the stream's
	// for a pull, a webcam or an external publisher; "" while unknown.
	Codec string     `json:"codec,omitempty"`
	Pull  *PullState `json:"pull,omitempty"`
	// Run is the user's Start: the slot is to run.
	Run   bool  `json:"run"`
	State State `json:"state"`
	// Error says why the slot failed, or why a pull is not live yet.
	Error string `json:"error,omitempty"`
	// Job is the rendition's encode while the slot is Preparing.
	Job string `json:"job,omitempty"`
	// Publisher is who publishes the slot's stream, while MediaMTX has one.
	Publisher *Publisher `json:"publisher,omitempty"`
	Readers   []Reader   `json:"readers"`
	URLs      URLs       `json:"urls"`
	// ActiveFile is what the slot's publisher streams: the file, or its rendition
	// (.renditions/...).
	ActiveFile string `json:"active_file,omitempty"`
}

// PullState is a pull slot's camera and how its connection stands.
type PullState struct {
	Scheme string     `json:"scheme"`
	Host   string     `json:"host"`
	Path   string     `json:"path"`
	Status PullStatus `json:"status"`
	Error  string     `json:"error,omitempty"`
}

// Publisher is the stream a slot carries.
type Publisher struct {
	// Protocol is "rtsp", "webrtc" and the like for a publisher, "rtspSource" or "rtspsSource"
	// for a camera MediaMTX pulls.
	Protocol string `json:"protocol"`
	// Address is the publisher's host, "" for a pull.
	Address        string    `json:"address,omitempty"`
	Since          time.Time `json:"since"`
	Codec          string    `json:"codec,omitempty"`
	CodecSupported bool      `json:"codec_supported"`
	Width          int       `json:"width,omitempty"`
	Height         int       `json:"height,omitempty"`
	FPS            float64   `json:"fps,omitempty"`
	BitrateBPS     float64   `json:"bitrate_bps,omitempty"`
}

// Reader is one reader of a slot's stream.
type Reader struct {
	Protocol string `json:"protocol"`
	Address  string `json:"address"`
	// Label is "insight preview" for Insight's live preview.
	Label string `json:"label,omitempty"`
}

// URLs are where a slot's stream is reached.
type URLs struct {
	RTSP string `json:"rtsp"`
	// HTTPMJPEG is the slot's HTTP MJPEG output, for an MJPEG stream.
	HTTPMJPEG string `json:"http_mjpeg,omitempty"`
	// WHIP is where a browser publishes a webcam slot's camera.
	WHIP string `json:"whip,omitempty"`
}

// observation is everything known of one slot at one moment, from which its Slot is derived.
type observation struct {
	n       int
	desired Desired
	urls    urls
	host    string

	info     *media.Info    // the file's probe
	path     *mediamtx.Path // srcN, nil while MediaMTX is unknown
	external bool           // a publisher Insight did not start holds srcN
	bitrate  *float64       // srcN's received rate
	stats    *StreamInfo    // a probe of srcN's stream
	cam      bool           // a browser publishes on the webcam slot's path at its rate
	proc     *procState     // the file slot's publisher
	active   string         // what it streams
	job      *jobs.Snapshot // the rendition's encode
	blocked  string         // why the slot stopped trying
	problem  string         // why it cannot run now
	fullURL  bool           // a pull's URL with its credentials is known
	probe    pullProbe      // the last probe of a pull's camera
}

type procState struct {
	running  bool
	lastExit string
	tail     []string
}

// supportedCodec says whether Neat decodes a stream's codec.
func supportedCodec(codec string) bool {
	return codec == media.CodecH264 || codec == media.CodecH265 || codec == media.CodecMJPEG
}

// derive makes slot o.n's Slot. It reads nothing but o.
func derive(o observation) Slot {
	d := o.desired
	s := Slot{N: o.n, Kind: d.Kind, Run: d.Run, State: Idle, Readers: []Reader{}}
	if d.Kind == KindFile {
		s.File = d.File
		if d.FPS > 0 {
			fps := d.FPS
			s.FPS = &fps
		}
		if o.info != nil {
			s.Codec = o.info.Codec
			if native := nativeFPS(*o.info); native > 0 && o.info.Kind == media.KindVideo {
				s.NativeFPS = &native
			}
		}
	}
	if d.Kind == KindWebcam {
		fps := d.FPS
		s.FPS = &fps
	}
	ready := o.path != nil && o.path.Ready
	if ready {
		s.Publisher = publisherOf(o)
		for _, r := range o.path.Readers {
			s.Readers = append(s.Readers, Reader{Protocol: r.Protocol, Address: r.Address, Label: r.Label})
		}
		if d.Kind != KindFile && o.path.Codec != "" {
			s.Codec = o.path.Codec
		}
	}
	if o.proc != nil && o.proc.running {
		s.ActiveFile = o.active
	}

	switch {
	case o.external:
		s.State = External
		if o.path.Codec != "" {
			s.Codec = o.path.Codec
		}
	case d.Kind == KindFile:
		s.State, s.Error = fileState(o, ready)
		if s.State == Preparing {
			s.Job = o.job.ID
		}
	case d.Kind == KindWebcam:
		switch {
		case !d.Run:
		case ready:
			s.State = Live
		case o.cam:
			s.State = Starting
		}
	case d.Kind == KindPull && d.Pull != nil:
		s.Pull = &PullState{Scheme: d.Pull.Scheme, Host: d.Pull.Host, Path: d.Pull.Path}
		s.State, s.Pull.Status, s.Error = pullState(o, ready)
		s.Pull.Error = s.Error
	}

	s.URLs = URLs{RTSP: o.urls.rtsp(o.host, o.n)}
	if s.Codec == media.CodecMJPEG {
		s.URLs.HTTPMJPEG = o.urls.httpMJPEG(o.host, o.n)
	}
	if d.Kind == KindWebcam {
		s.URLs.WHIP = o.urls.whip(o.host, o.n, d.FPS)
	}
	return s
}

func fileState(o observation, ready bool) (State, string) {
	switch {
	case !o.desired.Run:
		return Idle, ""
	case o.blocked != "":
		return Failed, o.blocked
	case o.problem != "":
		return Failed, o.problem
	case o.job != nil && !o.job.State.Final():
		return Preparing, ""
	case o.proc == nil:
		// The file is being probed, or the slot waits for MediaMTX.
		return Starting, ""
	case o.proc.running && ready:
		return Live, ""
	case o.proc.running || o.proc.lastExit == "":
		return Starting, ""
	}
	// The publisher exited and the supervisor starts it again after a pause.
	reason := o.proc.lastExit
	if len(o.proc.tail) > 0 {
		reason = o.proc.tail[len(o.proc.tail)-1]
	}
	return Failed, "The stream stopped (" + reason + "); it is started again."
}

func pullState(o observation, ready bool) (State, PullStatus, string) {
	switch {
	case !o.fullURL:
		return Idle, PullNeedsCredentials, "Insight keeps no camera credentials across a restart; enter the stream URL again."
	case !o.desired.Run:
		return Idle, PullStopped, ""
	case o.blocked != "":
		return Failed, PullUnreachable, o.blocked
	case ready:
		return Live, PullLive, ""
	case o.probe.status == PullAuthFailed:
		return Failed, PullAuthFailed, o.probe.err
	case o.probe.status == PullUnreachable:
		return Starting, PullUnreachable, o.probe.err
	}
	return Starting, PullConnecting, ""
}

// publisherOf describes the stream of a ready path: from the file Insight streams, or from a
// probe of the stream when Insight did not make it.
func publisherOf(o observation) *Publisher {
	p := &Publisher{Since: o.path.ReadySince, Codec: o.path.Codec, CodecSupported: supportedCodec(o.path.Codec)}
	if source := o.path.Source; source != nil {
		p.Protocol, p.Address = source.Protocol, source.Address
	}
	if o.bitrate != nil {
		p.BitrateBPS = *o.bitrate
	}
	switch {
	case o.desired.Kind == KindFile && !o.external && o.info != nil:
		p.Width, p.Height, p.FPS = o.info.Width, o.info.Height, o.info.FPS
		if o.desired.FPS > 0 {
			p.FPS = float64(o.desired.FPS)
		}
	case o.stats != nil:
		p.Width, p.Height, p.FPS = o.stats.Width, o.stats.Height, o.stats.FPS
	}
	return p
}

// observeLocked gathers slot n's observation; m.mu is held.
func (m *Manager) observeLocked(n int, host string) observation {
	rt := m.rt[n-1]
	o := observation{
		n: n, desired: m.store.get(n), urls: m.urls, host: host,
		info: rt.info, active: rt.procActive, blocked: rt.blocked, problem: rt.problem,
		fullURL: rt.fullURL != "", probe: rt.pullProbe,
	}
	if path, ok := m.snap.Paths[pathName(n)]; ok {
		o.path = &path
		if rate, ok := m.snap.Bitrate(m.prev, pathName(n)); ok {
			o.bitrate = &rate
		}
		if rt.stats.ok && rt.stats.key == path.StreamKey() {
			stats := rt.stats.info
			o.stats = &stats
		}
	}
	o.external = m.externalLocked(n) != nil
	if o.desired.Kind == KindWebcam {
		_, o.cam = camPublisher(m.snap, camName(n, o.desired.FPS))
	}
	if rt.proc != nil {
		status := rt.proc.Status()
		o.proc = &procState{running: status.Running, lastExit: status.LastExit, tail: rt.proc.Tail()}
	}
	if e := m.encodes[rt.rendition]; rt.rendition != "" && e != nil {
		job := e.job.Snapshot()
		o.job = &job
	}
	return o
}
