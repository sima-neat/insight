"""Relay from Insight to the GenAI Studio backend on a board.

The GenAI tab calls ``/api/genai/<path>`` on Insight; this blueprint forwards the
request to the Studio backend started with ``run.sh --backend-only``
(``https://<board>:5000/<path>`` by default) and streams the answer back. The
browser therefore talks to one HTTPS origin: it never has to accept the board's
self-signed certificate, and the board needs no CORS allowlist.

Only the Studio's API prefixes are forwarded, and never ``/shutdown``. The board
address lives in Insight's ``cfg.json`` under ``"genai"``.
"""

from __future__ import annotations

import http.client
import json
import os
import ssl
import tempfile
import urllib.parse
from pathlib import Path
from typing import Optional

from flask import Blueprint, Response, jsonify, request, stream_with_context

from neat_insight.utils import get_devkit_sync_devkit_ip, init_environment, is_sima_board

genai_bp = Blueprint("genai", __name__)

STUDIO_PORT = 5000
CFG_SECTION = "genai"

# Studio backend-only API surface (apps: neat-genai-studio/src/python/ui/backend_mode.py),
# minus /shutdown: Insight must never stop the board's backend.
_ALLOWED_EXACT = ("health", "voices")
_ALLOWED_PREFIXES = (
    "v1/",
    "audio/",
    "models/",
    "benchmark/",
    "tts/",
    "piperplus/",
    "supertonic/",
    "voices/",
)
# Quick status calls fail fast so the tab can show "unavailable"; model loads,
# downloads and streamed replies can legitimately run for minutes.
_QUICK_PATHS = ("health", "models/status", "models/catalog")
_QUICK_TIMEOUT_S = 5.0
_LONG_TIMEOUT_S = 900.0
_STREAM_CHUNK = 64 * 1024

_REQUEST_HEADERS = ("Content-Type", "Accept", "Last-Event-ID")
_RESPONSE_HEADERS = ("Content-Type", "Content-Disposition", "Cache-Control")


def _cfg_path() -> Path:
    return Path(init_environment()["NEAT_INSIGHT_DATA"]) / "cfg.json"


def _json_error(message: str, status: int, reason: str):
    return jsonify({"error": message, "reason": reason}), status


def _read_cfg() -> dict:
    path = _cfg_path()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_cfg(data: dict) -> None:
    path = _cfg_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write a sibling temp file and rename, so a crash never leaves a half-written
    # cfg.json (it also holds the remote-devkit settings).
    fd, tmp = tempfile.mkstemp(prefix=".cfg-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _section() -> dict:
    section = _read_cfg().get(CFG_SECTION)
    return section if isinstance(section, dict) else {}


def default_board_url() -> str:
    """The Studio backend Insight connects to when no address is configured."""
    if is_sima_board():
        return f"https://127.0.0.1:{STUDIO_PORT}"
    try:
        devkit_ip = get_devkit_sync_devkit_ip()
    except RuntimeError:
        devkit_ip = ""
    if devkit_ip:
        host = f"[{devkit_ip}]" if ":" in devkit_ip else devkit_ip
        return f"https://{host}:{STUDIO_PORT}"
    return ""


def board_url() -> str:
    configured = _section().get("url")
    return configured if isinstance(configured, str) and configured else default_board_url()


def _normalize_url(raw: str) -> Optional[str]:
    """``scheme://host[:port]`` for an http(s) URL with a host, else None."""
    parts = urllib.parse.urlsplit(raw.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    if parts.path not in ("", "/") or parts.query or parts.fragment or parts.username:
        return None
    try:
        parts.port
    except ValueError:
        return None
    return f"{parts.scheme}://{parts.netloc}"


def is_allowed_path(subpath: str) -> bool:
    """True for the Studio API paths the relay forwards."""
    if not subpath or subpath.startswith("/"):
        return False
    segments = subpath.split("/")
    if any(segment in ("", ".", "..") for segment in segments[:-1]) or segments[-1] in (".", ".."):
        return False
    return subpath in _ALLOWED_EXACT or subpath.startswith(_ALLOWED_PREFIXES)


@genai_bp.get("/api/genai/settings")
def get_genai_settings():
    """Board address in use, and whether it was configured or derived."""
    section = _section()
    configured = section.get("url") if isinstance(section.get("url"), str) else ""
    return jsonify(
        {
            "url": board_url(),
            "configuredUrl": configured or None,
            "defaultUrl": default_board_url() or None,
        }
    )


@genai_bp.post("/api/genai/settings")
def set_genai_settings():
    """Set or clear the board address (an empty string clears it)."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _json_error("Expected a JSON object.", 400, "bad-request")

    data = _read_cfg()
    section = data.get(CFG_SECTION) if isinstance(data.get(CFG_SECTION), dict) else {}

    if "url" in payload:
        raw = payload["url"]
        if not isinstance(raw, str):
            return _json_error("'url' must be a string.", 400, "bad-request")
        if raw.strip():
            url = _normalize_url(raw)
            if url is None:
                return _json_error(
                    "'url' must look like https://<board>:5000 (scheme, host and optional port only).",
                    400,
                    "bad-request",
                )
            section["url"] = url
        else:
            section.pop("url", None)

    data[CFG_SECTION] = section
    _write_cfg(data)
    return get_genai_settings()


@genai_bp.route("/api/genai/<path:subpath>", methods=["GET", "POST"])
def relay_to_board(subpath: str):
    """Forward a GenAI Studio API call to the board and stream the answer back."""
    if not is_allowed_path(subpath):
        return _json_error(f"/{subpath} is not a GenAI Studio API path Insight relays.", 404, "not-relayed")

    base = board_url()
    if not base:
        return _json_error(
            "No GenAI Studio board is configured. Set its address in the GenAI tab's settings.",
            503,
            "not-configured",
        )

    target = urllib.parse.urlsplit(base)
    path = "/" + subpath
    if request.query_string:
        path += "?" + request.query_string.decode("latin-1")

    headers = {name: request.headers[name] for name in _REQUEST_HEADERS if name in request.headers}
    body = request.get_data(cache=False) if request.method == "POST" else None

    timeout = _QUICK_TIMEOUT_S if subpath in _QUICK_PATHS else _LONG_TIMEOUT_S
    if target.scheme == "https":
        # The Studio's certificate is self-signed per board; trust is placed in the
        # configured address, as for Insight's local vf stats.
        conn = http.client.HTTPSConnection(
            target.hostname, target.port or 443, timeout=timeout, context=ssl._create_unverified_context()
        )
    else:
        conn = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=timeout)

    try:
        conn.request(request.method, path, body=body, headers=headers)
        upstream = conn.getresponse()
    except (OSError, http.client.HTTPException) as exc:
        conn.close()
        return _json_error(f"GenAI Studio backend unreachable at {base}: {exc}", 502, "unreachable")

    def stream():
        try:
            while True:
                chunk = upstream.read1(_STREAM_CHUNK)
                if not chunk:
                    break
                yield chunk
        except (OSError, http.client.HTTPException):
            # The board went away mid-stream; end the response so the tab can
            # notice the truncation and poll /health.
            return
        finally:
            conn.close()

    response = Response(stream_with_context(stream()), status=upstream.status, direct_passthrough=True)
    for name in _RESPONSE_HEADERS:
        value = upstream.getheader(name)
        if value:
            response.headers[name] = value
    for name, value in upstream.getheaders():
        if name.lower().startswith("x-"):
            response.headers[name] = value
    response.headers["X-Accel-Buffering"] = "no"
    return response
