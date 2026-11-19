package peripherals

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"insight/internal/apierr"
)

// The preview's pictures: at most this wide (never scaled up), at most this many a second, as
// JPEG of this quality.
const (
	previewWidth = 640
	previewFPS   = 15
	jpegQuality  = 70
)

// rawFormats are the V4L2 formats of a USB camera a preview converts, by the name GStreamer's
// video/x-raw gives each.
var rawFormats = map[string]string{
	"YUYV": "YUY2", "UYVY": "UYVY", "YVYU": "YVYU", "NV12": "NV12", "NV21": "NV21",
	"YU12": "I420", "YV12": "YV12", "GREY": "GRAY8", "RGB3": "RGB", "BGR3": "BGR",
}

// Mode is a camera mode to preview: a format and size the scan lists for it, at a frame rate it
// advertises for that size.
type Mode struct {
	Format string  `json:"format"`
	Width  int     `json:"width"`
	Height int     `json:"height"`
	FPS    float64 `json:"fps"`
}

// rate is a frame rate as an exact fraction, frames per second, as GStreamer's caps take it.
type rate struct{ num, den int64 }

func (r rate) fps() float64 { return float64(r.num) / float64(r.den) }
func (r rate) String() string {
	return strconv.FormatInt(r.num, 10) + "/" + strconv.FormatInt(r.den, 10)
}
func (r rate) atMost(fps int64) rate {
	if r.num > fps*r.den {
		return rate{fps, 1}
	}
	return r
}

// rateOf is fps as a fraction, to a thousandth.
func rateOf(fps float64) rate {
	if whole := math.Round(fps); math.Abs(fps-whole) < 1e-6 {
		return rate{int64(whole), 1}
	}
	r := rate{int64(math.Round(fps * 1000)), 1000}
	g := gcd(r.num, r.den)
	return rate{r.num / g, r.den / g}
}

func gcd(a, b int64) int64 {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

// previewSource is what the pipeline opens, checked against the scan: a MIPI camera's libcamera
// name, or a USB camera's stable by-id path (its /dev/videoN node without one).
type previewSource struct {
	connection string // mipi, usb
	source     string // quoted for GStreamer
	format     string
	width      int
	height     int
	rate       rate
}

func invalidMode(hint, format string, args ...any) error {
	return apierr.Errorf(http.StatusBadRequest, "invalid_request", hint, format, args...)
}

const modeHint = "Pick a format, size and frame rate the last scan lists for the camera."

// previewable checks mode against camera d in the scan and gives what the pipeline opens. A
// MIPI mode must be NV12 and not refused by Sentinel's verdict (one without a verdict may be
// tried: the preview is the check); a USB camera may preview any mode it lists in MJPG or a raw
// format GStreamer converts. Only sizes the camera lists one by one are previewed.
func previewable(d device, m Mode) (previewSource, error) {
	var connection string
	switch d.Backend {
	case "mipi":
		connection = "mipi"
	case "v4l2": // Sentinel's V4L2 provider reports USB cameras only
		connection = "usb"
	default:
		return previewSource{}, invalidMode("Pick a MIPI or USB camera.", "%s cannot be previewed: only MIPI and USB cameras can.", d.name())
	}
	if m.Format == "" || m.Width <= 0 || m.Height <= 0 || !(m.FPS > 0) || math.IsInf(m.FPS, 0) {
		return previewSource{}, invalidMode(modeHint, "A preview needs a format, a width and a height, and a frame rate above 0.")
	}
	label := fmt.Sprintf("%s %dx%d at %g fps", m.Format, m.Width, m.Height, m.FPS)
	var listed *mode
	for i := range d.Modes {
		if d.Modes[i].Format == m.Format && d.Modes[i].Width == m.Width && d.Modes[i].Height == m.Height {
			listed = &d.Modes[i]
			break
		}
	}
	if listed == nil {
		return previewSource{}, invalidMode(modeHint, "%s does not list %s %dx%d.", d.name(), m.Format, m.Width, m.Height)
	}
	switch {
	case connection == "mipi" && m.Format != "NV12":
		return previewSource{}, invalidMode("Pick an NV12 mode.", "%s cannot be previewed: a MIPI camera's preview takes NV12.", label)
	case connection == "mipi" && listed.Available != nil && !*listed.Available:
		reason := listed.Reason
		if reason == "" {
			reason = "Sentinel marks it unavailable."
		}
		return previewSource{}, invalidMode("Pick a mode marked available.", "%s cannot be previewed: %s", label, reason)
	case connection == "usb" && m.Format != "MJPG" && rawFormats[m.Format] == "":
		return previewSource{}, invalidMode("Pick an MJPG or raw mode.",
			"%s cannot be previewed: the preview decodes MJPG and converts YUYV, NV12 and the other raw formats only.", label)
	}
	r, ok := listedRate(d, connection, *listed, m.FPS)
	if !ok {
		return previewSource{}, invalidMode(modeHint, "%s is not a frame rate %s advertises for %dx%d.", strconv.FormatFloat(m.FPS, 'g', -1, 64), d.name(), m.Width, m.Height)
	}
	source := d.CameraName
	if connection == "usb" {
		source = d.ByIDPath
		if source == "" {
			source = d.DevicePath
		}
		if !strings.HasPrefix(source, "/dev/") {
			source = ""
		}
	}
	quoted, ok := gstQuoted(source)
	if !ok {
		return previewSource{}, apierr.Errorf(http.StatusUnprocessableEntity, "no_device",
			"Refresh; if this persists, the camera's details in the catalog say what the board reported.",
			"%s reports no device Insight can open for a preview.", d.name())
	}
	return previewSource{connection: connection, source: quoted, format: m.Format, width: m.Width, height: m.Height, rate: r}, nil
}

// listedRate is fps as one of the rates the camera advertises for the mode's size, exactly. A
// MIPI camera that advertises none takes any rate up to the one it reports running at, which
// libcamera then negotiates.
func listedRate(d device, connection string, m mode, fps float64) (rate, bool) {
	near := func(a, b float64) bool { return math.Abs(a-b) <= b*1e-3 }
	advertised := false
	for _, entry := range m.FrameIntervals {
		if entry.Width != m.Width || entry.Height != m.Height {
			continue
		}
		for _, i := range entry.Intervals {
			advertised = true
			switch i.Type {
			case "discrete":
				if i.Numerator > 0 && i.Denominator > 0 {
					// An interval is seconds per frame: the rate is its inverse.
					if r := (rate{i.Denominator, i.Numerator}); near(fps, r.fps()) {
						g := gcd(r.num, r.den)
						return rate{r.num / g, r.den / g}, true
					}
				}
			case "stepwise", "continuous":
				if i.Minimum == nil || i.Maximum == nil || i.Minimum.Numerator <= 0 || i.Maximum.Numerator <= 0 {
					continue
				}
				fastest := float64(i.Minimum.Denominator) / float64(i.Minimum.Numerator)
				slowest := float64(i.Maximum.Denominator) / float64(i.Maximum.Numerator)
				if fps >= slowest*(1-1e-3) && fps <= fastest*(1+1e-3) && onStep(i, fps) {
					return rateOf(fps), true
				}
			}
		}
	}
	if advertised || connection != "mipi" {
		return rate{}, false
	}
	if d.MaxFPS > 0 && fps > d.MaxFPS*(1+1e-3) {
		return rate{}, false
	}
	return rateOf(fps), true
}

// onStep says whether fps's period is the shortest one plus a whole number of steps, allowing
// for the driver's rounding; a continuous range takes any.
func onStep(i interval, fps float64) bool {
	if i.Type != "stepwise" || i.Step == nil || i.Step.Numerator <= 0 || i.Step.Denominator <= 0 {
		return true
	}
	first := float64(i.Minimum.Numerator) / float64(i.Minimum.Denominator)
	step := float64(i.Step.Numerator) / float64(i.Step.Denominator)
	period := 1 / fps
	k := math.Round((period - first) / step)
	return math.Abs(first+k*step-period) <= period*1e-3
}

// gstQuoted is a GStreamer property value in double quotes, so spaces, "!" and quotes stay part
// of it; false for "" or a value with control characters, which no quoting carries.
func gstQuoted(value string) (string, bool) {
	if value == "" || strings.ContainsFunc(value, unicode.IsControl) {
		return "", false
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`, true
}

// previewSize is the preview's size: at most previewWidth wide, never scaled up, the camera's
// aspect ratio, both even.
func previewSize(width, height int) (int, int) {
	w := max(2, min(previewWidth, width)/2*2)
	// The nearest even height, half rounded up.
	return w, max(2, 2*((w*height+width)/(2*width)))
}

// pipeline is the gst-launch-1.0 command that captures s and writes it to stdout as JPEG
// pictures in multipart parts.
func pipeline(s previewSource) []string {
	caps := fmt.Sprintf("width=%d,height=%d,framerate=%s", s.width, s.height, s.rate)
	var head []string
	switch {
	case s.connection == "mipi":
		head = []string{"libcamerasrc", "camera-name=" + s.source, "!", "video/x-raw,format=NV12," + caps}
	case s.format == "MJPG":
		head = []string{"v4l2src", "device=" + s.source, "!", "image/jpeg," + caps, "!", "jpegdec"}
	default:
		head = []string{"v4l2src", "device=" + s.source, "!", "video/x-raw,format=" + rawFormats[s.format] + "," + caps, "!", "videoconvert"}
	}
	w, h := previewSize(s.width, s.height)
	return append(append([]string{"gst-launch-1.0", "-q"}, head...),
		// Scale before videorate: the other way round a 66 fps IMX477 delivered 6.9 fps instead
		// of 13.9 on a Modalix DevKit, videorate pacing pictures ahead of the slower scaler.
		"!", "videoscale",
		"!", "videorate",
		"!", fmt.Sprintf("video/x-raw,width=%d,height=%d,framerate=%s", w, h, s.rate.atMost(previewFPS)),
		"!", "jpegenc", fmt.Sprintf("quality=%d", jpegQuality),
		"!", "multipartmux", "boundary=frame",
		"!", "fdsink", "fd=1",
	)
}
