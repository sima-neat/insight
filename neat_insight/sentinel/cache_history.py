"""Seed the Stats sparklines from Sentinel's own sample cache.

`GET /v1/samples/latest` serves one sample, but `GET /v1/cache` returns the daemon's whole cache,
including its recent samples (240 at two-second intervals). Reading them once per board lets the
history open full, as the daemon's own ops view does, instead of filling over minutes.

This only improves what the page draws first: any failure yields no samples, and the history then
fills from polling as it would without it.
"""
from neat_insight.board import BoardError
from neat_insight.sentinel.errors import SentinelError

# Everything the daemon caches: 240 samples, the eight minutes its ops view charts.
SEED_SAMPLES = 240


def _trim(value):
    return round(value, 4) if isinstance(value, float) else value


def read(client, count: int = SEED_SAMPLES) -> list:
    """The daemon's newest cached samples, oldest first, each with every metric key; [] when they
    cannot be read."""
    try:
        samples = client.cache().get("samples")
    except (SentinelError, BoardError):
        return []
    if not isinstance(samples, list):
        return []
    samples = [s for s in samples[-count:] if isinstance(s, dict) and isinstance(s.get("timestamp"), str)
               and isinstance(s.get("values"), dict)]
    keys = sorted({key for sample in samples for key in sample["values"]})
    return [{"timestamp": s["timestamp"], "values": {key: _trim(s["values"].get(key)) for key in keys}} for s in samples]
