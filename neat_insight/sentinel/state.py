"""Per-board caches for the Sentinel endpoints.

Everything cached is keyed by (board generation, board fingerprint), exactly as the
Peripherals scan cache is: selecting another board — or the same address turning out to
be another board — starts empty instead of mixing two boards' telemetry. History is
bounded, so polling cannot grow it without limit.
"""
import re
import threading
import time
from collections import deque
from datetime import datetime
from typing import Optional

# ~8 minutes of history at Sentinel's two-second cadence.
HISTORY_LIMIT = 240
# The history is bounded by sample count, not by time, and nothing polls it while the
# Stats page is closed. Sentinel samples every two seconds and Insight's slowest backed-off
# poll is 30 seconds, so a longer gap than this means nobody was watching, not that the
# board went quiet. The samples either side of such a gap are not one trend: the sparklines
# draw their points evenly spaced, so splicing them would show an hours-old value and the
# current one as two neighbouring moments. A gap starts the history again instead.
HISTORY_GAP_SEC = 60.0
IDENTITY_TTL_SEC = 30.0
DEFINITIONS_TTL_SEC = 60.0
STATUS_TTL_SEC = 10.0

# Sentinel stamps a sample in RFC 3339 with nanoseconds, e.g. 2026-09-23T19:39:58.301197766Z.
_FRACTION = re.compile(r"\.(\d{1,9})")


def moment(timestamp) -> Optional[datetime]:
    """One Sentinel timestamp as a datetime, or None when it cannot be read."""
    if not isinstance(timestamp, str) or not timestamp.strip():
        return None
    text = timestamp.strip()
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"
    # datetime only carries microseconds; the daemon's extra digits are dropped, not rounded.
    text = _FRACTION.sub(lambda match: "." + match.group(1)[:6], text, count=1)
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


class BoardCache:
    """The newest board's cached values and sample history; another board replaces it."""

    def __init__(self, history_limit: int = HISTORY_LIMIT, history_gap_sec: float = HISTORY_GAP_SEC):
        self.history_limit = history_limit
        self.history_gap_sec = history_gap_sec
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
        """Append one Sentinel sample to this board's bounded history and return the history.

        A sample far enough from the last one that nothing was watching in between starts
        the history again, so a sparkline never draws a gap of hours as one step.
        """
        with self._lock:
            self._reset_unlocked(key)
            timestamp = (sample or {}).get("timestamp")
            if not sample or not timestamp or (self._history and self._history[-1]["timestamp"] == timestamp):
                return list(self._history)
            if self._interrupted_unlocked(timestamp):
                self._history.clear()
            self._history.append(sample)
            return list(self._history)

    def _interrupted_unlocked(self, timestamp: str) -> bool:
        """Whether this sample and the last one are too far apart to be one trend."""
        if not self._history:
            return False
        previous, current = moment(self._history[-1].get("timestamp")), moment(timestamp)
        # An unreadable timestamp is not evidence of a gap; keep the history as it was.
        if previous is None or current is None:
            return False
        return abs((current - previous).total_seconds()) > self.history_gap_sec

    def history(self, key) -> list:
        with self._lock:
            return list(self._history) if key == self._key else []

    def _reset_unlocked(self, key) -> None:
        if key != self._key:
            self._key = key
            self._values = {}
            self._history = deque(maxlen=self.history_limit)
