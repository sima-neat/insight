"""Seed the Stats history from Sentinel's own sample cache; any failure yields no samples."""
import json

from neat_insight.board import BoardError

SEED_SAMPLES = 240
SEED_TIMEOUT_SEC = 15.0
# The export is ~650 KB, so the board sends the newest samples as columns; the count arrives as "$1".
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
    try:
        result = session.transport.exec(["sh", "-c", SEED_SCRIPT, "sh", str(count)], timeout=SEED_TIMEOUT_SEC)
        table = json.loads(result.stdout) if result.exit_code == 0 else None
    except (BoardError, ValueError):
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
