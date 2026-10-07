"""Set a MIPI preview's real frame rate on its sensor.

libcamera on the board starts the sensor at its own rate (an IMX477 free-runs at about 66 fps) whatever
rate libcamerasrc requests. Setting the sensor sub-device's V4L2 `vertical_blanking` control once the
stream runs changes the sensor's real rate, and it holds until libcamera starts the camera again, which
resets it. The rate of a sensor is pixel_rate / ((width + horizontal_blanking) * (height + vertical_blanking)),
so the blanking for a rate comes from the sensor's live values, read after the stream starts.
"""
import logging
import shlex
from fractions import Fraction
from typing import Optional, Tuple

from neat_insight.board import BoardError

RATE_TIMEOUT_SEC = 10.0
RATE_NOTE = "The camera runs at its own rate; Insight could not set it."
SYSFS = "/sys/class/video4linux"

# Runs on the board with name, num, den and sysfs set before it. Finds the sensor's sub-device by the
# camera's libcamera name, reads its live timing, sets vertical_blanking for num/den fps (rounded, within the
# control's range), and prints `pixel_rate width horizontal_blanking height vertical_blanking` as read back.
# Every failure is one sentence on stderr and a non-zero exit.
_SCRIPT = r"""
PATH="$PATH:/usr/local/bin:/usr/sbin:/sbin"
fail() { echo "$1" >&2; exit 1; }
int() { case $1 in ''|*[!0-9]*) return 1;; esac; }
command -v v4l2-ctl >/dev/null 2>&1 || fail "v4l2-ctl (v4l-utils) is not installed on the board."
dev=
for d in "$sysfs"/v4l-subdev*; do
  [ "$(cat "$d/name" 2>/dev/null)" = "$name" ] && { dev=/dev/${d##*/}; break; }
done
[ -n "$dev" ] || fail "No V4L2 sub-device on the board is named after the camera."
ctrl() { v4l2-ctl -d "$dev" --get-ctrl "$1" 2>/dev/null | sed -n "s/^$1: *\([0-9][0-9]*\) *$/\1/p"; }
pr=$(ctrl pixel_rate); hb=$(ctrl horizontal_blanking)
set -- $(v4l2-ctl -d "$dev" --get-subdev-fmt pad=0 2>/dev/null | sed -n 's|.*Width/Height *: *\([0-9][0-9]*\)/\([0-9][0-9]*\).*|\1 \2|p')
w=$1; h=$2
int "$pr" && int "$hb" && int "$w" && int "$h" && [ "$pr" -gt 0 ] && [ $((w + hb)) -gt 0 ] \
  || fail "Could not read the sensor's timing from $dev."
line=$((w + hb))
vb=$(( (2 * pr * den + num * line) / (2 * num * line) - h ))
set -- $(v4l2-ctl -d "$dev" --list-ctrls 2>/dev/null | sed -n 's/^ *vertical_blanking .* min=\([0-9][0-9]*\) max=\([0-9][0-9]*\) .*/\1 \2/p')
if int "$1"; then [ "$vb" -lt "$1" ] && vb=$1; fi
if int "$2"; then [ "$vb" -gt "$2" ] && vb=$2; fi
v4l2-ctl -d "$dev" --set-ctrl "vertical_blanking=$vb" >/dev/null 2>&1 || fail "The sensor refused vertical_blanking=$vb."
got=$(ctrl vertical_blanking)
[ "$got" = "$vb" ] || fail "The sensor kept vertical_blanking at ${got:-an unknown value}, not $vb."
echo "$pr $w $hb $h $got"
"""


def rate_script(camera_name: str, rate: Fraction, sysfs: str = SYSFS) -> str:
    """The board script that sets the camera's sensor to `rate`. The camera name is board-reported data, so
    it is shell-quoted, never interpolated bare."""
    return (
        f"name={shlex.quote(camera_name)}; num={rate.numerator}; den={rate.denominator}; "
        f"sysfs={shlex.quote(sysfs)}" + _SCRIPT
    )


def apply(transport, camera_name, rate: Fraction) -> Tuple[Optional[dict], Optional[str]]:
    """Set the running camera's sensor to `rate`: ({fps, vblank, sensor_fps}, None), or (None, a note
    saying why not). Never raises for a board failure: the preview runs on at the sensor's own rate."""
    if not isinstance(camera_name, str) or not camera_name:
        return None, f"{RATE_NOTE} The camera has no name to find its sensor by."
    try:
        result = transport.exec(["sh", "-c", rate_script(camera_name, rate)], timeout=RATE_TIMEOUT_SEC)
    except BoardError as exc:
        logging.warning("Could not set %s's frame rate: %s", camera_name, exc)
        return None, f"{RATE_NOTE} {exc.message}"
    lines = result.stdout.decode("utf-8", errors="replace").split("\n")
    fields = next((line.split() for line in reversed(lines) if line.strip()), [])
    if result.exit_code != 0 or len(fields) != 5 or not all(field.isdigit() for field in fields):
        # A login shell may print other lines first; the script's reason is its last line.
        errors = result.stderr.decode("utf-8", errors="replace").strip().splitlines()
        reason = errors[-1].strip()[:200] if errors else "The board's command did not report the sensor's timing."
        logging.warning("Could not set %s's frame rate: %s", camera_name, reason)
        return None, f"{RATE_NOTE} {reason}"
    pixel_rate, width, hblank, height, vblank = (int(field) for field in fields)
    sensor_fps = pixel_rate / ((width + hblank) * (height + vblank))
    fps = int(rate) if rate.denominator == 1 else round(float(rate), 3)
    return {"fps": fps, "vblank": vblank, "sensor_fps": round(sensor_fps, 2)}, None
