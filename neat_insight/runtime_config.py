from __future__ import annotations

import ipaddress
import logging
import os
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional


INSIGHT_CONFIG_DIR = Path("/home/docker/.insight-config")
BROWSER_ICE_ADDRESS_FILE = INSIGHT_CONFIG_DIR / "browser-ice-address"
LAUNCH_URL_FILE = INSIGHT_CONFIG_DIR / "launch-url"
URL_ROUTING_FILE = INSIGHT_CONFIG_DIR / "url-routing"


@dataclass(frozen=True)
class RuntimeNetworkConfig:
    browser_ice_address: Optional[str]
    browser_ice_address_source: str
    public_origin: Optional[str]


def _read_optional_single_value(path: Path) -> Optional[str]:
    try:
        value = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except UnicodeError as exc:
        raise RuntimeError(f"failed to decode Insight configuration file {path} as UTF-8") from exc
    except OSError as exc:
        raise RuntimeError(f"failed to read Insight configuration file {path}: {exc}") from exc

    lines = value.splitlines()
    if len(lines) != 1 or not lines[0].strip():
        raise RuntimeError(f"Insight configuration file {path} must contain exactly one non-empty line")
    return lines[0].strip()


def _validated_browser_ice_address(value: str, *, source: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise RuntimeError(f"{source} must contain a valid IPv4 address, got: {value!r}") from exc

    if address.version != 4:
        raise RuntimeError(f"{source} must contain an IPv4 address, got: {value!r}")
    if (
        address.is_loopback
        or address.is_unspecified
        or address.is_multicast
        or address.is_link_local
        or address.is_reserved
    ):
        raise RuntimeError(f"{source} must contain a browser-reachable unicast IPv4 address, got: {value!r}")
    return str(address)


def _validated_public_origin(value: str, *, source: str) -> str:
    if any(ord(char) <= 32 or ord(char) == 127 for char in value):
        raise RuntimeError(f"{source} must not contain whitespace or control characters")

    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError(f"{source} must contain a valid HTTP(S) URL") from exc

    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError(f"{source} must contain an absolute HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise RuntimeError(f"{source} must not contain credentials")

    hostname = parsed.hostname
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        if "%" in hostname or re.fullmatch(r"[0-9.]+", hostname):
            raise RuntimeError(f"{source} contains an invalid hostname")
        try:
            hostname = hostname.encode("ascii").decode("ascii").lower()
        except UnicodeEncodeError as exc:
            raise RuntimeError(f"{source} contains an invalid hostname") from exc
        labels = hostname.rstrip(".").split(".")
        if (
            not hostname
            or len(hostname.rstrip(".")) > 253
            or any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in labels
            )
        ):
            raise RuntimeError(f"{source} contains an invalid hostname")
    else:
        hostname = str(address)
        if address.version == 6:
            hostname = f"[{hostname}]"

    if port == 0:
        raise RuntimeError(f"{source} contains an invalid port")
    authority = hostname if port is None else f"{hostname}:{port}"
    return f"{parsed.scheme.lower()}://{authority}/"


def legacy_runtime_network_config(environ: Optional[Mapping[str, str]] = None) -> RuntimeNetworkConfig:
    """Preserve the pre-file CONTAINER_HOST_IP selection exactly."""
    environ = os.environ if environ is None else environ
    container_host_ip = environ.get("CONTAINER_HOST_IP", "").strip()
    if container_host_ip:
        try:
            address = ipaddress.ip_address(container_host_ip)
            browser_ice_address = (
                str(address) if not address.is_loopback and not address.is_unspecified else None
            )
        except ValueError:
            browser_ice_address = None
    else:
        browser_ice_address = None

    return RuntimeNetworkConfig(
        browser_ice_address=browser_ice_address,
        browser_ice_address_source="CONTAINER_HOST_IP" if browser_ice_address else "none",
        public_origin=None,
    )


def load_runtime_network_config(
    *,
    browser_ice_address_file: Path = BROWSER_ICE_ADDRESS_FILE,
    launch_url_file: Path = LAUNCH_URL_FILE,
    url_routing_file: Path = URL_ROUTING_FILE,
    environ: Optional[Mapping[str, str]] = None,
) -> RuntimeNetworkConfig:
    """Resolve browser-facing configuration once for the lifetime of the process."""
    environ = os.environ if environ is None else environ

    browser_ice_value = _read_optional_single_value(browser_ice_address_file)
    if browser_ice_value is not None:
        browser_ice_address = _validated_browser_ice_address(
            browser_ice_value,
            source=str(browser_ice_address_file),
        )
        browser_ice_address_source = "browser-ice-address"
    else:
        legacy = legacy_runtime_network_config(environ)
        browser_ice_address = legacy.browser_ice_address
        browser_ice_address_source = legacy.browser_ice_address_source

    # Existing hosted environments use launch-url as a shared proxy origin.
    # Direct SDK launches can retain that file for launch surfaces while opting
    # out of shared-origin routing for the viewer, WHIP, and MJPEG endpoints.
    routing = _read_optional_single_value(url_routing_file) or "proxy"
    if routing not in {"direct", "proxy"}:
        raise RuntimeError(f"{url_routing_file} must contain 'direct' or 'proxy'")

    try:
        launch_url_value = _read_optional_single_value(launch_url_file) if routing == "proxy" else None
        public_origin = (
            _validated_public_origin(launch_url_value, source=str(launch_url_file))
            if launch_url_value is not None
            else None
        )
    except RuntimeError as exc:
        # launch-url is also consumed by SDK launch surfaces and can be a full
        # browser URL. It is advisory to Insight: malformed values must not
        # take down media service readiness or change the legacy URL fallback.
        logging.warning("Ignoring Insight launch URL configuration: %s", exc)
        public_origin = None

    return RuntimeNetworkConfig(
        browser_ice_address=browser_ice_address,
        browser_ice_address_source=browser_ice_address_source,
        public_origin=public_origin,
    )
