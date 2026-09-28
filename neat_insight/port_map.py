import ipaddress
import json
import logging
import os
import re
from pathlib import Path
from typing import Iterable, Optional


_HOST = re.compile(r"(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9_.-]+))(?::(\d{1,5}))?")
_HOST_LABEL = re.compile(r"[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?")


def browser_host(host_header) -> Optional[str]:
    match = _HOST.fullmatch(str(host_header or "").strip())
    if not match or (match[3] and not valid_port(match[3])):
        return None
    if match[1]:
        try:
            return match[1] if ipaddress.ip_address(match[1]).version == 6 else None
        except ValueError:
            return None
    name = match[2]
    labels = name[:-1].split(".") if name.endswith(".") else name.split(".")
    return name if len(name) <= 253 and all(_HOST_LABEL.fullmatch(label) for label in labels) else None


def format_browser_https_url(host, port, path="", query=""):
    if not host or not port:
        return None
    try:
        if ipaddress.ip_address(host).version == 6:
            host = f"[{host}]"
    except ValueError:
        logging.debug("Host '%s' is not an IP literal; using host value as-is", host)

    url = f"https://{host}:{port}{path}"
    return f"{url}?{query}" if query else url


def coerce_port_value(value):
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def port_protocol(name_parts, value):
    protocol = value.get("protocol")
    if protocol:
        return str(protocol)
    if name_parts and str(name_parts[-1]).lower() in {"tcp", "udp"}:
        return str(name_parts[-1]).lower()
    return ""


def collect_port_map_rows(name_parts, value, rows):
    if not isinstance(value, dict):
        return

    name = ".".join(name_parts)
    protocol = port_protocol(name_parts, value)
    if "host" in value:
        rows.append(
            {
                "hostPortEnd": None,
                "hostPortStart": coerce_port_value(value.get("host")),
                "name": name,
                "protocol": protocol,
            }
        )
        return

    if "hostStart" in value or "hostEnd" in value:
        rows.append(
            {
                "hostPortEnd": coerce_port_value(value.get("hostEnd")),
                "hostPortStart": coerce_port_value(value.get("hostStart")),
                "name": name,
                "protocol": protocol,
            }
        )
        return

    for key, child in value.items():
        collect_port_map_rows([*name_parts, str(key)], child, rows)


def port_map_candidates() -> Iterable[Path]:
    paths = []
    configured = os.getenv("NEAT_PORT_MAP_FILE", "").strip()
    if configured:
        paths.append(Path(configured))

    paths.extend(
        [
            Path.home() / ".insight-config" / "neat-port-map.json",
            Path("/workspace/.insight-config/neat-port-map.json"),
            Path("/workspace/insight-config/neat-port-map.json"),
            Path("/insight-config/neat-port-map.json"),
        ]
    )

    for parent in (Path("/home"), Path("/Users")):
        try:
            paths.extend(user_dir / ".insight-config" / "neat-port-map.json" for user_dir in parent.iterdir() if user_dir.is_dir())
        except OSError as exc:
            logging.debug("Skipping port map search under %s: %s", parent, exc)

    yield from dict.fromkeys(paths)


def iter_neat_port_maps(candidates=None):
    for path in port_map_candidates() if candidates is None else candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logging.debug("Failed to read neat port map %s: %s", path, exc)
            continue

        if isinstance(data, dict):
            if data:
                yield data
            continue
        logging.warning("Ignoring neat port map %s because its root is not an object", path)


def read_exposed_ports(port_maps=None):
    for data in iter_neat_port_maps() if port_maps is None else port_maps:
        rows = []
        for key, value in data.items():
            collect_port_map_rows([str(key)], value, rows)
        if rows:
            return rows
    return []


def valid_port(value) -> Optional[int]:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return None
    return port if 1 <= port <= 65535 else None


def find_exposed_entry(ports, name, protocol=None):
    for port in ports:
        if not isinstance(port, dict):
            continue
        row_name = str(port.get("name") or "")
        if row_name != name and not row_name.startswith(f"{name}."):
            continue
        if protocol:
            row_protocol = str(port.get("protocol") or "").lower()
            if row_protocol and row_protocol != protocol.lower():
                continue
        if valid_port(port.get("hostPortStart")):
            return port
    return None
