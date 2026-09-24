"""Turn Sentinel's metric definitions and samples into what the Stats page renders.

Definitions carry the label, unit, group and thresholds; a sample carries values only.
This joins them so nothing is rendered as a bare key, and keeps unavailable metrics as
`null` with status "unavailable" — never zero, which would read as a real measurement.
"""
from typing import List, Optional

OK = "ok"
WARN = "warn"
CRITICAL = "critical"
UNAVAILABLE = "unavailable"
OTHER_GROUP = "Other"
# Headline metrics the Stats page leads with, when the board reports them.
HIGHLIGHT_KEYS = (
    "power_current_watts",
    "cpu_usage_pct",
    "linux_mem_used_pct",
    "mla_mem_allocated_mb",
    "ev74_cma_used_mb",
)
TEMPERATURE_UNIT = "C"


def _number(value):
    """Sentinel reports an unavailable metric as null; anything but a number stays null."""
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _label(key: str) -> str:
    return key.replace("_", " ").strip().capitalize()


def status_of(value, warn, critical) -> str:
    """Rank one value against its thresholds; an unavailable value is never "ok"."""
    if value is None:
        return UNAVAILABLE
    if critical is not None and value >= critical:
        return CRITICAL
    if warn is not None and value >= warn:
        return WARN
    return OK


def _metric(definition: dict, values: dict) -> dict:
    key = definition.get("key")
    value = _number(values.get(key))
    return {
        "key": key,
        "label": definition.get("label") or _label(key or ""),
        "short": definition.get("short") or definition.get("label") or _label(key or ""),
        "unit": definition.get("unit"),
        "description": definition.get("description"),
        "group": definition.get("group") or OTHER_GROUP,
        "warn": definition.get("warn"),
        "critical": definition.get("critical"),
        "value": value,
        "status": status_of(value, definition.get("warn"), definition.get("critical")),
    }


def _hottest(metrics: List[dict]) -> Optional[str]:
    temperatures = [m for m in metrics if m["unit"] == TEMPERATURE_UNIT and m["value"] is not None]
    return max(temperatures, key=lambda m: m["value"])["key"] if temperatures else None


def series(history: List[dict], keys: List[str], limit: int) -> dict:
    """Bounded per-metric series for sparklines: aligned timestamps, `null` where missing."""
    window = history[-limit:] if limit > 0 else []
    return {
        "timestamps": [sample.get("timestamp") for sample in window],
        "series": {key: [_number((sample.get("values") or {}).get(key)) for sample in window] for key in keys},
    }


def build(definitions: dict, latest: dict, history: List[dict], history_limit: int = 0) -> dict:
    """Join `/v1/metrics` and `/v1/samples/latest` into grouped, labelled, ranked metrics."""
    sample = latest.get("sample") or {}
    values = sample.get("values") or {}
    defined = [d for d in definitions.get("metrics") or [] if isinstance(d, dict) and d.get("key")]
    metrics = [_metric(definition, values) for definition in defined]
    # A board can report a value Insight has no definition for; show it rather than drop it.
    known = {metric["key"] for metric in metrics}
    metrics.extend(_metric({"key": key}, values) for key in sorted(values) if key not in known)

    groups = {}
    for metric in metrics:
        groups.setdefault(metric["group"], []).append(metric)
    by_key = {metric["key"]: metric for metric in metrics}
    highlights = [key for key in HIGHLIGHT_KEYS if key in by_key]
    hottest = _hottest(metrics)
    if hottest and hottest not in highlights:
        highlights.append(hottest)

    return {
        "sampled_at": sample.get("timestamp"),
        "version": latest.get("version"),
        "counts": {
            "total": len(metrics),
            "unavailable": sum(1 for metric in metrics if metric["status"] == UNAVAILABLE),
            "warn": sum(1 for metric in metrics if metric["status"] == WARN),
            "critical": sum(1 for metric in metrics if metric["status"] == CRITICAL),
        },
        "highlights": highlights,
        "groups": [{"name": name, "metrics": groups[name]} for name in sorted(groups)],
        "history": series(history, [metric["key"] for metric in metrics], history_limit),
    }
