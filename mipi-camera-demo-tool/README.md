# MODALIX Camera Control PRO

A web tool for tuning the camera ISP on a SiMa.ai Modalix board. Open it in a
browser, move a slider, and the picture changes immediately.

**Version:** 1.0.0

---

## Install

```bash
sudo apt install --reinstall ./camera_demo_app_v.1.0.0.deb
```

When it finishes it prints the camera it found and the address to open:

```
=============================================
  cam-settings-tools installed successfully
  Camera detected: imx477 5-001a (/dev/video0)
  Open browser: http://192.168.131.157:5000
=============================================
```

Open that address in a browser on the same network. The tool starts
automatically on boot from then on.

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

### Settings survive a page reload

Reload the browser and everything stays where you left it. Settings are not kept
across a service restart or a reboot — after that, controls return to defaults.

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
| ⟳ | Restart the device — asks for confirmation first, then reboots |

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

**Two browsers can watch at once.** Both get the live picture, and either can
change settings.

**If the picture freezes or nothing responds**, the camera hardware has locked
up. Only a reboot clears it — use the ⟳ button in the top right.

---

## Building from source

The package can be rebuilt on a Debian-based system with `dpkg-deb`. See
[BUILD.txt](BUILD.txt) for the complete build commands.

The resulting package contains the Python backend, web UI, launcher, and
systemd service from the `source/` directory.
