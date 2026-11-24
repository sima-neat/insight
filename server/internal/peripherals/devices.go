package peripherals

import (
	"cmp"
	"math"
	"slices"
	"strconv"
	"strings"
)

// The scan's devices as the API answers them, built from Sentinel's catalog: its cameras with
// their formats, sizes and rates, each mode with Sentinel's verdict and whether Insight's preview
// takes it; its microphones with their capture formats; the devices of other kinds; the notes
// and errors of each, and the scan's issues. Sentinel decides whether a camera mode can be used
// (each mode's `available` and `reason`); Insight keeps that verdict as it is.

// Item is a device of a scan: a CameraItem, a MicrophoneItem or an OtherItem.
type Item interface{ item() }

func (CameraItem) item()     {}
func (MicrophoneItem) item() {}
func (OtherItem) item()      {}

// The kinds Insight has a view for; a device of another kind is an OtherItem.
const (
	kindCamera     = "camera"
	kindMicrophone = "microphone"
)

// Sentinel's verdict on a camera, format or mode: Available when Neat's CameraInput can use it.
const (
	tierAvailable   = "available"
	tierUnsupported = "unsupported"
)

// The rates offered for a size whose range of intervals names no rate of its own.
var standardFPS = []float64{60, 30, 25, 20, 15, 10, 5}

const (
	// mipiDefaultFPS is the rate offered for a MIPI mode that advertises none: CameraInput's
	// default, at most the rate the camera reports (max_fps), which the preview takes.
	mipiDefaultFPS = 30
	// defaultWidth is the width a default selection prefers.
	defaultWidth = 1920
)

// formatLabels name the V4L2 FourCCs as the kernel describes them.
var formatLabels = map[string]string{
	"NV12": "NV12 (YUV 4:2:0)",
	"YUYV": "YUYV (YUV 4:2:2)",
	"MJPG": "MJPG (Motion-JPEG)",
	"RGB3": "RGB3 (packed 24-bit)",
	"AR24": "AR24 (packed 32-bit)",
}

const (
	noModesReason   = "SiMa Sentinel reported no modes for this camera."
	noVerdictReason = "This board's SiMa Sentinel does not say whether this mode can be used; update Sentinel."
	refusedReason   = "SiMa Sentinel marks this mode unavailable."
	// A USB camera's modes follow Sentinel's verdict (MJPEG on the uvcvideo driver, which Neat's
	// USB camera input reads). A Sentinel that checks USB cameras names the camera's driver; an
	// older one's USB verdicts, if any, apply the MIPI overlay rule and say nothing about it.
	usbUpdateReason  = "Update SiMa Sentinel on the board to check USB cameras."
	usbUnknownReason = "SiMa Sentinel could not tell whether Neat's USB camera input opens this camera."
	usbRefusedReason = "SiMa Sentinel reports Neat's USB camera input cannot use this mode."
	noByIDNote       = "No /dev/v4l/by-id link was found; /dev/videoN numbering can change across reboots and replugs."
	noCaptureNote    = "Capture formats cannot be read without opening the device."
	// capabilitiesIssue is Sentinel's issue for a microphone without read-only formats, which
	// noCaptureNote says.
	capabilitiesIssue = "peripherals.capabilities_unavailable"
	statusHint        = "Check `systemctl status simaai-sentinel` and `journalctl -u simaai-sentinel` on the board, then Refresh."
)

// Support is Sentinel's verdict on a camera, a format or a mode, and why it is not Available.
type Support struct {
	Tier   string `json:"tier"`
	Reason string `json:"reason"`
}

// DeviceError is a problem with one device, such as a camera without modes (no_modes).
type DeviceError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint"`
}

// UsbFacts are a device's USB facts; one it does not report is left out.
type UsbFacts struct {
	VendorID     string  `json:"vendor_id,omitempty"`
	ProductID    string  `json:"product_id,omitempty"`
	Manufacturer string  `json:"manufacturer,omitempty"`
	Product      string  `json:"product,omitempty"`
	Serial       string  `json:"serial,omitempty"`
	BusPath      string  `json:"bus_path,omitempty"`
	Interface    string  `json:"interface,omitempty"`
	SpeedMbps    float64 `json:"speed_mbps,omitempty"`
}

// CameraDevice is how a camera's device is reached: a MIPI camera's libcamera facts, a USB
// camera's V4L2 nodes and USB facts.
type CameraDevice struct {
	CameraName  string    `json:"camera_name,omitempty"`
	MediaDevice string    `json:"media_device,omitempty"`
	BusInfo     string    `json:"bus_info,omitempty"`
	CSI         string    `json:"csi,omitempty"`
	VideoNode   string    `json:"video_node,omitempty"`
	ByID        string    `json:"by_id,omitempty"`
	USB         *UsbFacts `json:"usb,omitempty"`
}

// CameraMode is one rate of a format's size, with Sentinel's verdict on its mode and whether the
// preview takes it (previewMode).
type CameraMode struct {
	Value       float64 `json:"value"`
	Tier        string  `json:"tier"`
	Reason      string  `json:"reason,omitempty"`
	Previewable bool    `json:"previewable"`
}

// CameraSize is one size of a format, with its rates fastest first.
type CameraSize struct {
	Width  int          `json:"width"`
	Height int          `json:"height"`
	FPS    []CameraMode `json:"fps"`
}

// CameraFormat is one pixel format of a camera, with the sizes it offers.
type CameraFormat struct {
	Format  string       `json:"format"`
	Label   string       `json:"label"`
	Support Support      `json:"support"`
	Range   *sizeRange   `json:"range"`
	Sizes   []CameraSize `json:"sizes"`
}

// CameraItem is a camera of the scan.
type CameraItem struct {
	ID         string       `json:"id"`
	Kind       string       `json:"kind"`
	Connection string       `json:"connection"`
	Name       string       `json:"name"`
	Model      *string      `json:"model"`
	Device     CameraDevice `json:"device"`
	Support    Support      `json:"support"`
	// ModesSource is live (this scan's), previous-scan (a failed provider's last good scan) or
	// unavailable (no mode could be read).
	ModesSource      string         `json:"modes_source"`
	Formats          []CameraFormat `json:"formats"`
	DefaultSelection *Mode          `json:"default_selection"`
	Notes            []string       `json:"notes"`
	Errors           []DeviceError  `json:"errors"`
}

// MicrophoneDevice is a microphone's ALSA identity; a fact the card does not report is left out.
type MicrophoneDevice struct {
	CardIndex  *int       `json:"card_index,omitempty"`
	CardID     string     `json:"card_id,omitempty"`
	CardName   string     `json:"card_name,omitempty"`
	CardDriver string     `json:"card_driver,omitempty"`
	PCMDevice  *int       `json:"pcm_device,omitempty"`
	PCMNode    string     `json:"pcm_node,omitempty"`
	ALSAName   string     `json:"alsa_name,omitempty"`
	ByPath     string     `json:"by_path,omitempty"`
	ByID       string     `json:"by_id,omitempty"`
	USB        *UsbFacts  `json:"usb,omitempty"`
	PartOf     *DeviceRef `json:"part_of,omitempty"`
}

// RateRange is a continuous range of sample rates, in Hz.
type RateRange struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// MicrophoneCapture is one capture combination a microphone reports.
type MicrophoneCapture struct {
	Format     string     `json:"format,omitempty"`
	Channels   int        `json:"channels,omitempty"`
	Bits       int        `json:"bits,omitempty"`
	Rates      []int      `json:"rates"`
	RateRange  *RateRange `json:"rate_range,omitempty"`
	ChannelMap []string   `json:"channel_map,omitempty"`
}

// MicrophoneItem is a microphone of the scan.
type MicrophoneItem struct {
	ID         string           `json:"id"`
	Kind       string           `json:"kind"`
	Connection string           `json:"connection"` // usb, onboard
	Name       string           `json:"name"`
	Device     MicrophoneDevice `json:"device"`
	// Capture is nil when the formats cannot be read without opening the device.
	Capture []MicrophoneCapture `json:"capture"`
	// Record fingerprints what identifies the device behind the id.
	Record string        `json:"record"`
	Notes  []string      `json:"notes"`
	Errors []DeviceError `json:"errors"`
}

// OtherItem is a device of a kind Insight has no view for: listed with its name and notes.
type OtherItem struct {
	ID         string        `json:"id"`
	Kind       string        `json:"kind"`
	Connection string        `json:"connection"`
	Name       string        `json:"name"`
	Notes      []string      `json:"notes"`
	Errors     []DeviceError `json:"errors"`
}

// Issue is a problem with the scan as a whole, a warning: a provider that failed.
type Issue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint"`
}

// CameraSetup is the board's camera setup as Sentinel reads it from the device tree: its model
// and the overlays that configure a camera sensor.
type CameraSetup struct {
	Model    *string  `json:"model"`
	Overlays []string `json:"overlays"`
}

// items are the catalog's devices: its cameras, then its microphones, then the devices of other
// kinds, each in Sentinel's order.
func (c catalog) items() []Item {
	items := []Item{}
	for _, d := range c.Devices {
		if d.Type == kindCamera {
			items = append(items, cameraItem(d, c.stale(d)))
		}
	}
	for _, d := range c.Devices {
		if d.Type == kindMicrophone {
			items = append(items, c.microphoneItem(d))
		}
	}
	for _, d := range c.Devices {
		if d.Type != kindCamera && d.Type != kindMicrophone {
			items = append(items, OtherItem{ID: d.ID, Kind: d.Type, Connection: orUnknown(d.Backend), Name: d.name(),
				Notes: d.issueNotes(""), Errors: []DeviceError{}})
		}
	}
	return items
}

// cameraItem is camera d's item; stale when its provider failed in this scan.
func cameraItem(d device, stale bool) CameraItem {
	item := CameraItem{ID: d.ID, Kind: kindCamera, Connection: d.connection(), Name: d.name(),
		Support: verdictOf(d, d.Modes), ModesSource: "live", Formats: formatsOf(d), Notes: []string{}, Errors: []DeviceError{}}
	if d.Model != "" {
		item.Model = &d.Model
	}
	if item.Connection == "usb" {
		item.Device = CameraDevice{VideoNode: d.DevicePath, ByID: d.ByIDPath, USB: &UsbFacts{
			VendorID: d.Identity.VendorID, ProductID: d.Identity.ProductID, Manufacturer: d.Identity.Manufacturer,
			Serial: d.Identity.Serial, Product: d.Model, BusPath: d.Identity.Topology, SpeedMbps: float64(d.Identity.Speed),
		}}
		if d.ByIDPath == "" {
			item.Notes = append(item.Notes, noByIDNote)
		}
	} else {
		item.Device = CameraDevice{CameraName: d.CameraName, MediaDevice: d.MediaDevice, BusInfo: d.BusInfo, CSI: d.CSIReceiver}
	}
	switch {
	case len(d.Modes) == 0:
		message := noModesReason
		if d.ISP.State == "unavailable" {
			message = "The ISP output node could not be read, so this camera's modes are unknown: " + d.ISP.Reason
		}
		item.Errors = append(item.Errors, DeviceError{Code: "no_modes", Message: message, Hint: statusHint})
		item.ModesSource = "unavailable"
	case stale:
		item.Notes = append(item.Notes, staleNote("Modes", d.provider()))
		item.ModesSource = "previous-scan"
	}
	item.DefaultSelection = defaultSelection(item.Formats)
	return item
}

// verdict is mode m of camera d as Sentinel judged it: available, and why not. A USB camera's
// verdicts count only from a Sentinel that checks USB cameras (it names the driver); an older
// one's apply the MIPI overlay rule, so every USB mode asks for an update.
func (d device) verdict(m mode) Support {
	usb := d.connection() == "usb"
	refused, unknown := refusedReason, noVerdictReason
	if usb {
		if d.Identity.Driver == "" {
			return Support{Tier: tierUnsupported, Reason: usbUpdateReason}
		}
		refused, unknown = usbRefusedReason, usbUnknownReason
	}
	switch {
	case m.Available != nil && *m.Available:
		return Support{Tier: tierAvailable}
	case m.Reason != "":
		return Support{Tier: tierUnsupported, Reason: m.Reason}
	case m.Available != nil:
		return Support{Tier: tierUnsupported, Reason: refused}
	}
	return Support{Tier: tierUnsupported, Reason: unknown}
}

// verdictOf is a camera's or format's verdict: Available when any of its modes is; otherwise the
// reason Sentinel gave most often for the modes in the format Neat's input reads (NV12 for
// CameraInput, MJPG for a USB camera), else for all of them.
func verdictOf(d device, modes []mode) Support {
	wanted := mipiFormat
	if d.connection() == "usb" {
		wanted = "MJPG"
	}
	if len(modes) == 0 {
		return Support{Tier: tierUnsupported, Reason: noModesReason}
	}
	var preferred, all []string
	for _, m := range modes {
		v := d.verdict(m)
		if v.Tier == tierAvailable {
			return v
		}
		all = append(all, v.Reason)
		if m.Format == wanted {
			preferred = append(preferred, v.Reason)
		}
	}
	if len(preferred) > 0 {
		all = preferred
	}
	return Support{Tier: tierUnsupported, Reason: mostCommon(all)}
}

// mostCommon is the value given most often, the one given first of equals.
func mostCommon(values []string) string {
	counts := map[string]int{}
	for _, v := range values {
		counts[v]++
	}
	top := ""
	for _, v := range values {
		if counts[v] > counts[top] {
			top = v
		}
	}
	return top
}

// formatsOf are camera d's formats in Sentinel's order, each with its sizes in Sentinel's order.
func formatsOf(d device) []CameraFormat {
	var order []string
	byFormat := map[string][]mode{}
	for _, m := range d.Modes {
		if _, seen := byFormat[m.Format]; !seen {
			order = append(order, m.Format)
		}
		byFormat[m.Format] = append(byFormat[m.Format], m)
	}
	formats := []CameraFormat{}
	for _, name := range order {
		modes := byFormat[name]
		format := CameraFormat{Format: name, Label: formatLabel(d, modes), Support: verdictOf(d, modes), Sizes: []CameraSize{}}
		type size struct{ width, height int }
		var sizes []size
		bySize := map[size][]mode{}
		for _, m := range modes {
			if format.Range == nil {
				format.Range = m.SizeRange
			}
			if m.Width <= 0 || m.Height <= 0 {
				continue
			}
			s := size{m.Width, m.Height}
			if _, seen := bySize[s]; !seen {
				sizes = append(sizes, s)
			}
			bySize[s] = append(bySize[s], m)
		}
		for _, s := range sizes {
			format.Sizes = append(format.Sizes, CameraSize{Width: s.width, Height: s.height, FPS: ratesOf(d, bySize[s])})
		}
		formats = append(formats, format)
	}
	return formats
}

// formatLabel names a format: a USB driver names its own formats; others by the kernel's names.
func formatLabel(d device, modes []mode) string {
	format := modes[0].Format
	if d.connection() == "usb" {
		for _, m := range modes {
			if m.FormatDescription != "" {
				return format + " (" + m.FormatDescription + ")"
			}
		}
	}
	if label, ok := formatLabels[format]; ok {
		return label
	}
	return format
}

// ratesOf are the rates of one format and size, fastest first, each with its mode's verdict and
// whether the preview takes it: the rates the camera advertises for the size; for a MIPI mode
// that advertises none, CameraInput's default rate up to the camera's own. A USB mode without an
// advertised rate offers none.
func ratesOf(d device, modes []mode) []CameraMode {
	var rates []CameraMode
	for _, m := range modes {
		values := offeredRates(m)
		if len(values) == 0 && d.connection() == "mipi" {
			fps := float64(mipiDefaultFPS)
			if d.MaxFPS > 0 {
				fps = fpsValue(min(fps, d.MaxFPS))
			}
			values = []float64{fps}
		}
		verdict := d.verdict(m)
		for _, value := range values {
			_, refused := previewMode(d, Mode{Format: m.Format, Width: m.Width, Height: m.Height, FPS: value})
			offered := CameraMode{Value: value, Tier: verdict.Tier, Reason: verdict.Reason, Previewable: refused == nil}
			// Of two modes with one rate, an Available one stands.
			i := slices.IndexFunc(rates, func(r CameraMode) bool { return r.Value == value })
			switch {
			case i < 0:
				rates = append(rates, offered)
			case verdict.Tier == tierAvailable:
				rates[i] = offered
			}
		}
	}
	slices.SortFunc(rates, func(a, b CameraMode) int { return cmp.Compare(b.Value, a.Value) })
	if rates == nil {
		return []CameraMode{}
	}
	return rates
}

// offeredRates are the rates a mode advertises for its size: each discrete interval's, and of a
// range the standard rates it holds, else its fastest, which every range holds.
func offeredRates(m mode) []float64 {
	var rates []float64
	for _, i := range m.intervals() {
		switch i.Type {
		case "discrete":
			if r, ok := i.rate(); ok {
				rates = append(rates, fpsValue(r.fps()))
			}
		case "stepwise", "continuous":
			_, fastest, ok := i.bounds()
			if !ok {
				continue
			}
			var held []float64
			for _, fps := range standardFPS {
				if i.takes(fps) {
					held = append(held, fps)
				}
			}
			if len(held) == 0 {
				held = []float64{fpsValue(fastest)}
			}
			rates = append(rates, held...)
		}
	}
	return rates
}

// fpsValue is a rate as requests and menus name it: whole when it is, else to a thousandth (the
// preview reads a rate to a thousandth). A rate too slow for that keeps six significant digits,
// never 0.
func fpsValue(fps float64) float64 {
	if whole := math.Round(fps); math.Abs(fps-whole) < 1e-9 {
		return whole
	}
	if rounded := math.Round(fps*1000) / 1000; rounded > 0 {
		return rounded
	}
	value, _ := strconv.ParseFloat(strconv.FormatFloat(fps, 'g', 6, 64), 64)
	return value
}

// defaultSelection is the mode to preselect: 1920 wide when a size that wide is Available, else
// the widest Available size narrower than that, else the smallest Available one, at its fastest
// Available rate; nil when no mode is Available.
func defaultSelection(formats []CameraFormat) *Mode {
	var candidates []Mode
	for _, f := range formats {
		for _, s := range f.Sizes {
			if i := slices.IndexFunc(s.FPS, func(r CameraMode) bool { return r.Tier == tierAvailable }); i >= 0 {
				candidates = append(candidates, Mode{Format: f.Format, Width: s.Width, Height: s.Height, FPS: s.FPS[i].Value})
			}
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	bySize := func(a, b Mode) int {
		if a.Width != b.Width {
			return a.Width - b.Width
		}
		return a.Height - b.Height
	}
	narrow := slices.DeleteFunc(slices.Clone(candidates), func(m Mode) bool { return m.Width > defaultWidth })
	var chosen Mode
	if len(narrow) > 0 {
		// The first of the widest.
		chosen = slices.MaxFunc(narrow, bySize)
	} else {
		chosen = slices.MinFunc(candidates, bySize)
	}
	return &chosen
}

// microphoneItem is microphone d's item. A USB microphone that belongs to a USB camera of the
// same scan (a webcam's) names it in part_of.
func (c catalog) microphoneItem(d device) MicrophoneItem {
	id, target := d.Identity, d.CaptureTarget
	facts := MicrophoneDevice{CardIndex: id.CardIndex, CardID: id.CardID, CardName: id.CardName, CardDriver: id.CardDriver,
		PCMDevice: target.Device, PCMNode: id.PCMNode, ByPath: id.ByPath, ByID: id.ByID}
	if facts.CardID == "" {
		facts.CardID = target.CardID
	}
	if facts.CardID != "" && target.Device != nil {
		facts.ALSAName = "hw:CARD=" + facts.CardID + ",DEV=" + strconv.Itoa(*target.Device)
	}
	if usb := id.USB; usb != nil {
		facts.USB = &UsbFacts{VendorID: usb.VendorID, ProductID: usb.ProductID, Manufacturer: usb.Manufacturer,
			Product: usb.Product, Serial: usb.Serial, BusPath: usb.BusPath, Interface: usb.Interface}
		if camera, ok := c.usbCameraAt(usb.BusPath); ok {
			facts.PartOf = &DeviceRef{ID: camera.ID, Name: camera.name()}
		}
	}
	item := MicrophoneItem{ID: d.ID, Kind: kindMicrophone, Connection: "onboard", Name: d.name(), Device: facts,
		Record: d.record, Notes: []string{}, Errors: []DeviceError{}}
	if d.Connection == "usb" {
		item.Connection = "usb"
	}
	if len(d.Modes) == 0 {
		item.Notes = append(item.Notes, noCaptureNote)
	}
	for _, m := range d.Modes {
		capture := MicrophoneCapture{Format: m.Format, Channels: m.Channels, Bits: m.SampleBits, Rates: m.RatesHz, ChannelMap: m.ChannelMap}
		if capture.Rates == nil {
			capture.Rates = []int{}
		}
		if r := m.RateRangeHz; r != nil {
			capture.RateRange = &RateRange{Min: r.Min, Max: r.Max}
		}
		item.Capture = append(item.Capture, capture)
	}
	item.Notes = append(item.Notes, d.issueNotes(capabilitiesIssue)...)
	if c.stale(d) {
		item.Notes = append(item.Notes, staleNote("Details", d.provider()))
	}
	return item
}

// usbCameraAt is the USB camera at a microphone's place on the bus. A camera's place is its USB
// device's sysfs path, whose last part is the name ALSA gives the device.
func (c catalog) usbCameraAt(busPath string) (device, bool) {
	if busPath == "" {
		return device{}, false
	}
	for _, d := range c.Devices {
		topology := d.Identity.Topology
		if d.Type == kindCamera && d.connection() == "usb" && topology[strings.LastIndex(topology, "/")+1:] == busPath {
			return d, true
		}
	}
	return device{}, false
}

// issueNotes are what Sentinel says about d (its issues) but the issue except, as notes.
func (d device) issueNotes(except string) []string {
	notes := []string{}
	for _, issue := range d.Issues {
		if issue.Code != except && issue.Reason != "" {
			notes = append(notes, issue.Reason)
		}
	}
	return notes
}

func staleNote(what, provider string) string {
	return what + " are from SiMa Sentinel's last successful scan; its " + provider + " provider failed during this refresh."
}

func orUnknown(backend string) string {
	if backend == "" {
		return "unknown"
	}
	return backend
}

// issues are Sentinel's failed providers as the scan's warnings.
func (c catalog) issues() []Issue {
	listed := map[string]bool{}
	for _, d := range c.Devices {
		listed[d.provider()] = true
	}
	issues := []Issue{}
	for _, e := range c.Errors {
		// Sentinel names a board-block error's provider after the field it could not read.
		var message string
		switch board := e.Provider == "board" || strings.HasPrefix(e.Provider, "board."); {
		case board && e.Code == "platform.unsupported":
			message = "SiMa Sentinel: " + e.Reason
		case board:
			message = "SiMa Sentinel could not read part of the board's camera setup: " + e.Reason
		default:
			message = "SiMa Sentinel's " + e.Provider + " provider failed: " + e.Reason
		}
		if listed[e.Provider] {
			message += " The devices it found last time are still listed."
		}
		issues = append(issues, Issue{Code: e.Code, Message: message, Hint: statusHint})
	}
	return issues
}

// cameraSetup is the board's camera setup; nil when Sentinel sends none. Sentinel lists every
// overlay the boot loader applies (PCIe, secure boot, ...); those that configure a camera sensor
// are the ones shown.
func (c catalog) cameraSetup() *CameraSetup {
	if c.Board == nil {
		return nil
	}
	sensors := map[string]bool{}
	for _, s := range c.Board.SupportedSensors {
		for _, overlay := range s.Overlays {
			sensors[overlay] = true
		}
	}
	setup := &CameraSetup{Overlays: []string{}}
	if c.Board.Model != "" {
		setup.Model = &c.Board.Model
	}
	for _, overlay := range c.Board.Overlays {
		if sensors[overlay] {
			setup.Overlays = append(setup.Overlays, overlay)
		}
	}
	return setup
}
