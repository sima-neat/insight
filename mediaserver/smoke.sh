#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: bash mediaserver/smoke.sh IMAGE}"
media="$(docker volume create)"
container=
cleanup() {
    if [[ -n "$container" ]]; then
        docker rm -f "$container" >/dev/null
    fi
    docker volume rm "$media" >/dev/null
}
trap cleanup EXIT

docker run --rm --user 0:0 --entrypoint ffmpeg \
    -v "$media:/fixtures" "$image" -hide_banner -loglevel error \
    -f lavfi -i testsrc2=size=160x120:rate=10 -t 2 -c:v libx264 -pix_fmt yuv420p /fixtures/0-avc.mp4
docker run --rm --user 0:0 --entrypoint ffmpeg \
    -v "$media:/fixtures" "$image" -hide_banner -loglevel error \
    -f lavfi -i testsrc2=size=160x120:rate=10 -t 2 -c:v mjpeg -huffman default \
    -force_duplicated_matrix 1 -pix_fmt yuvj420p /fixtures/1-mjpeg.avi
docker run --rm --user 0:0 --entrypoint ffmpeg \
    -v "$media:/fixtures" "$image" -hide_banner -loglevel error \
    -f lavfi -i testsrc2=size=160x120:rate=10 -t 2 -c:v libx265 \
    -x265-params pools=1:frame-threads=1:log-level=error -pix_fmt yuv420p /fixtures/2-hevc.mp4
container="$(docker run -d --read-only --tmpfs /tmp -v "$media:/media:ro" "$image")"

if ! docker exec -i "$container" python3 - <<'PY'
import json
import subprocess
import time
from urllib.request import urlopen

base = "http://127.0.0.1:8088"


def wait_for(predicate):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            with urlopen(base + "/healthz", timeout=2) as response:
                state = json.load(response)
            if predicate(state):
                return
        except OSError:
            pass
        time.sleep(0.25)
    raise AssertionError("Expected health state did not arrive")


wait_for(lambda state: state["rtsp"]["ready_sources"] == 3 and state["http"]["ready_sources"] == 1)
with urlopen(base + "/streams.json", timeout=2) as response:
    assert json.load(response)[0]["url"] == "/src0.mjpeg"

with urlopen(base + "/media-sources.json", timeout=2) as response:
    assert response.headers.get_content_type() == "application/json"
    catalog = json.load(response)
assert catalog["schema_version"] == 1
assert len(catalog["sources"]) == 4
sources = {(source["transport"], source["id"]): source for source in catalog["sources"]}
for transport, source_id, port, codec, path in [
    ("rtsp", "src0", 8554, "h264", "/src0"),
    ("rtsp", "src1", 8554, "mjpeg", "/src1"),
    ("rtsp", "src2", 8554, "h265", "/src2"),
    ("http", "src0", 8088, "mjpeg", "/src0.mjpeg"),
]:
    assert sources[transport, source_id] == {
        "id": source_id, "transport": transport, "port": port, "codec": codec, "path": path,
        "width": 160, "height": 120, "fps": 10,
    }

rtsp_source = sources["rtsp", "src0"]
http_source = sources["http", "src0"]
rtsp = f"rtsp://127.0.0.1:{rtsp_source['port']}{rtsp_source['path']}"
mjpeg = f"http://127.0.0.1:{http_source['port']}{http_source['path']}"
with subprocess.Popen([
    "ffmpeg", "-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp",
    "-i", rtsp, "-t", "8", "-f", "null", "-",
]) as player:
    try:
        with urlopen(mjpeg, timeout=5) as stream:
            assert stream.headers.get_content_type() == "multipart/x-mixed-replace"
            assert stream.readline() == b"--frame\r\n"
            assert stream.readline() == b"Content-Type: image/jpeg\r\n"
            length = int(stream.readline().split(b":")[1])
            assert stream.readline() == b"\r\n"
            frame = stream.read(length)
            assert frame.startswith(b"\xff\xd8") and frame.endswith(b"\xff\xd9")
            wait_for(lambda state: state["rtsp"]["active_readers"] == 1 and state["http"]["active_readers"] == 1)
        assert player.wait(timeout=20) == 0
    finally:
        if player.poll() is None:
            player.kill()

wait_for(lambda state: state["rtsp"]["active_readers"] == state["http"]["active_readers"] == 0)
print("Media catalog, RTSP playback, HTTP MJPEG, and viewer lifecycle verified")
PY
then
    docker logs "$container"
    exit 1
fi
docker stop -t 10 "$container" >/dev/null
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$container")" == 0 ]]
