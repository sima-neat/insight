package peripherals

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"insight/internal/apierr"
	"insight/internal/sentinel"
)

// catalog is what Insight reads of Sentinel's peripheral catalog (/v1/peripherals): the devices
// with their modes and Sentinel's verdicts, the providers that failed, and the board's camera
// setup. A field Sentinel leaves out reads as unknown; one Insight does not name is ignored.
type catalog struct {
	Devices []device        `json:"devices"`
	Errors  []providerError `json:"errors"`
	Board   *boardBlock     `json:"board"`
}

// providerError is a provider that failed in the scan: its devices are its last successful
// scan's. A provider is named <type>.<backend>, or after the board field it could not read.
type providerError struct {
	Provider string `json:"provider"`
	Code     string `json:"code"`
	Reason   string `json:"reason"`
}

// boardBlock is the board's camera setup as Sentinel reads it from the device tree: every
// overlay the boot loader applies, and the overlays of each sensor it supports.
type boardBlock struct {
	Model            string   `json:"model"`
	Overlays         []string `json:"overlays"`
	SupportedSensors []struct {
		Overlays []string `json:"overlays"`
	} `json:"supported_sensors"`
}

// device is a camera, a microphone or a device of another kind.
type device struct {
	ID      string `json:"id"`
	Type    string `json:"type"` // camera, microphone, or a kind Insight has no view for
	Backend string `json:"backend"`
	Name    string `json:"name"`
	Model   string `json:"model"`
	// A MIPI camera's: its libcamera name and media nodes, its ISP, and the rate it runs at now.
	CameraName  string  `json:"camera_name"`
	MediaDevice string  `json:"media_device"`
	BusInfo     string  `json:"bus_info"`
	CSIReceiver string  `json:"csi_receiver"`
	MaxFPS      float64 `json:"max_fps"`
	ISP         struct {
		State  string `json:"state"`
		Reason string `json:"reason"`
	} `json:"isp"`
	// A USB camera's nodes.
	DevicePath string `json:"device_path"`
	ByIDPath   string `json:"by_id_path"`
	// A microphone's: how it is attached, and the ALSA device Sentinel says to record from.
	Connection    string        `json:"connection"`
	CaptureTarget captureTarget `json:"capture_target"`
	// A USB camera's or a microphone's.
	Identity identity `json:"identity"`
	Issues   []struct {
		Code   string `json:"code"`
		Reason string `json:"reason"`
	} `json:"issues"`
	Modes []mode `json:"modes"`

	// record is a fingerprint of the capture target and the identity as Sentinel wrote them.
	record string
}

type captureTarget struct {
	CardID   string `json:"card_id"`
	Device   *int   `json:"device"`
	Selector string `json:"selector"`
}

// identity is a USB camera's USB facts, or a microphone's ALSA card with its USB facts.
type identity struct {
	// A USB camera's.
	VendorID     string    `json:"vendor_id"`
	ProductID    string    `json:"product_id"`
	Manufacturer string    `json:"manufacturer"`
	Serial       string    `json:"serial"`
	Topology     string    `json:"topology"`
	Speed        linkSpeed `json:"speed"`
	// A microphone's.
	CardIndex  *int   `json:"card_index"`
	CardID     string `json:"card_id"`
	CardName   string `json:"card_name"`
	CardDriver string `json:"card_driver"`
	PCMNode    string `json:"pcm_node"`
	ByPath     string `json:"by_path"`
	ByID       string `json:"by_id"`
	USB        *struct {
		VendorID     string `json:"vendor_id"`
		ProductID    string `json:"product_id"`
		Manufacturer string `json:"manufacturer"`
		Product      string `json:"product"`
		Serial       string `json:"serial"`
		BusPath      string `json:"bus_path"`
		Interface    string `json:"interface"`
	} `json:"usb"`
}

// linkSpeed is the USB link speed sysfs reports in Mb/s ("1.5", "480", "5000"), which Sentinel
// passes on as text or as a number; 0 when unreadable.
type linkSpeed float64

func (s *linkSpeed) UnmarshalJSON(data []byte) error {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	var speed float64
	switch v := value.(type) {
	case float64:
		speed = v
	case string:
		speed, _ = strconv.ParseFloat(v, 64)
	}
	if speed > 0 {
		*s = linkSpeed(speed)
	}
	return nil
}

// mode is one of a device's modes: a camera's format and size with Sentinel's verdict and frame
// intervals, or a microphone's format with its channels and rates.
type mode struct {
	Format string `json:"format"`
	// A camera's.
	FormatDescription string           `json:"format_description"`
	Width             int              `json:"width"`
	Height            int              `json:"height"`
	Available         *bool            `json:"available"`
	Reason            string           `json:"reason"`
	FrameIntervals    []frameIntervals `json:"frame_intervals"`
	SizeRange         *sizeRange       `json:"size_range"`
	// A microphone's.
	Channels    int      `json:"channels"`
	SampleBits  int      `json:"sample_bits"`
	RatesHz     []int    `json:"rates_hz"`
	ChannelMap  []string `json:"channel_map"`
	RateRangeHz *struct {
		Min int `json:"min"`
		Max int `json:"max"`
	} `json:"rate_range_hz"`
}

// sizeRange is the bounds of a camera format's stepwise or continuous sizes.
type sizeRange struct {
	MinWidth   int `json:"min_width"`
	MinHeight  int `json:"min_height"`
	MaxWidth   int `json:"max_width"`
	MaxHeight  int `json:"max_height"`
	StepWidth  int `json:"step_width"`
	StepHeight int `json:"step_height"`
}

// frameIntervals are the frame intervals a camera advertises for one size, as V4L2 reports
// them: periods in seconds, a list of discrete ones or a range.
type frameIntervals struct {
	Width     int        `json:"width"`
	Height    int        `json:"height"`
	Intervals []interval `json:"intervals"`
}

type interval struct {
	Type string `json:"type"` // discrete, stepwise, continuous
	fraction
	Minimum *fraction `json:"minimum"`
	Maximum *fraction `json:"maximum"`
	Step    *fraction `json:"step"`
}

type fraction struct {
	Numerator   int64 `json:"numerator"`
	Denominator int64 `json:"denominator"`
}

// parseCatalog reads Sentinel's catalog; one Insight cannot read, or that names a device
// twice, is a Sentinel failure.
func parseCatalog(body sentinel.Body) (catalog, error) {
	raw, err := json.Marshal(body)
	var parsed catalog
	// What identifies a device as Sentinel wrote it, fields Insight does not read included.
	var identities struct {
		Devices []struct {
			CaptureTarget json.RawMessage `json:"capture_target"`
			Identity      json.RawMessage `json:"identity"`
		} `json:"devices"`
	}
	if err == nil {
		err = json.Unmarshal(raw, &parsed)
	}
	if err == nil {
		err = json.Unmarshal(raw, &identities)
	}
	if err != nil {
		return catalog{}, malformed("%v", err)
	}
	seen := map[string]bool{}
	for i := range parsed.Devices {
		d := &parsed.Devices[i]
		if d.ID == "" || d.Type == "" {
			return catalog{}, malformed("a device without an id or a type")
		}
		if seen[d.ID] {
			return catalog{}, malformed("the device %s twice", d.ID)
		}
		seen[d.ID] = true
		ids := identities.Devices[i]
		sum := sha256.Sum256([]byte("[" + orNull(ids.CaptureTarget) + "," + orNull(ids.Identity) + "]"))
		d.record = hex.EncodeToString(sum[:8])
	}
	return parsed, nil
}

func orNull(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "null"
	}
	return string(raw)
}

func malformed(format string, args ...any) error {
	return &apierr.Error{Status: http.StatusBadGateway, Code: sentinel.CodeFailed,
		Message: "Sentinel's peripheral catalog is not one Insight reads: " + fmt.Sprintf(format, args...) + ".",
		Hint:    "Update Sentinel on the board with `sima-cli neat install sentinel`."}
}

// device is the catalog's device id, or false.
func (c catalog) device(id string) (device, bool) {
	for _, d := range c.Devices {
		if d.ID == id {
			return d, true
		}
	}
	return device{}, false
}

// stale says whether d is kept from its provider's last successful scan: a provider that
// failed in this one leaves its devices as they were, whose nodes may now be another's.
func (c catalog) stale(d device) bool {
	for _, e := range c.Errors {
		if e.Provider == d.provider() {
			return true
		}
	}
	return false
}

// provider is the Sentinel provider that reports d: Sentinel names its providers
// <type>.<backend>.
func (d device) provider() string {
	return d.Type + "." + d.Backend
}

// connection is how a camera is attached: mipi, usb (Sentinel's V4L2 provider reports USB
// cameras only), else its backend's name.
func (d device) connection() string {
	switch d.Backend {
	case "mipi":
		return "mipi"
	case "v4l2":
		return "usb"
	case "":
		return "unknown"
	}
	return d.Backend
}

// name is a device's name for people: a microphone's USB product or its ALSA name, a USB
// camera's model or node, a MIPI camera's libcamera name, another kind's name or model; else its
// id.
func (d device) name() string {
	var names []string
	switch {
	case d.Type == "microphone":
		if d.Identity.USB != nil {
			names = append(names, d.Identity.USB.Product)
		}
		names = append(names, d.Name)
	case d.Type == "camera" && d.connection() == "usb":
		names = []string{d.Model, d.DevicePath}
	case d.Type == "camera":
		names = []string{d.CameraName}
	default:
		names = []string{d.Name, d.Model}
	}
	for _, name := range names {
		if name != "" {
			return name
		}
	}
	return d.ID
}

// DeviceRef names a device in a scan's changes.
type DeviceRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Changes are the devices a scan found that the one before it did not, and those it no longer
// found.
type Changes struct {
	Added   []DeviceRef `json:"added"`
	Removed []DeviceRef `json:"removed"`
}

func changes(before, after catalog) *Changes {
	c := &Changes{Added: []DeviceRef{}, Removed: []DeviceRef{}}
	for _, d := range after.Devices {
		if _, had := before.device(d.ID); !had {
			c.Added = append(c.Added, DeviceRef{d.ID, d.name()})
		}
	}
	for _, d := range before.Devices {
		if _, has := after.device(d.ID); !has {
			c.Removed = append(c.Removed, DeviceRef{d.ID, d.name()})
		}
	}
	return c
}
