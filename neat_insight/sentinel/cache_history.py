"""Seed the Stats sparklines from Sentinel's own sample cache.

Sentinel's HTTP API serves only the latest sample (checked against main:80ab7de4da31), but
the daemon keeps its recent samples, and ``simaai-sentinel export`` prints them. Reading them
once per board lets the history open full, as the daemon's own ops view does, instead of
filling over minutes. The export is ~650 KB, so the board sends only the newest samples, as
columns (each key once, then one value per sample): ~0.3 s and ~115 KB on a DevKit for 240.

This only improves what the page draws first: any failure yields no samples, and the history
then fills from polling as it would without it.
"""
import json

from neat_insight.board import BoardError

# Everything the daemon caches: 240 samples, the eight minutes its ops view charts.
SEED_SAMPLES = 240
SEED_TIMEOUT_SEC = 15.0
# The sample count arrives as "$1"; the Python reads the export on stdin and uses no quotes
# that would end the shell's single-quoted string.
SEED_SCRIPT = """
cli=$(command -v simaai-sentinel 2>/dev/null) || cli=/usr/local/bin/simaai-sentinel
"$cli" export | python3 -c '
import json, sys
samples = [s for s in (json.load(sys.stdin).get("samples") or [])[-int(sys.argv[1]):] if isinstance(s, dict)]
keys = sorted({k for s in samples for k in (s.get("values") or {})})
trim = lambda v: round(v, 4) if isinstance(v, float) else v
json.dump({"timestamps": [s.get("timestamp") for s in samples], "keys": keys,
           "rows": [[trim((s.get("values") or {}).get(k)) for k in keys] for s in samples]},
          sys.stdout, separators=(",", ":"))
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
        table = json.loads(result.stdout)
    except ValueError:
        return []
    if not isinstance(table, dict):
        return []
    keys, rows, stamps = table.get("keys"), table.get("rows"), table.get("timestamps")
    if not (isinstance(keys, list) and isinstance(rows, list) and isinstance(stamps, list)) or len(rows) != len(stamps):
        return []
    return [
        {"timestamp": stamp, "values": dict(zip(keys, row))}
        for stamp, row in zip(stamps, rows)
        if isinstance(stamp, str) and isinstance(row, list) and len(row) == len(keys)
    ]
