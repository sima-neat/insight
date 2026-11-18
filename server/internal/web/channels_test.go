package web

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"insight/internal/channels"
	"insight/internal/config"
)

type fakeChannels struct {
	states []channels.State
	answer channels.Description
	err    error
	got    channels.Description
	index  int
}

func (f *fakeChannels) Count() int                        { return len(f.states) }
func (f *fakeChannels) States(time.Time) []channels.State { return f.states }
func (f *fakeChannels) Offer(_ context.Context, index int, offer channels.Description) (channels.Description, error) {
	f.index, f.got = index, offer
	return f.answer, f.err
}

func handlerWith(set ChannelSet, cfg config.Config) http.Handler {
	return NewHandler(Deps{Config: cfg, Channels: set, UI: marker("ui"), Now: fixed})
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct{ Error struct{ Code string } }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("%v: %s", err, w.Body.String())
	}
	return body.Error.Code
}

func post(h http.Handler, target, contentType, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	r.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestOffer(t *testing.T) {
	set := &fakeChannels{states: make([]channels.State, 4), answer: channels.Description{Type: "answer", SDP: "v=0 answer"}}
	h := handlerWith(set, config.Config{})

	w := post(h, "/api/channels/2/offer", "application/json; charset=utf-8", `{"type":"offer","sdp":"v=0 offer"}`)
	if w.Code != http.StatusOK || set.index != 2 || set.got.SDP != "v=0 offer" {
		t.Fatalf("%d %s, offered %d %+v", w.Code, w.Body.String(), set.index, set.got)
	}
	var answer struct{ Type, Sdp string }
	json.Unmarshal(w.Body.Bytes(), &answer)
	if answer.Type != "answer" || answer.Sdp != "v=0 answer" {
		t.Fatalf("%s", w.Body.String())
	}

	cases := []struct {
		name, target, contentType, body string
		status                          int
		code                            string
	}{
		{"a form post", "/api/channels/0/offer", "application/x-www-form-urlencoded", `{"type":"offer","sdp":"x"}`, 415, "json_only"},
		{"text", "/api/channels/0/offer", "text/plain", `{"type":"offer","sdp":"x"}`, 415, "json_only"},
		{"too large", "/api/channels/0/offer", "application/json", `{"type":"offer","sdp":"` + strings.Repeat("x", 70<<10) + `"}`, 413, "offer_too_large"},
		{"not JSON", "/api/channels/0/offer", "application/json", `v=0`, 400, "invalid_offer"},
		{"no number", "/api/channels/x/offer", "application/json", `{}`, 400, "invalid_request"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := post(h, c.target, c.contentType, c.body)
			if w.Code != c.status || errorCode(t, w) != c.code {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
		})
	}

	set.err = &channels.OfferError{Status: 503, Code: "no_video", Message: "No video yet."}
	if w := post(h, "/api/channels/0/offer", "application/json", `{"type":"offer","sdp":"x"}`); w.Code != 503 || errorCode(t, w) != "no_video" {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestIngestStatsKeepsTheFieldsTheSDKReads(t *testing.T) {
	active := channels.State{Channel: 0, VideoPort: 9000, MetadataPort: 9100, Viewers: 1,
		Video:    channels.VideoState{Active: true, Packets: 10, BitsPerS: 8000, Codec: "H264", SeenSPS: true, Keyframes: 2, Last: time.Unix(1, 0)},
		Metadata: channels.MetadataState{Active: true, Received: 5}}
	idle := channels.State{Channel: 1, VideoPort: 9001, MetadataPort: 9101}
	h := handlerWith(&fakeChannels{states: []channels.State{active, idle}}, config.Config{})

	read := func(target string) []map[string]any {
		t.Helper()
		w := serve(t, h, http.MethodGet, target)
		var body struct{ Channels []map[string]any }
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Channels
	}
	if got := read("/api/ingest/stats"); len(got) != 1 {
		t.Fatalf("without all: %d channels", len(got))
	}
	got := read("/api/ingest/stats?all=1&verbose=1")
	if len(got) != 2 {
		t.Fatalf("with all: %d channels", len(got))
	}
	first := got[0]
	path := func(keys ...string) any {
		var v any = first
		for _, k := range keys {
			v = v.(map[string]any)[k]
		}
		return v
	}
	for _, check := range []struct {
		keys []string
		want any
	}{
		{[]string{"channel"}, 0.0}, {[]string{"active"}, true}, {[]string{"udp_port"}, 9000.0},
		{[]string{"rtp", "packets_received"}, 10.0}, {[]string{"rtp", "bitrate_bps"}, 8000.0},
		{[]string{"media", "idr_count"}, 2.0}, {[]string{"media", "seen_sps"}, true}, {[]string{"media", "codec"}, "H264"},
		{[]string{"metadata", "active"}, true}, {[]string{"metadata", "messages_received"}, 5.0},
		{[]string{"webrtc", "peer_count"}, 1.0},
	} {
		if got := path(check.keys...); got != check.want {
			t.Errorf("%v = %v, want %v", check.keys, got, check.want)
		}
	}
	if _, ok := first["diagnostics"]; !ok {
		t.Error("verbose has no diagnostics")
	}
	if got[1]["media"].(map[string]any)["codec"] != "unknown" {
		t.Errorf("an idle channel's codec: %v", got[1]["media"])
	}
}

func TestChannelList(t *testing.T) {
	h := handlerWith(&fakeChannels{states: []channels.State{{Channel: 0, VideoPort: 9000, MetadataPort: 9100,
		Video: channels.VideoState{Active: true, Codec: "H265"}, Metadata: channels.MetadataState{Matched: 3, Unmatched: 1}}}}, config.Config{})
	w := serve(t, h, http.MethodGet, "/api/channels")
	var list struct {
		Count    int
		Channels []struct {
			Channel int
			Video   struct {
				Active bool
				Codec  string
			}
			Metadata struct{ Matched, Unmatched int }
			Errors   []string
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	c := list.Channels[0]
	if list.Count != 1 || !c.Video.Active || c.Video.Codec != "H265" || c.Metadata.Matched != 3 || c.Metadata.Unmatched != 1 || c.Errors == nil {
		t.Fatalf("%s", w.Body.String())
	}
}

func viewerURL(t *testing.T, cfg config.Config, target string, tlsOn bool, host string) (string, map[string]any) {
	t.Helper()
	h := handlerWith(&fakeChannels{}, cfg)
	r := httptest.NewRequest(http.MethodGet, target, nil)
	r.Host = host
	if tlsOn {
		r.TLS = &tls.ConnectionState{}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("%v %s", err, w.Body.String())
	}
	return body["url"].(string), body
}

// Carried over from the old backend's tests (tests/test_viewer_url.py and test_runtime_urls.py).
func TestViewerURL(t *testing.T) {
	sdk4 := config.Config{Channels: config.Channels{Count: 4, Source: "sdk-port-map", Limited: true}}
	all := config.Config{Channels: config.Channels{Count: 80, Source: "legacy-default"}}

	link, _ := viewerURL(t, all, "/api/viewer-url?mode=dark&src=0,1", true, "192.168.1.25:19900")
	if link != "https://192.168.1.25:19900/viewer?mode=dark&src=0%2C1&max_channels=80" {
		t.Fatalf("%s", link)
	}
	for _, mode := range []string{"", "solarized", "DARK", "dark%20", "dark,light"} {
		link, _ := viewerURL(t, all, "/api/viewer-url?mode="+mode+"&src=1", true, "developer.local:9900")
		if link != "https://developer.local:9900/viewer?src=1&max_channels=80" {
			t.Errorf("mode %q: %s", mode, link)
		}
	}
	link, body := viewerURL(t, sdk4, "/api/viewer-url", true, "developer.local:9900")
	if link != "https://developer.local:9900/viewer?src=0%2C1%2C2%2C3&max_channels=4" ||
		body["max_video_channels"] != 4.0 || body["channel_limit_source"] != "sdk-port-map" || body["sdk_channel_limited"] != true {
		t.Fatalf("%s %v", link, body)
	}
	if link, _ := viewerURL(t, sdk4, "/api/viewer-url?src=0,3,4,79,bad,3", true, "h:1"); !strings.Contains(link, "src=0%2C3&") {
		t.Errorf("filtered: %s", link)
	}
	if link, _ := viewerURL(t, sdk4, "/api/viewer-url?src=79,bad", true, "h:1"); !strings.Contains(link, "src=&") {
		t.Errorf("none valid: %s", link)
	}
	if link, _ := viewerURL(t, all, "/api/viewer-url", true, "[fd00::23]:19900"); !strings.HasPrefix(link, "https://[fd00::23]:19900/viewer?") {
		t.Errorf("IPv6: %s", link)
	}
	if link, _ := viewerURL(t, all, "/api/viewer-url", false, "10.0.0.22"); !strings.HasPrefix(link, "http://10.0.0.22/viewer?") {
		t.Errorf("plain HTTP: %s", link)
	}
	hosted := sdk4
	hosted.Network.PublicOrigin = "https://insight.example.com/"
	link, _ = viewerURL(t, hosted, "/api/viewer-url?mode=dark&src=0,1", true, "10.77.0.1:9900")
	parsed, _ := url.Parse(link)
	if parsed.Scheme+"://"+parsed.Host != "https://insight.example.com" || parsed.Path != "/viewer" ||
		parsed.Query().Get("max_channels") != "4" || parsed.Query().Get("src") != "0,1" {
		t.Fatalf("hosted: %s", link)
	}
}
