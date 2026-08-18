# sima-mipi-util tests

Two tiers, matching the PR review requests (host-side logic checks + on-device
API access), neither requiring a MIPI camera to be attached.

## 1. Host-side tests (no hardware)

Pure API/logic checks with mocked v4l2/gstreamer, so they run anywhere. They
cover the review-flagged behaviours: token auth on writes, `int()` validation
(400 not 500), the removed system-reboot (403), non-wildcard CORS, and
sensor-subdevice routing for get/set/detect.

```bash
python3 -m venv .venv
.venv/bin/pip install -r tests/requirements.txt
.venv/bin/python -m pytest tests/ -v
```

Expected: all tests pass (16 at time of writing).

## 2. On-device smoke test

Run on the Modalix board (or any devkit runner) after installing the package.
Exercises the live HTTP API — service state, open reads, token-gated writes,
and the disabled system reboot.

```bash
# after: sudo apt install ./sima-mipi-util_1.0.0_arm64.deb
tests/smoke_test.sh
```

It reads the install-provisioned token from `/etc/sima-mipi-util/token`
automatically. Override the target or token if needed:

```bash
BASE=http://192.168.1.20:5000 TOKEN=xxxx tests/smoke_test.sh
```

Offline package validation (no install, just inspect the `.deb`):

```bash
tests/smoke_test.sh --deb ./sima-mipi-util_1.0.0_arm64.deb
```

The script exits non-zero if any check fails, so it can gate CI.
