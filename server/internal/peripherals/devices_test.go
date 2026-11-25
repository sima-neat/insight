package peripherals

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"insight/internal/sentinel"
)

// The devices are held to catalogs real boards' Sentinels wrote: a DevKit with an IMX477 on
// MIPI, a C920 webcam on USB and the C920's microphone; and an earlier Sentinel's catalog of the
// same board, which gives no verdicts.

const (
	nv12Only = "Neat's CameraInput outputs NV12 only."
	// What a Sentinel that predates the USB check (it names no driver) leaves a USB camera with,
	// whatever verdicts it gave.
	usbReason = usbUpdateReason
)

// sentinelFixture is a catalog of tests/fixtures as plain JSON, for a test to change.
func sentinelFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	content, err := os.ReadFile("../../../tests/fixtures/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var catalog map[string]any
	if err := json.Unmarshal(content, &catalog); err != nil {
		t.Fatal(err)
	}
	return catalog
}

func devkitFixture(t *testing.T) map[string]any {
	return sentinelFixture(t, "sentinel-catalog-devkit-3.0.json")
}

// fixtureDevice is a copy of the catalog's device i, for a test to change.
func fixtureDevice(t *testing.T, catalog map[string]any, i int) map[string]any {
	t.Helper()
	var d map[string]any
	if err := json.Unmarshal(must(json.Marshal(catalog["devices"].([]any)[i])), &d); err != nil {
		t.Fatal(err)
	}
	return d
}

// scanned is what a scan of catalog answers.
func scanned(t *testing.T, catalog map[string]any) catalog {
	t.Helper()
	var body sentinel.Body
	if err := json.Unmarshal(must(json.Marshal(catalog)), &body); err != nil {
		t.Fatal(err)
	}
	parsed, err := parseCatalog(body)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

// withDevices is catalog with devices in place of its own.
func withDevices(catalog map[string]any, devices ...map[string]any) map[string]any {
	changed := map[string]any{}
	for key, value := range catalog {
		changed[key] = value
	}
	changed["devices"] = devices
	return changed
}

func camera(t *testing.T, item Item) CameraItem {
	t.Helper()
	c, ok := item.(CameraItem)
	if !ok {
		t.Fatalf("%#v is not a camera", item)
	}
	return c
}

func microphone(t *testing.T, item Item) MicrophoneItem {
	t.Helper()
	m, ok := item.(MicrophoneItem)
	if !ok {
		t.Fatalf("%#v is not a microphone", item)
	}
	return m
}

func formatNamed(t *testing.T, c CameraItem, name string) CameraFormat {
	t.Helper()
	i := slices.IndexFunc(c.Formats, func(f CameraFormat) bool { return f.Format == name })
	if i < 0 {
		t.Fatalf("%s has no format %s", c.ID, name)
	}
	return c.Formats[i]
}

func equal(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s:\n got %s\nwant %s", what, must(json.Marshal(got)), must(json.Marshal(want)))
	}
}

func TestAScanListsItsCamerasThenItsMicrophones(t *testing.T) {
	devkit := scanned(t, devkitFixture(t))
	var listed [][2]string
	for _, item := range devkit.items() {
		switch d := item.(type) {
		case CameraItem:
			listed = append(listed, [2]string{d.Kind, d.ID})
		case MicrophoneItem:
			listed = append(listed, [2]string{d.Kind, d.ID})
		}
	}
	equal(t, "the items", listed, [][2]string{
		{"camera", "camera:imx477 5-001a"},
		{"camera", "camera:v4l2:421bbe426738013b"},
		{"microphone", "microphone:alsa:329f324bddfdde7b"},
	})
	equal(t, "the issues", devkit.issues(), []Issue{})
}

func TestAMIPICameraKeepsSentinelsVerdictOnEachMode(t *testing.T) {
	imx477 := camera(t, scanned(t, devkitFixture(t)).items()[0])
	model := "imx477"
	equal(t, "the camera", []any{imx477.Connection, imx477.Name, imx477.Model, imx477.Support, imx477.ModesSource, imx477.Device, imx477.Notes, imx477.Errors},
		[]any{"mipi", "imx477 5-001a", &model, Support{Tier: "available"}, "live",
			CameraDevice{CameraName: "imx477 5-001a", MediaDevice: "/dev/media0", BusInfo: "platform:csi2video@1", CSI: "csidev-40c3000.csi"},
			[]string{}, []DeviceError{}})
	var formats [][]any
	for _, f := range imx477.Formats {
		formats = append(formats, []any{f.Format, f.Label, f.Support})
	}
	equal(t, "the formats", formats, [][]any{
		{"AR24", "AR24 (packed 32-bit)", Support{"unsupported", nv12Only}},
		{"NV12", "NV12 (YUV 4:2:0)", Support{Tier: "available"}},
		{"NV16", "NV16", Support{"unsupported", nv12Only}},
		{"NV24", "NV24", Support{"unsupported", nv12Only}},
		{"RGB3", "RGB3 (packed 24-bit)", Support{"unsupported", nv12Only}},
	})
	nv12 := imx477.Formats[1]
	// Every size Sentinel lists, the IMX477's 4056-wide ones included: Insight caps no width.
	if !slices.ContainsFunc(nv12.Sizes, func(s CameraSize) bool { return s.Width == 4056 && s.Height == 3040 }) {
		t.Error("NV12 has no 4056x3040")
	}
	// A MIPI mode advertises no rate: CameraInput's default, which the camera's 125.54 fps covers.
	equal(t, "an NV12 size's rates", nv12.Sizes[0].FPS, []CameraMode{{Value: 30, Tier: "available", Previewable: true}})
	equal(t, "an AR24 size's rates", imx477.Formats[0].Sizes[0].FPS,
		[]CameraMode{{Value: 30, Tier: "unsupported", Reason: nv12Only, Previewable: false}})
	// 1920 wide is preferred.
	equal(t, "the default", imx477.DefaultSelection, &Mode{Format: "NV12", Width: 1920, Height: 1080, FPS: 30})
}

func TestASlowMIPICameraIsOfferedItsOwnRate(t *testing.T) {
	catalog := devkitFixture(t)
	slow := fixtureDevice(t, catalog, 0)
	slow["max_fps"] = 20.004
	imx477 := camera(t, scanned(t, withDevices(catalog, slow)).items()[0])
	if got := imx477.Formats[1].Sizes[0].FPS[0]; got.Value != 20.004 || !got.Previewable {
		t.Errorf("the rate offered: %+v", got)
	}
}

func TestAMIPICameraWithoutVerdictsPreviewsNV12(t *testing.T) {
	c := camera(t, scanned(t, sentinelFixture(t, "sentinel-catalog-example.json")).items()[0])
	if c.Support.Tier != "unsupported" || c.Support.Reason != noVerdictReason {
		t.Errorf("the camera's support: %+v", c.Support)
	}
	// The example's camera runs at 66.18 fps: CameraInput's 30 is within it.
	equal(t, "NV12's first rate", formatNamed(t, c, "NV12").Sizes[0].FPS[0],
		CameraMode{Value: 30, Tier: "unsupported", Reason: noVerdictReason, Previewable: true})
	if formatNamed(t, c, "AR24").Sizes[0].FPS[0].Previewable {
		t.Error("AR24 is previewable")
	}
	if c.DefaultSelection != nil {
		t.Errorf("a default without an Available mode: %+v", c.DefaultSelection)
	}
}

func TestAUSBCameraPreviewsItsModesAtTheRatesItAdvertises(t *testing.T) {
	c920 := camera(t, scanned(t, devkitFixture(t)).items()[1])
	model := "HD Pro Webcam C920"
	equal(t, "the camera", []any{c920.Connection, c920.Name, c920.Model, c920.Support, c920.Device, c920.DefaultSelection, c920.Notes},
		[]any{"usb", "HD Pro Webcam C920", &model, Support{"unsupported", usbReason},
			CameraDevice{VideoNode: "/dev/video1", ByID: "/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_BE998CAF-video-index0",
				USB: &UsbFacts{VendorID: "046d", ProductID: "08e5", Serial: "BE998CAF", Product: "HD Pro Webcam C920",
					BusPath: "devices/platform/7ff0000000.pci/pci0003:00/0003:00:00.0/0003:01:00.0/usb1/1-3/1-3.1", SpeedMbps: 480}},
			(*Mode)(nil), []string{}})
	var labels [][2]string
	for _, f := range c920.Formats {
		labels = append(labels, [2]string{f.Format, f.Label})
	}
	// A USB driver names its own formats.
	equal(t, "the formats", labels, [][2]string{{"MJPG", "MJPG (Motion-JPEG)"}, {"YUYV", "YUYV (YUYV 4:2:2)"}})
	sizes := c920.Formats[0].Sizes
	fullHD := sizes[slices.IndexFunc(sizes, func(s CameraSize) bool { return s.Width == 1920 })]
	var values []float64
	for _, r := range fullHD.FPS {
		values = append(values, r.Value)
		if r != (CameraMode{Value: r.Value, Tier: "unsupported", Reason: usbReason, Previewable: true}) {
			t.Errorf("a rate of MJPG 1920x1080: %+v", r)
		}
	}
	equal(t, "MJPG 1920x1080's rates", values, []float64{30, 24, 20, 15, 10, 7.5, 5})
}

// checkedUSBCamera is the catalog's USB camera as a Sentinel that checks USB cameras reports it:
// it names the driver, judges MJPG available on uvcvideo and every other format not.
func checkedUSBCamera(t *testing.T) map[string]any {
	t.Helper()
	webcam := fixtureDevice(t, devkitFixture(t), 1)
	webcam["identity"].(map[string]any)["driver"] = "uvcvideo"
	webcam["identity"].(map[string]any)["camera_name"] = "usb-046d:08e5-0"
	for _, m := range webcam["modes"].([]any) {
		m := m.(map[string]any)
		if m["format"] == "MJPG" {
			m["available"], m["reason"] = true, ""
		} else {
			m["available"], m["reason"] = false, "Neat's USB camera input reads MJPEG only."
		}
	}
	return webcam
}

func TestAUSBCameraSentinelChecksIsAvailableInMJPG(t *testing.T) {
	c := camera(t, scanned(t, withDevices(devkitFixture(t), checkedUSBCamera(t))).items()[0])
	equal(t, "the camera's support", c.Support, Support{Tier: "available"})
	equal(t, "MJPG", formatNamed(t, c, "MJPG").Support, Support{Tier: "available"})
	// The name Neat's USB camera input opens it by, the way a MIPI camera's is its libcamera name.
	equal(t, "the camera's name", c.Device.CameraName, "usb-046d:08e5-0")
	equal(t, "YUYV", formatNamed(t, c, "YUYV").Support, Support{"unsupported", "Neat's USB camera input reads MJPEG only."})
	if c.DefaultSelection == nil || c.DefaultSelection.Format != "MJPG" {
		t.Errorf("the preselected mode: %+v", c.DefaultSelection)
	}
}

func TestAUSBCameraWithoutAMJPGModeSaysWhyFromItsMJPGModes(t *testing.T) {
	webcam := checkedUSBCamera(t)
	var modes []any
	for _, m := range webcam["modes"].([]any) {
		m := m.(map[string]any)
		switch {
		case m["format"] == "MJPG":
			m["available"], m["reason"] = false, "The camera is not on the uvcvideo driver."
		case m["format"] == "YUYV":
			m["reason"] = "The pixel format is not MJPEG."
		}
		modes = append(modes, m)
	}
	webcam["modes"] = modes
	c := camera(t, scanned(t, withDevices(devkitFixture(t), webcam)).items()[0])
	// YUYV modes outnumber MJPG ones in the capture, but Neat's USB input reads MJPG.
	equal(t, "the camera's support", c.Support, Support{"unsupported", "The camera is not on the uvcvideo driver."})
}

func TestAUSBModeWithoutAVerdictFromACheckingSentinelSaysItCouldNotTell(t *testing.T) {
	webcam := checkedUSBCamera(t)
	for _, m := range webcam["modes"].([]any) {
		delete(m.(map[string]any), "available")
		delete(m.(map[string]any), "reason")
	}
	c := camera(t, scanned(t, withDevices(devkitFixture(t), webcam)).items()[0])
	equal(t, "the camera's support", c.Support, Support{"unsupported", usbUnknownReason})
	// A refusal without a reason names the mode, not an ISP.
	webcam = checkedUSBCamera(t)
	for _, m := range webcam["modes"].([]any) {
		m.(map[string]any)["reason"] = ""
		m.(map[string]any)["available"] = false
	}
	c = camera(t, scanned(t, withDevices(devkitFixture(t), webcam)).items()[0])
	equal(t, "the camera's support", c.Support, Support{"unsupported", usbRefusedReason})
}

func TestAUSBCameraOfASentinelWithoutTheCheckIgnoresItsVerdicts(t *testing.T) {
	// The driver is what says Sentinel checks USB cameras: without it, even an Available verdict
	// is the MIPI overlay rule's, which says nothing about Neat's USB input.
	webcam := checkedUSBCamera(t)
	delete(webcam["identity"].(map[string]any), "driver")
	c := camera(t, scanned(t, withDevices(devkitFixture(t), webcam)).items()[0])
	equal(t, "the camera's support", c.Support, Support{"unsupported", usbUpdateReason})
	equal(t, "MJPG", formatNamed(t, c, "MJPG").Support, Support{"unsupported", usbUpdateReason})
	if c.DefaultSelection != nil {
		t.Errorf("a preselected mode: %+v", c.DefaultSelection)
	}
}

func TestAUSBCameraWithoutAByIDLinkSaysItsNodeMayChange(t *testing.T) {
	catalog := devkitFixture(t)
	webcam := fixtureDevice(t, catalog, 1)
	delete(webcam, "by_id_path")
	c := camera(t, scanned(t, withDevices(catalog, webcam)).items()[0])
	if c.Device.ByID != "" || len(c.Notes) != 1 || !strings.Contains(c.Notes[0], "No /dev/v4l/by-id link was found") {
		t.Errorf("the camera: %+v", c)
	}
}

func TestAUSBMicrophoneNamesItsWebcamAndKeepsItsCaptureFormats(t *testing.T) {
	items := scanned(t, devkitFixture(t)).items()
	mic := microphone(t, items[2])
	zero := 0
	equal(t, "the microphone", []any{mic.Connection, mic.Name, mic.Device, mic.Notes},
		[]any{"usb", "HD Pro Webcam C920", MicrophoneDevice{CardIndex: &zero, CardID: "C920", CardName: "HD Pro Webcam C920",
			CardDriver: "USB-Audio", PCMDevice: &zero, PCMNode: "/dev/snd/pcmC0D0c", ALSAName: "hw:CARD=C920,DEV=0",
			ByPath: "/dev/snd/by-path/platform-7ff0000000.pci-pci-0003:01:00.0-usb-0:3.1:1.2",
			ByID:   "/dev/snd/by-id/usb-046d_HD_Pro_Webcam_C920_BE998CAF-02",
			USB: &UsbFacts{VendorID: "046d", ProductID: "08e5", Product: "HD Pro Webcam C920", Serial: "BE998CAF",
				BusPath: "1-3.1", Interface: "1-3.1:1.2"},
			PartOf: &DeviceRef{ID: "camera:v4l2:421bbe426738013b", Name: "HD Pro Webcam C920"}}, []string{}})
	var captures []MicrophoneCapture
	for _, rate := range []int{16000, 24000, 32000} {
		captures = append(captures, MicrophoneCapture{Format: "S16_LE", Channels: 2, Bits: 16, Rates: []int{rate}, ChannelMap: []string{"FL", "FR"}})
	}
	equal(t, "the capture formats", mic.Capture, captures)
}

func TestAMicrophonesRecordChangesWithItsCaptureTargetOrIdentity(t *testing.T) {
	catalog := devkitFixture(t)
	recordOf := func(change func(map[string]any)) string {
		mic := fixtureDevice(t, catalog, 2)
		change(mic)
		return microphone(t, scanned(t, withDevices(catalog, mic)).items()[0]).Record
	}
	same := recordOf(func(map[string]any) {})
	if recordOf(func(mic map[string]any) { mic["modes"] = []any{} }) != same {
		t.Error("the record changed with the modes")
	}
	if recordOf(func(mic map[string]any) { mic["capture_target"] = map[string]any{"card_id": "C920", "device": 1} }) == same {
		t.Error("the record stayed with another capture target")
	}
	if recordOf(func(mic map[string]any) { mic["identity"].(map[string]any)["stable_key"] = "elsewhere" }) == same {
		t.Error("the record stayed with another identity")
	}
}

func TestAFailedProvidersDevicesAreItsLastScans(t *testing.T) {
	catalog := devkitFixture(t)
	catalog["errors"] = []any{map[string]any{"provider": "camera.v4l2", "code": "provider.failed", "reason": "v4l2 timed out"}}
	failed := scanned(t, catalog)
	items := failed.items()
	webcam := camera(t, items[1])
	if webcam.ModesSource != "previous-scan" || !slices.Contains(webcam.Notes,
		"Modes are from SiMa Sentinel's last successful scan; its camera.v4l2 provider failed during this refresh.") {
		t.Errorf("the webcam: %+v", webcam)
	}
	equal(t, "the issues", failed.issues(), []Issue{{Code: "provider.failed",
		Message: "SiMa Sentinel's camera.v4l2 provider failed: v4l2 timed out The devices it found last time are still listed.",
		Hint:    statusHint}})
	// The others are this scan's.
	if camera(t, items[0]).ModesSource != "live" {
		t.Error("the MIPI camera is not this scan's")
	}
}

func TestACameraWithoutModesSaysWhyAndAnotherKindIsListed(t *testing.T) {
	catalog := devkitFixture(t)
	noModes := fixtureDevice(t, catalog, 0)
	noModes["modes"] = []any{}
	lidar := map[string]any{"id": "lidar:1", "type": "lidar", "backend": "i2c", "name": "Front LiDAR",
		"issues": []any{map[string]any{"code": "x", "reason": "Not calibrated."}}}
	items := scanned(t, withDevices(catalog, noModes, lidar)).items()
	c := camera(t, items[0])
	equal(t, "the camera", []any{c.ModesSource, c.Support, c.Errors, c.DefaultSelection},
		[]any{"unavailable", Support{"unsupported", noModesReason},
			[]DeviceError{{Code: "no_modes", Message: noModesReason, Hint: statusHint}}, (*Mode)(nil)})
	equal(t, "the LiDAR", items[1], OtherItem{ID: "lidar:1", Kind: "lidar", Connection: "i2c", Name: "Front LiDAR",
		Notes: []string{"Not calibrated."}, Errors: []DeviceError{}})
}

func TestTheBoardsCameraSetupListsTheOverlaysThatConfigureASensor(t *testing.T) {
	model := "SiMa.ai Modalix SoM 16Gig Board"
	equal(t, "the DevKit's", scanned(t, devkitFixture(t)).cameraSetup(),
		&CameraSetup{Model: &model, Overlays: []string{"modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo"}})
	catalog := devkitFixture(t)
	catalog["board"] = map[string]any{"overlays": []any{"pcie.dtbo", "cam.dtbo"},
		"supported_sensors": []any{map[string]any{"compatible": "sony,imx477", "overlays": []any{"cam.dtbo"}}}}
	equal(t, "a board without a model", scanned(t, catalog).cameraSetup(), &CameraSetup{Overlays: []string{"cam.dtbo"}})
	delete(catalog, "board")
	if setup := scanned(t, catalog).cameraSetup(); setup != nil {
		t.Errorf("without a board block: %+v", setup)
	}
}

func TestTheRatesOfARangeAreTheStandardOnesItHolds(t *testing.T) {
	catalog := devkitFixture(t)
	ratesOf := func(i map[string]any) []float64 {
		webcam := fixtureDevice(t, catalog, 1)
		webcam["modes"] = []any{map[string]any{"format": "YUYV", "width": 640, "height": 480, "available": false,
			"frame_intervals": []any{map[string]any{"width": 640, "height": 480, "intervals": []any{i}}}}}
		var values []float64
		for _, r := range camera(t, scanned(t, withDevices(catalog, webcam)).items()[0]).Formats[0].Sizes[0].FPS {
			values = append(values, r.Value)
			if !r.Previewable {
				t.Errorf("%g fps is not previewable", r.Value)
			}
		}
		return values
	}
	fraction := func(num, den int) map[string]any { return map[string]any{"numerator": num, "denominator": den} }
	// 1/30 s to 1/5 s in steps of 1/30 s: 30, 15 and 10 fit, 25 and 20 do not.
	equal(t, "a stepwise range", ratesOf(map[string]any{"type": "stepwise",
		"minimum": fraction(1, 30), "maximum": fraction(1, 5), "step": fraction(1, 30)}), []float64{30, 15, 10, 5})
	// A continuous range fixed at 24 fps holds no standard rate: its fastest is offered.
	equal(t, "a range at 24 fps", ratesOf(map[string]any{"type": "continuous",
		"minimum": fraction(1, 24), "maximum": fraction(1, 24)}), []float64{24})
}

func TestARateIsWholeWhenItIsElseToAThousandth(t *testing.T) {
	for _, c := range []struct{ fps, want float64 }{{30, 30}, {30000.0 / 1001, 29.97}, {7.5, 7.5}, {1.0 / 3000, 0.000333333}} {
		if got := fpsValue(c.fps); got != c.want {
			t.Errorf("fpsValue(%g) = %g, want %g", c.fps, got, c.want)
		}
	}
}
