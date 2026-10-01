"""Join Sentinel's metric definitions with its latest sample; an unmeasured value stays null, never zero."""
from typing import List

OTHER_GROUP = "Other"
HIGHLIGHT_KEYS = (
    "power_current_watts",
    "cpu_usage_pct",
    "linux_mem_used_pct",
    "mla_mem_allocated_mb",
    "ev74_cma_used_mb",
)


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def status_of(value, warn, critical) -> str:
    if value is None:
        return "unavailable"
    if critical is not None and value >= critical:
        return "critical"
    if warn is not None and value >= warn:
        return "warn"
    return "ok"


def _metric(definition: dict, values: dict) -> dict:
    key = definition.get("key")
    label = definition.get("label") or key.replace("_", " ").strip().capitalize()
    value = _number(values.get(key))
    return {
        "key": key,
        "label": label,
        "short": definition.get("short") or label,
        "unit": definition.get("unit"),
        "description": definition.get("description"),
        "group": definition.get("group") or OTHER_GROUP,
        "warn": definition.get("warn"),
        "critical": definition.get("critical"),
        "value": value,
        "status": status_of(value, definition.get("warn"), definition.get("critical")),
    }


def build(definitions: dict, latest: dict, history: List[dict], history_limit: int = 0) -> dict:
    sample = latest.get("sample") or {}
    values = sample.get("values") or {}
    metrics = [_metric(d, values) for d in definitions.get("metrics") or [] if isinstance(d, dict) and d.get("key")]
    known = {metric["key"] for metric in metrics}
    metrics.extend(_metric({"key": key}, values) for key in sorted(values) if key not in known)

    groups = {}
    for metric in metrics:
        groups.setdefault(metric["group"], []).append(metric)
    keys = [metric["key"] for metric in metrics]
    highlights = [key for key in HIGHLIGHT_KEYS if key in keys]
    temperatures = [m for m in metrics if m["unit"] == "C" and m["value"] is not None]
    if temperatures:
        hottest = max(temperatures, key=lambda m: m["value"])["key"]
        if hottest not in highlights:
            highlights.append(hottest)
    window = history[-history_limit:] if history_limit > 0 else []
    return {
        "sampled_at": sample.get("timestamp"),
        "version": latest.get("version"),
        "counts": {
            "total": len(metrics),
            **{status: sum(1 for m in metrics if m["status"] == status) for status in ("unavailable", "warn", "critical")},
        },
        "highlights": highlights,
        "groups": [{"name": name, "metrics": groups[name]} for name in sorted(groups)],
        "order": keys,
        "history": {
            "timestamps": [s.get("timestamp") for s in window],
            "series": {key: [_number((s.get("values") or {}).get(key)) for s in window] for key in keys},
        },
    }
