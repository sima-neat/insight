# SiMa.ai MIPI Camera Utility

A web tool for tuning the camera ISP on a SiMa.ai Modalix board. Open it in a
browser, move a slider, and the picture changes immediately.

**Version:** 1.0.0

---

## Install

### Recommended: `sima-cli`

```bash
sima-cli neat install insight/mipi-util@<branch-or-tag>
```

This is published as its own Vulcan package (`gh:sima-neat/insight/mipi-util`)
by the **MIPI Util Vulcan CI** workflow
([.github/workflows/mipi-util-vulcan-ci.yml](../.github/workflows/mipi-util-vulcan-ci.yml)),
which builds the `.deb`, validates it, generates the package metadata, publishes
branch and tag builds to Vulcan, and smoke-tests the API. Publishing branch
builds makes the package available for end-to-end installation testing before
the branch is merged.

### Manual (`.deb`)

Build the package (`./build-deb.sh dist`, see [BUILD.txt](BUILD.txt)) or use a
prebuilt one, then:

```bash
sudo apt install ./sima-mipi-util_1.0.0_arm64.deb
```

When it finishes it prints the camera it found, the address to open, and the
**API token** you'll need to change any settings from the UI:

```
=============================================
  SiMa.ai MIPI Camera Utility installed
  Camera detected: imx477 5-001a (/dev/video0)
  Open browser: http://192.168.131.157:5000
  ---------------------------------------------
  API token (required to change settings from the UI):
    Qk3f9xR2pT...
=============================================
```

Open that address in a browser on the same network. The tool starts
automatically on boot from then on.

### API token

Viewing the live stream needs no token, but **changing any setting** (or
restarting the service) requires the per-device token printed above. The UI
prompts for it the first time you move a control and remembers it in the
browser. The token lives in `/etc/sima-mipi-util/token` (root-only) on the
device if you need to look it up again.

---

## What the tool does

### Live View

Shows the camera picture as it is right now, with the current frame rate. Every
change you make is visible here immediately.

### Camera Controls

| Panel | Controls |
|---|---|
| **White Balance** | R Gain, Colour Temp, B Gain |
| **Exposure** | Current Exposure |
| **Gain Control** | Analog Gain, Digital Gain |
| **Image Enhancement** | Sharpness, Saturation, Denoise |
| **Color & Tone** | Contrast, Gamma, Tone Mapping |

Each panel has a switch. Turning it on puts that part of the camera under your
control instead of leaving it automatic.

### There is no Apply button

Every slider, toggle and dropdown is written to the camera the moment you change
it. What you see in Live View is the real result.

### Settings persist

Settings are saved and restored after a page reload, service restart, camera
rebuild, or device reboot. Use **Set Default** to clear saved tuning values.

### Sidebar

| Button | What it does |
|---|---|
| **Undo** | Puts everything back to how it was when you started adjusting |
| **Set Default** | Returns every control to its default value |
| **Daylight / Indoor / Night** | Ready-made setups for those conditions |

### Header

| Button | What it does |
|---|---|
| ☼ | Switch between day and night appearance |
| ⟳ | Restart the camera **service** — asks for confirmation first |

### Information panels

- **Stream & Device Info** — resolution, format, and which devices are in use
- **Sensor Overview** — exposure, gain, blanking, link frequency
- **Histogram** — the brightness spread of the picture, dark on the left,
  bright on the right

---

## Things to know

**Colour Temp does nothing.** The camera reports its colour temperature but does
not accept a new one. Use **R Gain** and **B Gain** to adjust white balance —
those work.

**Frame rate sits around 28 fps.** The camera supplies 34 and the tool is capped
at 30; the difference is time spent compressing the picture for the browser.

**Only one browser/client can use the camera at a time.** Close the live-view
browser before starting another camera application or opening it elsewhere.

**If the picture freezes or nothing responds**, try the ⟳ button (top right) to
restart the service first. If that doesn't clear it, the camera hardware has
locked up and needs a full device reboot — do that from an SSH/console session
(`sudo reboot`). For safety, a full reboot is no longer exposed through the web
UI.

---

## Building from source

The package can be rebuilt on a Debian-based system with `dpkg-deb`. See
[BUILD.txt](BUILD.txt) for the complete build commands.

The resulting package contains the Python backend, web UI, launcher, and
systemd service from the `source/` directory.
