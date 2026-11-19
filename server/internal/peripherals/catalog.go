package peripherals

import (
	"encoding/json"
	"fmt"
	"net/http"

	"insight/internal/apierr"
	"insight/internal/sentinel"
)

// catalog is what Insight reads of Sentinel's peripheral catalog (/v1/peripherals) for its own
// work: the devices a preview or a microphone test opens, and the providers that failed. The
// answer passes the catalog on as Sentinel wrote it.
type catalog struct {
	Devices []device `json:"devices"`
	Errors  []struct {
		Provider string `json:"provider"`
	} `json:"errors"`
}

// device is a camera or a microphone, as far as Insight reads it.
type device struct {
	ID      string `json:"id"`
	Type    string `json:"type"` // camera, microphone
	Backend string `json:"backend"`
	// A camera's: its libcamera name (MIPI), its nodes (USB), and the rate it runs at now.
	CameraName string  `json:"camera_name"`
	Model      string  `json:"model"`
	DevicePath string  `json:"device_path"`
	ByIDPath   string  `json:"by_id_path"`
	MaxFPS     float64 `json:"max_fps"`
	// A microphone's: its name and the ALSA device Sentinel says to record from.
	Name          string `json:"name"`
	CaptureTarget struct {
		Selector string `json:"selector"`
	} `json:"capture_target"`
	Modes []mode `json:"modes"`
}

// mode is one of a device's modes: a camera's format and size with Sentinel's verdict and frame
// intervals, or a microphone's format with its channels and rates.
type mode struct {
	Format string `json:"format"`
	// A camera's.
	Width          int              `json:"width"`
	Height         int              `json:"height"`
	Available      *bool            `json:"available"`
	Reason         string           `json:"reason"`
	FrameIntervals []frameIntervals `json:"frame_intervals"`
	// A microphone's.
	Channels    int   `json:"channels"`
	RatesHz     []int `json:"rates_hz"`
	RateRangeHz *struct {
		Min int `json:"min"`
		Max int `json:"max"`
	} `json:"rate_range_hz"`
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
	if err == nil {
		err = json.Unmarshal(raw, &parsed)
	}
	if err != nil {
		return catalog{}, malformed("%v", err)
	}
	seen := map[string]bool{}
	for _, d := range parsed.Devices {
		if d.ID == "" || d.Type == "" {
			return catalog{}, malformed("a device without an id or a type")
		}
		if seen[d.ID] {
			return catalog{}, malformed("the device %s twice", d.ID)
		}
		seen[d.ID] = true
	}
	return parsed, nil
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
	provider := d.Type + "." + d.Backend // Sentinel names its providers <type>.<backend>
	for _, e := range c.Errors {
		if e.Provider == provider {
			return true
		}
	}
	return false
}

// name is a device's name for people.
func (d device) name() string {
	for _, name := range []string{d.Name, d.CameraName, d.Model, d.DevicePath} {
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
