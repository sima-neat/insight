# Runs on the board with PyNeat's python: streams one camera to Insight's viewer until SIGTERM.
import os
import signal
import sys
import time

import pyneat

name, host = sys.argv[1:3]
width, height, fps, port_base, channel = (int(arg) for arg in sys.argv[3:8])

camera = pyneat.CameraInputOptions()
camera.camera_name = name
camera.width, camera.height = width, height
camera.framerate_num, camera.framerate_den = fps, 1
camera.format = "NV12"
camera.allow_cpu_fallback = True
sender = pyneat.VideoSenderOptions.h264_rtp_udp_from_raw(width, height, fps)
sender.host, sender.video_port_base, sender.channel = host, port_base, channel

graph = pyneat.Graph("insight_preview")
graph.add(pyneat.nodes.camera_input(camera))
# CameraInput delivers the sensor mode's rate, which can exceed the requested one.
graph.add(pyneat.nodes.video_rate())
graph.add(pyneat.nodes.caps_raw("NV12", width, height, fps))
graph.add(pyneat.groups.video_sender(sender))
options = pyneat.RunOptions()
options.preset = pyneat.RunPreset.Realtime
options.overflow_policy = pyneat.OverflowPolicy.KeepLatest

stopping = []
signal.signal(signal.SIGTERM, lambda *_: stopping.append(True))
try:
    run = graph.build(options)
except pyneat.NeatError as exc:
    print(exc, file=sys.stderr, flush=True)
    os._exit(1)
print("running", flush=True)
error = ""
while not stopping and not error and run.running():
    time.sleep(0.2)
    error = run.last_error()
run.close()
if error:
    print(error, file=sys.stderr, flush=True)
# PyNeat aborts at interpreter exit after close().
os._exit(1 if error else 0)
