import json
import logging
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

from neat_insight.board.errors import BoardError
from neat_insight.utils import get_devkit_sync_devkit_ip

DEFAULT_SSH_PORT = 22
DEFAULT_SSH_USER = "sima"

_HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,252})$")
_USER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$")


@dataclass(frozen=True)
class BoardTarget:
    mode: str  # "local" or "ssh"
    source: str  # "manual", "on-board", or "sdk-env"
    host: Optional[str] = None
    port: Optional[int] = None
    user: Optional[str] = None

    @property
    def label(self) -> str:
        if self.mode == "local":
            return "This board"
        suffix = f":{self.port}" if self.port != DEFAULT_SSH_PORT else ""
        return f"{self.user}@{self.host}{suffix}"

    def to_dict(self) -> dict:
        return {**asdict(self), "label": self.label}


def validate_ssh_target(host, port=DEFAULT_SSH_PORT, user=DEFAULT_SSH_USER) -> dict:
    host = str(host or "").strip()
    user = str(user or DEFAULT_SSH_USER).strip()
    if not _HOST_RE.match(host):
        raise BoardError("invalid_request", "Enter the board's IP address or host name.", hint="For example 192.168.2.2")
    try:
        port = int(port if port not in (None, "") else DEFAULT_SSH_PORT)
    except (TypeError, ValueError):
        port = 0
    if not 1 <= port <= 65535:
        raise BoardError("invalid_request", "The SSH port must be between 1 and 65535.", hint="DevKits use port 22.")
    if not _USER_RE.match(user):
        raise BoardError("invalid_request", "Enter a valid SSH user name.", hint="DevKits use the 'sima' account.")
    return {"host": host, "port": port, "user": user}


def sdk_env_target() -> Optional[dict]:
    """The DevKit paired through `sima-cli sdk setup` / devkit.sh, exported as DEVKIT_SYNC_* variables."""
    try:
        host = get_devkit_sync_devkit_ip() or (os.getenv("SIMA_DEVKIT_IP") or "").strip()
    except RuntimeError as exc:
        logging.warning("Ignoring SDK DevKit target from the environment: %s", exc)
        return None
    if not host:
        return None
    try:
        return validate_ssh_target(
            host,
            os.getenv("DEVKIT_SYNC_DEVKIT_PORT") or DEFAULT_SSH_PORT,
            os.getenv("DEVKIT_SYNC_DEVKIT_USER") or DEFAULT_SSH_USER,
        )
    except BoardError as exc:
        logging.warning("Ignoring SDK DevKit target from the environment: %s", exc.message)
        return None


def resolve_target(saved: Optional[dict], on_board: bool, sdk_env: Optional[dict]) -> Optional[BoardTarget]:
    if saved:
        return BoardTarget("ssh", "manual", saved["host"], saved["port"], saved["user"])
    if on_board:
        return BoardTarget("local", "on-board")
    if sdk_env:
        return BoardTarget("ssh", "sdk-env", sdk_env["host"], sdk_env["port"], sdk_env["user"])
    return None


class TargetStore:
    """Persists the manually selected board. Holds no credentials; SSH keys authenticate."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def load(self) -> Optional[dict]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return validate_ssh_target(data.get("host"), data.get("port"), data.get("user"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError, AttributeError, BoardError) as exc:
            logging.warning("Ignoring unreadable board selection %s: %s", self.path, exc)
            return None

    def save(self, target: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(target, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)
