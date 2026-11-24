package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/channels"
)

// ChannelSet is what the routes need of the channels.
type ChannelSet interface {
	States(now time.Time) []channels.State
	Offer(ctx context.Context, index int, offer channels.Description) (channels.Description, error)
}

const (
	// maxOfferBytes: an SDP offer is a few KiB.
	maxOfferBytes = 64 << 10
	// offerTimeout bounds the answer, which waits for Insight's ICE candidates.
	offerTimeout = 10 * time.Second
	activeTTL    = 3 * time.Second
)

func (h *handlers) ListChannels(w http.ResponseWriter, r *http.Request) {
	states := h.deps.Channels.States(h.deps.Now())
	list := api.ChannelList{Channels: make([]api.Channel, len(states))}
	for i, s := range states {
		list.Channels[i] = api.Channel{Channel: s.Channel, Video: api.ChannelVideo{Active: s.Video.Active}}
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *handlers) OfferChannel(w http.ResponseWriter, r *http.Request, channel int) {
	var offer api.SessionDescription
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxOfferBytes)).Decode(&offer); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			apierr.Write(w, http.StatusRequestEntityTooLarge, "offer_too_large", "The offer is larger than 64 KiB.", "")
			return
		}
		apierr.Write(w, http.StatusBadRequest, "invalid_offer", "The offer is not a JSON session description.", "")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), offerTimeout)
	defer cancel()
	answer, err := h.deps.Channels.Offer(ctx, channel, channels.Description{Type: offer.Type, SDP: offer.Sdp})
	if err != nil {
		refusal := channels.AsOfferError(err)
		apierr.Write(w, refusal.Status, refusal.Code, refusal.Message, "")
		return
	}
	writeJSON(w, http.StatusOK, api.SessionDescription{Type: answer.Type, Sdp: answer.SDP})
}

func (h *handlers) GetIngestStats(w http.ResponseWriter, r *http.Request, params api.GetIngestStatsParams) {
	now := h.deps.Now()
	all, verbose := truthy(params.All), truthy(params.Verbose)
	stats := api.IngestStats{Time: now.UTC().Format(time.RFC3339Nano), ActiveTtlMs: int(activeTTL.Milliseconds()),
		Channels: []api.IngestChannel{}}
	for _, s := range h.deps.Channels.States(now) {
		if !all && !s.Video.Active {
			continue
		}
		var c api.IngestChannel
		c.Channel, c.UdpPort, c.Active = s.Channel, s.VideoPort, s.Video.Active
		c.FirstPacketAt, c.LastPacketAt = optionalRFC3339(s.Video.First), optionalRFC3339(s.Video.Last)
		c.RemoteAddr = optional(s.Video.Remote)
		c.Rtp.Ssrc, c.Rtp.PayloadType = int(s.Video.SSRC), int(s.Video.PayloadType)
		c.Rtp.PacketsReceived, c.Rtp.BytesReceived = int(s.Video.Packets), int(s.Video.Bytes)
		c.Rtp.BitrateBps, c.Rtp.PacketRatePps = s.Video.BitsPerS, s.Video.PacketsPerSecond
		c.Media.Kind, c.Media.Codec, c.Media.ClockRate = "video", s.Video.Codec, 90000
		if c.Media.Codec == "" {
			c.Media.Codec = "unknown"
		}
		c.Media.SeenSps, c.Media.IdrCount = s.Video.SeenSPS, int(s.Video.Keyframes)
		m := &c.Metadata
		m.UdpPort, m.Active = s.MetadataPort, s.Metadata.Active
		m.FirstMessageAt, m.LastMessageAt = optionalRFC3339(s.Metadata.First), optionalRFC3339(s.Metadata.Last)
		m.RemoteAddr = optional(s.Metadata.Remote)
		m.MessagesReceived, m.BytesReceived = int(s.Metadata.Received), int(s.Metadata.Bytes)
		m.BitrateBps, m.MessageRateMps = s.Metadata.BitsPS, s.Metadata.MessagesPerSecond
		m.MessagesForwarded, m.InvalidJson = int(s.Metadata.Forwarded), int(s.Metadata.Invalid)
		c.Webrtc.PeerCount = s.Viewers
		if verbose {
			malformed, unsupported, errs := int(s.Video.Malformed), int(s.Video.Unsupported), nonNil(s.Errors)
			oversized := int(s.Video.Oversized)
			c.Diagnostics = &struct {
				MalformedPackets   *int      `json:"malformed_packets,omitempty"`
				OversizedFrames    *int      `json:"oversized_frames,omitempty"`
				RecentErrors       *[]string `json:"recent_errors,omitempty"`
				UnsupportedPackets *int      `json:"unsupported_packets,omitempty"`
			}{&malformed, &oversized, &errs, &unsupported}
		}
		stats.Channels = append(stats.Channels, c)
	}
	writeJSON(w, http.StatusOK, stats)
}

// GetViewerUrl builds the link as the old backend did, parameters in the same order: mode (when
// light or dark), src, max_channels.
func (h *handlers) GetViewerUrl(w http.ResponseWriter, r *http.Request, params api.GetViewerUrlParams) {
	channelsInfo := h.deps.Config.Channels
	count := channelsInfo.Count
	var selected []string
	if params.Src == nil {
		for i := range count {
			selected = append(selected, strconv.Itoa(i))
		}
	} else {
		seen := map[int]bool{}
		for _, item := range strings.Split(*params.Src, ",") {
			n, err := strconv.Atoi(strings.TrimSpace(item))
			if err != nil || n < 0 || n >= count || seen[n] {
				continue
			}
			seen[n] = true
			selected = append(selected, strconv.Itoa(n))
		}
	}
	var query []string
	if params.Mode != nil && (*params.Mode == "light" || *params.Mode == "dark") {
		query = append(query, "mode="+*params.Mode)
	}
	query = append(query, "src="+url.QueryEscape(strings.Join(selected, ",")), "max_channels="+strconv.Itoa(count))
	link := "/viewer?" + strings.Join(query, "&")
	if origin := h.deps.Config.Network.PublicOrigin; origin != "" {
		link = strings.TrimSuffix(origin, "/") + link
	} else {
		scheme := "https"
		if r.TLS == nil {
			scheme = "http"
		}
		link = scheme + "://" + r.Host + link
	}
	writeJSON(w, http.StatusOK, api.ViewerUrl{
		Url: link, MaxVideoChannels: count,
		ChannelLimitSource: api.ViewerUrlChannelLimitSource(channelsInfo.Source),
		SdkChannelLimited:  channelsInfo.Limited,
	})
}

// truthy reads a query flag as the old backend did: 1, true, yes or on, in any case.
func truthy(value *string) bool {
	if value == nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(*value)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func optionalRFC3339(t time.Time) *string {
	if t.IsZero() {
		return nil
	}
	text := t.UTC().Format(time.RFC3339Nano)
	return &text
}

func nonNil(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}
