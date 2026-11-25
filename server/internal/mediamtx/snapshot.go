package mediamtx

import (
	"net"
	"net/url"
	"time"
)

// Snapshot is MediaMTX's paths at one moment, with each path's publisher and readers joined
// from the session lists.
type Snapshot struct {
	// At is when MediaMTX answered the path list, which the byte counts are from.
	At time.Time
	// Paths are keyed by name ("src3", "cam3", "cam3r60"). A configured path is listed whether
	// or not anything publishes; a cam path only while a browser publishes to it.
	Paths map[string]Path
}

// Path is one MediaMTX path.
type Path struct {
	Name string
	// Ready is true while the path has a stream: a publisher, or a pull that is connected.
	Ready bool
	// ReadySince is when it became ready; zero while it is not.
	ReadySince time.Time
	// Source is what feeds the path: a publishing session, or a pull's configured source;
	// nil when nothing does.
	Source *Source
	// Codec is the first video track's codec ("h264", "h265", "mjpeg", "vp8", "vp9", "av1",
	// "mpeg4", "mpeg2"), or "" without one.
	Codec string
	// Tracks are the tracks as MediaMTX names them ("H264", "Opus").
	Tracks []string
	// BytesReceived counts the bytes the path has received from its source.
	BytesReceived uint64
	// Readers are the path's readers, Insight's own probes left out.
	Readers []Reader
}

// Source is what feeds a path.
type Source struct {
	// Type is MediaMTX's word for it: "rtspSession", "webRTCSession", "srtConn" and the like
	// for a publisher, "rtspSource" or "rtspsSource" for a pull.
	Type string
	// ID is the publishing session's id, which Kick takes; "" for a pull.
	ID string
	// Protocol is "rtsp", "rtsps", "webrtc", "srt", "rtmp" or "rtmps" for a publisher, else
	// Type.
	Protocol string
	// Address is the publisher's host, without its port; "" for a pull or when unknown.
	Address string
	// Insight is true when the publisher's query carries this run's publisher tag.
	Insight bool
}

// Reader is one reader of a path.
type Reader struct {
	// Type and ID name its session as MediaMTX does.
	Type, ID string
	// Protocol is "rtsp", "webrtc" and the like.
	Protocol string
	// Address is the reader's host, without its port.
	Address string
	// Label is PreviewLabel for Insight's live preview, else "".
	Label string
}

// Pulled is true when the path's source is a camera MediaMTX pulls from, Insight's own
// configuration and never a foreign publisher.
func (p Path) Pulled() bool {
	return p.Source != nil && pullSourceTypes[p.Source.Type]
}

// External is true when the path is ready with a publisher Insight did not start.
func (p Path) External() bool {
	return p.Ready && p.Source != nil && p.Source.ID != "" && !p.Source.Insight && !p.Pulled()
}

// StreamKey names the stream the path carries: the publishing session, or the pull's current
// connection. A new publisher or a pull that reconnects gets a new key, so what was measured
// of the old stream (its rate, a probe of its size) is not taken for the new one. "" when the
// path carries none.
func (p Path) StreamKey() string {
	switch {
	case p.Source == nil:
		return ""
	case p.Source.ID != "":
		return p.Source.ID
	case p.Pulled() && p.Ready:
		return "pull:" + p.Name + ":" + p.ReadySince.Format(time.RFC3339Nano)
	}
	return ""
}

// Bitrate is the rate in bits per second at which path name received between prev and s. It
// is false when either snapshot lacks the path's stream, the stream changed between them, or
// its count went back (MediaMTX restarted).
func (s Snapshot) Bitrate(prev Snapshot, name string) (float64, bool) {
	now, ok := s.Paths[name]
	if !ok {
		return 0, false
	}
	before, ok := prev.Paths[name]
	key := now.StreamKey()
	elapsed := s.At.Sub(prev.At).Seconds()
	if !ok || key == "" || before.StreamKey() != key || elapsed <= 0 || now.BytesReceived < before.BytesReceived {
		return 0, false
	}
	return float64(now.BytesReceived-before.BytesReceived) * 8 / elapsed, true
}

// sessionKind is a kind of session or connection: a publisher's or reader's type, the API's
// list (and kick) of such sessions, and the protocol shown for it.
type sessionKind struct{ sourceType, endpoint, protocol string }

var sessionKinds = []sessionKind{
	{"rtspSession", "rtspsessions", "rtsp"},
	{"rtspsSession", "rtspssessions", "rtsps"},
	{"webRTCSession", "webrtcsessions", "webrtc"},
	{"srtConn", "srtconns", "srt"},
	{"rtmpConn", "rtmpconns", "rtmp"},
	{"rtmpsConn", "rtmpsconns", "rtmps"},
}

func kindOf(sourceType string) (sessionKind, bool) {
	for _, kind := range sessionKinds {
		if kind.sourceType == sourceType {
			return kind, true
		}
	}
	return sessionKind{}, false
}

// pullSourceTypes are the source types of a path whose configured source is a camera.
var pullSourceTypes = map[string]bool{"rtspSource": true, "rtspsSource": true}

var videoCodecs = map[string]string{
	"H264":           "h264",
	"H265":           "h265",
	"M-JPEG":         "mjpeg",
	"VP8":            "vp8",
	"VP9":            "vp9",
	"AV1":            "av1",
	"MPEG-4 Video":   "mpeg4",
	"MPEG-1/2 Video": "mpeg2",
}

// apiPath and apiSession are the parts of MediaMTX's answers (API v3, MediaMTX 1.12) a
// snapshot reads.
type apiPath struct {
	Name   string `json:"name"`
	Source *struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	} `json:"source"`
	Ready         bool     `json:"ready"`
	ReadyTime     *string  `json:"readyTime"`
	Tracks        []string `json:"tracks"`
	BytesReceived uint64   `json:"bytesReceived"`
	Readers       []struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	} `json:"readers"`
}

type apiSession struct {
	ID         string `json:"id"`
	RemoteAddr string `json:"remoteAddr"`
	Query      string `json:"query"`
}

type sessionRef struct{ kind, id string }

// buildSnapshot joins the path list with the session lists, which are keyed by source type.
func buildSnapshot(at time.Time, paths []apiPath, sessions map[string][]apiSession, publisher string) Snapshot {
	byRef := make(map[sessionRef]apiSession)
	for kind, list := range sessions {
		for _, session := range list {
			byRef[sessionRef{kind, session.ID}] = session
		}
	}
	snapshot := Snapshot{At: at, Paths: make(map[string]Path, len(paths))}
	for _, item := range paths {
		path := Path{
			Name:          item.Name,
			Ready:         item.Ready,
			Codec:         trackCodec(item.Tracks),
			Tracks:        item.Tracks,
			BytesReceived: item.BytesReceived,
			Readers:       []Reader{},
		}
		if item.Ready && item.ReadyTime != nil {
			// An unreadable time leaves ReadySince zero; nothing depends on it but display.
			path.ReadySince, _ = time.Parse(time.RFC3339Nano, *item.ReadyTime)
		}
		if item.Source != nil {
			source := &Source{Type: item.Source.Type, ID: item.Source.ID, Protocol: protocolOf(item.Source.Type)}
			if session, ok := byRef[sessionRef{item.Source.Type, item.Source.ID}]; ok && item.Source.ID != "" {
				source.Address = hostOf(session.RemoteAddr)
				source.Insight = queryHas(session.Query, publisherKey, publisher)
			}
			path.Source = source
		}
		for _, reader := range item.Readers {
			// A reader whose session is not in the lists left between the two answers, or is
			// of a kind the lists do not cover; either way there is no address to show.
			session, ok := byRef[sessionRef{reader.Type, reader.ID}]
			if !ok || queryHas(session.Query, readerKey, probeReader) {
				continue
			}
			entry := Reader{Type: reader.Type, ID: reader.ID, Protocol: protocolOf(reader.Type), Address: hostOf(session.RemoteAddr)}
			if queryHas(session.Query, readerKey, previewReader) {
				entry.Label = PreviewLabel
			}
			path.Readers = append(path.Readers, entry)
		}
		snapshot.Paths[item.Name] = path
	}
	return snapshot
}

func trackCodec(tracks []string) string {
	for _, track := range tracks {
		if codec, ok := videoCodecs[track]; ok {
			return codec
		}
	}
	return ""
}

func protocolOf(sourceType string) string {
	if kind, ok := kindOf(sourceType); ok {
		return kind.protocol
	}
	return sourceType
}

func hostOf(remoteAddr string) string {
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return host
	}
	return remoteAddr
}

// queryHas is true when the query gives key exactly one value, want. Matched exactly: neither
// the tag's public prefix nor a query that merely contains it passes for Insight's own.
func queryHas(query, key, want string) bool {
	values, err := url.ParseQuery(query)
	if err != nil {
		return false
	}
	got := values[key]
	return len(got) == 1 && got[0] == want
}
