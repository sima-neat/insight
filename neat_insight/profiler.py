import json
import logging
import os
import queue
import re
import threading
import time
from typing import Callable, Dict, Generator, Optional

try:
    import zmq
except Exception:  # pragma: no cover - runtime dependency can be optional in some environments
    zmq = None


class NeatMetricsBroker:
    def __init__(self, endpoint: Optional[str] = None):
        self.endpoint = endpoint or os.getenv("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://*:5557")
        self._ctx = None
        self._thread = None
        self._stop_evt = threading.Event()
        self._subscribers = set()
        self._subs_lock = threading.Lock()
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        if zmq is None:
            logging.warning("pyzmq is not available; /neat-metrics stream will be inactive.")
            return

        self._ctx = zmq.Context.instance()
        self._thread = threading.Thread(target=self._run, name="neat-metrics-zmq", daemon=True)
        self._thread.start()
        logging.info("NEAT metrics subscriber started on %s", self.endpoint)

    def stop(self) -> None:
        self._stop_evt.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)

    def subscribe(self) -> Generator[Dict, None, None]:
        q = queue.Queue(maxsize=300)
        with self._subs_lock:
            self._subscribers.add(q)

        try:
            yield {
                "type": "status",
                "state": "connected" if zmq is not None else "missing_dependency",
                "endpoint": self.endpoint,
            }
            while not self._stop_evt.is_set():
                try:
                    msg = q.get(timeout=1.0)
                    yield msg
                except queue.Empty:
                    # Keep SSE alive.
                    yield {"type": "heartbeat", "timestamp_ms": int(time.time() * 1000)}
        finally:
            with self._subs_lock:
                self._subscribers.discard(q)

    def _publish(self, payload: Dict) -> None:
        with self._subs_lock:
            subscribers = list(self._subscribers)

        for q in subscribers:
            try:
                q.put_nowait(payload)
            except queue.Full:
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(payload)
                except queue.Full:
                    pass

    def endpoint_uses_bind(self) -> bool:
        return "://*:" in self.endpoint or "://0.0.0.0:" in self.endpoint

    def publish_local_event(self, topic: str, payload: Dict, timestamp_ms: Optional[int] = None) -> None:
        ts = int(timestamp_ms or (time.time() * 1000))
        self._publish(
            {
                "type": "neat_metrics",
                "topic": str(topic),
                "timestamp_ms": ts,
                "payload": payload if isinstance(payload, dict) else {"value": payload},
            }
        )

    def _run(self) -> None:
        sock = self._ctx.socket(zmq.SUB)
        sock.setsockopt_string(zmq.SUBSCRIBE, "")
        sock.setsockopt(zmq.RCVHWM, 2000)
        sock.setsockopt(zmq.LINGER, 0)
        poller = zmq.Poller()
        poller.register(sock, zmq.POLLIN)

        try:
            if "://*:" in self.endpoint or "://0.0.0.0:" in self.endpoint:
                sock.bind(self.endpoint)
            else:
                sock.connect(self.endpoint)
            while not self._stop_evt.is_set():
                events = dict(poller.poll(250))
                if sock not in events:
                    continue
                if events[sock] != zmq.POLLIN:
                    continue

                raw_frames = sock.recv_multipart()
                parsed = self._parse_frames(raw_frames)
                if parsed is None:
                    continue
                self._publish(parsed)
        except Exception as exc:
            logging.exception("NEAT metrics subscriber failed: %s", exc)
            self._publish(
                {
                    "type": "status",
                    "state": "error",
                    "error": str(exc),
                    "timestamp_ms": int(time.time() * 1000),
                }
            )
        finally:
            try:
                poller.unregister(sock)
            except Exception:
                pass
            sock.close(0)

    def _parse_frames(self, frames) -> Optional[Dict]:
        if not frames:
            return None

        topic = None
        payload_frame = frames[-1]
        if len(frames) > 1:
            topic = frames[0].decode("utf-8", errors="ignore").strip()

        try:
            payload = json.loads(payload_frame.decode("utf-8", errors="ignore"))
        except Exception:
            return None

        if not isinstance(payload, dict):
            return None

        resolved_topic = payload.get("_topic") or topic or "unknown.topic"
        timestamp_ms = payload.get("timestamp_ms")
        if not isinstance(timestamp_ms, (int, float)):
            timestamp_ms = int(time.time() * 1000)

        return {
            "type": "neat_metrics",
            "topic": str(resolved_topic),
            "timestamp_ms": int(timestamp_ms),
            "payload": payload,
        }


def _to_connectable_endpoint(endpoint: str) -> str:
    if not endpoint:
        return "tcp://127.0.0.1:5557"
    if "://*:" in endpoint:
        return endpoint.replace("://*:", "://127.0.0.1:")
    if "://0.0.0.0:" in endpoint:
        return endpoint.replace("://0.0.0.0:", "://127.0.0.1:")
    # Handle tcp://[::]:5557 style wildcard.
    if re.match(r"^tcp://\[(::|0:0:0:0:0:0:0:0)\]:\d+$", endpoint):
        return re.sub(r"^tcp://\[(::|0:0:0:0:0:0:0:0)\]:", "tcp://127.0.0.1:", endpoint)
    return endpoint


class PeriodicZmqPublisher:
    def __init__(
        self,
        payload_fn: Callable[[], Dict],
        topic: str = "sys",
        endpoint: Optional[str] = None,
        interval_sec: float = 2.0,
        publish_hook: Optional[Callable[[Dict, int], None]] = None,
    ):
        self.payload_fn = payload_fn
        self.topic = topic
        self.endpoint = endpoint or os.getenv("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://*:5557")
        self.connect_endpoint = _to_connectable_endpoint(self.endpoint)
        self.interval_sec = max(float(interval_sec), 0.2)
        self.publish_hook = publish_hook
        self._ctx = None
        self._thread = None
        self._stop_evt = threading.Event()
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        if zmq is None:
            logging.warning("pyzmq is not available; periodic ZMQ publisher for topic '%s' is disabled.", self.topic)
            return

        self._ctx = zmq.Context.instance()
        self._thread = threading.Thread(target=self._run, name=f"zmq-pub-{self.topic}", daemon=True)
        self._thread.start()
        logging.info(
            "Periodic ZMQ publisher started for topic '%s' via %s (source endpoint %s)",
            self.topic,
            self.connect_endpoint,
            self.endpoint,
        )

    def stop(self) -> None:
        self._stop_evt.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)

    def _run(self) -> None:
        sock = self._ctx.socket(zmq.PUB)
        sock.setsockopt(zmq.LINGER, 0)
        try:
            sock.connect(self.connect_endpoint)
            # Allow PUB/SUB handshake before first publish.
            time.sleep(0.15)
            while not self._stop_evt.is_set():
                try:
                    payload = self.payload_fn() or {}
                    if not isinstance(payload, dict):
                        payload = {"value": payload}
                    ts = int(time.time() * 1000)
                    payload["_topic"] = self.topic
                    payload["timestamp_ms"] = ts
                    if self.publish_hook:
                        self.publish_hook(dict(payload), ts)
                    sock.send_multipart(
                        [
                            self.topic.encode("utf-8"),
                            json.dumps(payload, default=str).encode("utf-8"),
                        ]
                    )
                except Exception as exc:
                    logging.exception("Failed to publish ZMQ topic '%s': %s", self.topic, exc)
                self._stop_evt.wait(self.interval_sec)
        finally:
            sock.close(0)
