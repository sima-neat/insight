"""Per-board caches for the Sentinel endpoints.

Everything cached is keyed by (board generation, board fingerprint), exactly as the
Peripherals scan cache is: selecting another board — or the same address turning out to
be another board — starts empty instead of mixing two boards' telemetry. History is
bounded, so polling cannot grow it without limit.
"""
import threading
import time
from collections import deque
from typing import Optional

# ~8 minutes of history at Sentinel's two-second cadence.
HISTORY_LIMIT = 240
IDENTITY_TTL_SEC = 30.0
DEFINITIONS_TTL_SEC = 60.0
STATUS_TTL_SEC = 10.0


class BoardCache:
    """The newest board's cached values and sample history; another board replaces it."""

    def __init__(self, history_limit: int = HISTORY_LIMIT):
        self.history_limit = history_limit
        self._lock = threading.Lock()
        self._key = None
        self._values = {}
        self._history = deque(maxlen=history_limit)
        self._identity = {}

    def identity(self, session, ttl: float = IDENTITY_TTL_SEC) -> dict:
        """The board identity for this session, re-read at most every `ttl` seconds."""
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
        """A value stored for this board that has not expired yet, or None."""
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

    def add_sample(self, key, sample: Optional[dict]) -> list:
        """Append one Sentinel sample to this board's bounded history and return the history."""
        with self._lock:
            self._reset_unlocked(key)
            timestamp = (sample or {}).get("timestamp")
            if sample and timestamp and (not self._history or self._history[-1]["timestamp"] != timestamp):
                self._history.append(sample)
            return list(self._history)

    def history(self, key) -> list:
        with self._lock:
            return list(self._history) if key == self._key else []

    def _reset_unlocked(self, key) -> None:
        if key != self._key:
            self._key = key
            self._values = {}
            self._history = deque(maxlen=self.history_limit)
