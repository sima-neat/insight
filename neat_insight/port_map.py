"""Shared parsing for SDK port maps and browser-facing Insight URLs."""

import ipaddress
import json
import logging
import os
import re
from pathlib import Path
from typing import Iterable, Optional


def request_host_name(host_header: str) -> str:
    """Return the hostname from an HTTP Host header, preserving IPv6 literals."""
    host = str(host_header or "").strip()
    if host.startswith("["):
        end = host.find("]")
        if end > 0:
            return host[1:end]
    elif host.count(":") == 1:
        name, maybe_port = host.rsplit(":", 1)
        if maybe_port.isdigit():
            host = name
    return host or "127.0.0.1"


_HOST_LABEL = re.compile(r"^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$")


def browser_host(host_header) -> Optional[str]:
    """The hostname from a Host header when it is a plain hostname or IP literal, else None.

    A viewer URL built from the Host header points the browser at that origin, so anything but
    `name[:port]`, `a.b.c.d[:port]` or `[v6][:port]` is refused rather than echoed into a URL.
    """
    host = str(host_header or "").strip()
    if not host:
        return None
    port = None
    if host.startswith("["):
        end = host.find("]")
        if end < 0:
            return None
        name, rest = host[1:end], host[end + 1:]
        if rest:
            if not rest.startswith(":"):
                return None
            port = rest[1:]
        try:
            if ipaddress.ip_address(name).version != 6:
                return None
        except ValueError:
            return None
    else:
        name = host
        if ":" in host:
            name, port = host.rsplit(":", 1)
            if ":" in name:
                return None
        if not _is_hostname(name):
            return None
    if port is not None and not (port.isdigit() and valid_port(port)):
        return None
    return name


def _is_hostname(name: str) -> bool:
    try:
        return ipaddress.ip_address(name).version == 4
    except ValueError:
        pass
    labels = name[:-1].split(".") if name.endswith(".") else name.split(".")
    return 0 < len(name) <= 253 and all(_HOST_LABEL.match(label) for label in labels)


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
    """Flatten the canonical nested map into the public exposedPorts row shape."""
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

    seen = set()
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        yield path


def iter_neat_port_maps(candidates=None):
    for path in port_map_candidates() if candidates is None else candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001 - one bad candidate must not hide later valid maps
            logging.debug("Failed to read neat port map %s: %s", path, exc)
            continue

        if isinstance(data, dict):
            if data:
                yield data
            continue
        logging.warning("Ignoring neat port map %s because its root is not an object", path)


def read_neat_port_map(port_maps=None):
    for data in iter_neat_port_maps() if port_maps is None else port_maps:
        if "insightVideoChannels" in data:
            return data
    return {}


def read_exposed_ports(port_maps=None):
    for data in iter_neat_port_maps() if port_maps is None else port_maps:
        exposed = data.get("exposedPorts")
        if isinstance(exposed, list):
            rows = [dict(row) for row in exposed if isinstance(row, dict)]
        else:
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
    if not isinstance(ports, list):
        return None
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


def find_exposed_port(ports, name, protocol=None):
    entry = find_exposed_entry(ports, name, protocol)
    return valid_port(entry.get("hostPortStart")) if entry else None
