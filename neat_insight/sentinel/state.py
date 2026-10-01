"""Per-board caches for the Sentinel endpoints, keyed by (board generation, fingerprint)."""
import re
import threading
import time
from collections import deque
from datetime import datetime
from typing import Optional

HISTORY_LIMIT = 240
# Sparklines space points evenly, so samples further apart than this are not one trend.
HISTORY_GAP_SEC = 60.0
IDENTITY_TTL_SEC = 30.0
DEFINITIONS_TTL_SEC = 60.0
STATUS_TTL_SEC = 10.0

_FRACTION = re.compile(r"\.(\d{1,9})")


def moment(timestamp) -> Optional[datetime]:
    if not isinstance(timestamp, str) or not timestamp.strip():
        return None
    text = timestamp.strip()
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"
    text = _FRACTION.sub(lambda match: "." + match.group(1)[:6], text, count=1)
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


class BoardCache:

    def __init__(self, history_limit: int = HISTORY_LIMIT, history_gap_sec: float = HISTORY_GAP_SEC):
        self.history_limit = history_limit
        self.history_gap_sec = history_gap_sec
        self._lock = threading.Lock()
        self._key = None
        self._values = {}
        self._history = deque(maxlen=history_limit)
        self._seeded = False
        self._daemon_instance = None
        self._identity = {}

    def identity(self, session, ttl: float = IDENTITY_TTL_SEC) -> dict:
        with self._lock:
            cached = self._identity.get(session.generation)
            if cached and time.monotonic() - cached[0] < ttl:
                return cached[1]
        identity = session.identity()
        with self._lock:
            self._identity = {session.generation: (time.monotonic(), identity)}
        return identity

    def key(self, session, identity: dict):
        return (session.generation, identity.get("fingerprint"))

    def get(self, key, name: str):
        with self._lock:
            if key != self._key:
                return None
            entry = self._values.get(name)
            return entry[1] if entry and entry[0] > time.monotonic() else None

    def record(self, key, name: str, value, ttl: float):
        with self._lock:
            self._reset_unlocked(key)
            self._values[name] = (time.monotonic() + ttl, value)
        return value

    def observe_daemon(self, key, instance_id) -> None:
        """Start a fresh history when systemd reports another daemon invocation."""
        with self._lock:
            self._reset_unlocked(key)
            if instance_id != self._daemon_instance:
                self._history = deque(maxlen=self.history_limit)
                self._seeded = False
                self._daemon_instance = instance_id

    def add_sample(self, key, sample: Optional[dict]) -> list:
        with self._lock:
            self._reset_unlocked(key)
            timestamp = (sample or {}).get("timestamp")
            if not timestamp or (self._history and self._history[-1]["timestamp"] == timestamp):
                return list(self._history)
            if self._history:
                previous, current = moment(self._history[-1].get("timestamp")), moment(timestamp)
                if previous and current and abs((current - previous).total_seconds()) > self.history_gap_sec:
                    self._history.clear()
                    self._seeded = False
            self._history.append(sample)
            return list(self._history)

    def needs_seed(self, key) -> bool:
        with self._lock:
            return key != self._key or not self._seeded

    def seed(self, key, samples: list) -> list:
        """Put the daemon's older samples before the polled ones, when they join them without a gap."""
        with self._lock:
            self._reset_unlocked(key)
            self._seeded = True
            oldest = moment(self._history[0]["timestamp"]) if self._history else None
            earlier = []
            for sample in samples:
                at = moment(sample.get("timestamp"))
                if at is not None and (oldest is None or at < oldest):
                    earlier.append((at, sample))
            earlier.sort(key=lambda pair: pair[0])
            if earlier and oldest is not None and (oldest - earlier[-1][0]).total_seconds() > self.history_gap_sec:
                earlier = []
            merged = [sample for _, sample in earlier] + list(self._history)
            self._history = deque(merged[-self.history_limit:], maxlen=self.history_limit)
            return list(self._history)

    def _reset_unlocked(self, key) -> None:
        if key != self._key:
            self._key = key
            self._values = {}
            self._history = deque(maxlen=self.history_limit)
            self._seeded = False
            self._daemon_instance = None
