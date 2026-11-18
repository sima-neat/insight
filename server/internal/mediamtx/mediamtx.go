// Package mediamtx runs MediaMTX, the RTSP and WebRTC server Insight bundles, and talks to its
// API. The slots publish into its src paths, browsers publish their webcams into its cam paths
// over WHIP, and the slots learn who publishes and who reads from a snapshot of its paths.
//
// The API listens on loopback only and takes a password that is new each run: without one,
// any local program, and through MediaMTX's CORS policy any web page open on the machine,
// could drive it, and with it run commands through a path's runOnInit.
package mediamtx

import (
	"crypto/rand"
	"encoding/hex"
)

const (
	// APIURL is MediaMTX's API as webrtc/mediamtx.yml binds it (apiAddress). Not MediaMTX's
	// default port 9997, which the Neat GenAI Studio's model server uses.
	APIURL = "http://127.0.0.1:9901"
	// APIUser is the API's user in webrtc/mediamtx.yml.
	APIUser = "insight"
	// RTSPURL is MediaMTX's RTSP listener as seen from Insight's own machine (rtspAddress),
	// for the publishers, probes and previews Insight runs. Browsers and apps elsewhere may
	// reach it on another port, which the SDK's port map names.
	RTSPURL = "rtsp://127.0.0.1:8554"

	// ProbeReaderQuery tags Insight's own short probes of a path; a snapshot leaves them out
	// of the path's readers.
	ProbeReaderQuery = readerKey + "=" + probeReader
	// PreviewReaderQuery tags Insight's live preview of a path; a snapshot lists it among the
	// readers with the label "insight preview".
	PreviewReaderQuery = readerKey + "=" + previewReader
	// PreviewLabel is the label a snapshot gives a reader tagged with PreviewReaderQuery.
	PreviewLabel = "insight preview"

	publisherKey  = "publisher"
	readerKey     = "reader"
	probeReader   = "insight-probe"
	previewReader = "insight-preview"
)

// Secrets are one run's API password and publisher tag. They are made at start and never
// written anywhere but MediaMTX's private runtime configuration.
type Secrets struct {
	// APIPassword is the API user's password: letters, digits, '-' and '_' only.
	APIPassword string
	// Publisher is the value of the publisher query parameter that marks a stream as one
	// Insight started: "insight-" and 16 hex digits. Only MediaMTX's API shows a publisher's
	// query, so another publisher cannot learn it and pass for Insight's own stream.
	Publisher string
}

// NewSecrets makes a run's secrets from the system's random source.
func NewSecrets() Secrets {
	tag := make([]byte, 8)
	_, _ = rand.Read(tag) // never fails: crypto/rand crashes the program instead
	return Secrets{APIPassword: rand.Text(), Publisher: "insight-" + hex.EncodeToString(tag)}
}

// PublisherQuery is the query a publisher Insight starts adds to its RTSP URL
// ("publisher=insight-…"), so a snapshot counts the stream as Insight's own.
func (s Secrets) PublisherQuery() string { return publisherKey + "=" + s.Publisher }
