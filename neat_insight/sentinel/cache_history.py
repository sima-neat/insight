"""Seed the Stats sparklines from Sentinel's own sample cache.

Sentinel's HTTP API serves only the latest sample (checked against main:80ab7de4da31), but
the daemon keeps its recent samples, and ``simaai-sentinel export`` prints them. Reading them
once per board lets the history open full, as the daemon's own ops view does, instead of
filling over minutes. The export is ~650 KB, so it is trimmed on the board to the newest
samples (~0.3 s and ~100 KB on a DevKit).

This only improves what the page draws first: any failure yields no samples, and the history
then fills from polling as it would without it.
"""
import json

from neat_insight.board import BoardError

SEED_SAMPLES = 64
SEED_TIMEOUT_SEC = 15.0
# The sample count arrives as "$1"; the Python reads the export on stdin and uses no quotes
# that would end the shell's single-quoted string.
SEED_SCRIPT = """
cli=$(command -v simaai-sentinel 2>/dev/null) || cli=/usr/local/bin/simaai-sentinel
"$cli" export | python3 -c '
import json, sys
samples = (json.load(sys.stdin).get("samples") or [])[-int(sys.argv[1]):]
trim = lambda v: round(v, 4) if isinstance(v, float) else v
json.dump([{"timestamp": s.get("timestamp"), "values": {k: trim(v) for k, v in (s.get("values") or {}).items()}}
           for s in samples if isinstance(s, dict)], sys.stdout, separators=(",", ":"))
' "$1"
"""


def read(session, count: int = SEED_SAMPLES) -> list:
    """The daemon's newest cached samples, oldest first; [] when they cannot be read."""
    try:
        result = session.transport.exec(["sh", "-c", SEED_SCRIPT, "sh", str(count)], timeout=SEED_TIMEOUT_SEC)
    except BoardError:
        return []
    if result.exit_code != 0:
        return []
    try:
        samples = json.loads(result.stdout)
    except ValueError:
        return []
    if not isinstance(samples, list):
        return []
    return [
        sample for sample in samples
        if isinstance(sample, dict) and isinstance(sample.get("timestamp"), str) and isinstance(sample.get("values"), dict)
    ]
