import hashlib
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from flask import current_app

from neat_insight.board.errors import BoardError
from neat_insight.board.target import BoardTarget, TargetStore, resolve_target, sdk_env_target, validate_ssh_target
from neat_insight.board.transport import LocalTransport, SshTransport, key_fingerprint

IDENTITY_TIMEOUT_SEC = 15.0
_IDENTITY_SCRIPT = "hostname; echo @@; cat /etc/machine-id; echo @@; cat /etc/build /etc/buildinfo"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_board_manager() -> "BoardManager":
    return current_app.extensions["neat_board"]


class _ReportingTransport:
    """Records connection-level failures in the manager's status before re-raising them."""

    def __init__(self, manager: "BoardManager", generation: int, transport):
        self._manager = manager
        self._generation = generation
        self._transport = transport

    def exec(self, argv, *, timeout, stdin=None):
        try:
            return self._transport.exec(argv, timeout=timeout, stdin=stdin)
        except BoardError as exc:
            self._manager._record(self._generation, error=exc)
            raise


class BoardSession:
    def __init__(self, manager: "BoardManager", target: BoardTarget, generation: int, transport):
        self.target = target
        self.generation = generation
        self.raw_transport = transport
        self.transport = _ReportingTransport(manager, generation, transport)
        self._manager = manager
        self._identity: Optional[dict] = None
        self._lock = threading.Lock()

    def identity(self) -> dict:
        with self._lock:
            if self._identity is None:
                result = self.transport.exec(["sh", "-c", _IDENTITY_SCRIPT], timeout=IDENTITY_TIMEOUT_SEC)
                self._identity = self._parse_identity(result.stdout.decode("utf-8", errors="replace"))
                self._manager._record(self.generation, board=self._identity)
            return self._identity

    def _parse_identity(self, text: str) -> dict:
        hostname, machine_id, build = (text.split("@@", 2) + ["", ""])[:3]
        fields = {}
        for line in build.splitlines():
            key, sep, value = line.partition("=")
            if sep:
                fields[key.strip()] = value.strip()
        host_key = self.raw_transport.remote_host_key_fingerprint()
        seed = f"{machine_id.strip() or hostname.strip()}|{host_key or 'local'}"
        return {
            "hostname": hostname.strip() or None,
            "machine": fields.get("MACHINE"),
            "build_version": fields.get("SIMA_BUILD_VERSION"),
            "fingerprint": hashlib.sha256(seed.encode()).hexdigest()[:16],
        }


class BoardManager:
    """Owns the single selected board that every board-facing Insight feature uses."""

    def __init__(self, data_dir: Path, on_board: bool):
        self.data_dir = Path(data_dir)
        self.on_board = on_board
        self._store = TargetStore(self.data_dir / "board-target.json")
        self._known_hosts = self.data_dir / "known_hosts"
        self._lock = threading.RLock()
        self._generation = 0
        self._session: Optional[BoardSession] = None
        self._status = {"state": "unknown", "checked_at": None, "error": None}
        self._board: Optional[dict] = None

    def target(self) -> Optional[BoardTarget]:
        return resolve_target(self._store.load(), self.on_board, sdk_env_target())

    def session(self) -> BoardSession:
        with self._lock:
            target = self.target()
            if target is None:
                raise BoardError(
                    "no_target",
                    "No board is selected.",
                    hint="Enter the board's address, pair the SDK with `sima-cli sdk setup --devkit <ip>`, "
                    "or run Insight on the board.",
                )
            self._replace_session(target)
            return self._session

    def select(self, host, port, user) -> None:
        with self._lock:
            self._store.save(validate_ssh_target(host, port, user))
            self._replace_session(self.target())

    def reset(self) -> None:
        with self._lock:
            self._store.clear()
            self._replace_session(self.target())

    def test(self) -> None:
        session = self.session()
        with session._lock:
            session._identity = None
        session.identity()

    def trust_host_key(self, fingerprint: str) -> None:
        with self._lock:
            transport = self.session().raw_transport
            key = getattr(transport, "presented_host_key", None)
            if key is None or key_fingerprint(key) != fingerprint:
                raise BoardError(
                    "invalid_request",
                    "That host key is not the one the board presented.",
                    hint="Test the connection again and confirm the fingerprint it reports.",
                )
            transport.replace_host_key(key)
            self._replace_session(self.target())

    def state(self) -> dict:
        with self._lock:
            target = self.target()
            self._replace_session(target)
            sdk_env = sdk_env_target()
            return {
                "target": target.to_dict() if target else None,
                "saved": self._store.load(),
                "defaults": {"on_board": self.on_board, "sdk_env": sdk_env},
                "generation": self._generation,
                "status": dict(self._status),
                "board": self._board,
            }

    def _replace_session(self, target: Optional[BoardTarget]) -> None:
        if (self._session.target if self._session else None) == target:
            return
        if self._session is not None:
            self._session.raw_transport.close()
        self._generation += 1
        self._status = {"state": "unknown", "checked_at": None, "error": None}
        self._board = None
        self._session = None
        if target is not None:
            if target.mode == "local":
                transport = LocalTransport()
            else:
                transport = SshTransport(target.host, target.port, target.user, self._known_hosts)
            self._session = BoardSession(self, target, self._generation, transport)

    def _record(self, generation: int, board: Optional[dict] = None, error: Optional[BoardError] = None) -> None:
        with self._lock:
            if generation != self._generation:
                return
            if error is not None:
                self._status = {"state": "error", "checked_at": _now(), "error": error.to_dict()}
            else:
                self._status = {"state": "connected", "checked_at": _now(), "error": None}
                self._board = board
