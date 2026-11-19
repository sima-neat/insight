---
title: Install and Upgrade
description: Run Insight from the Neat Development Environment, install it on a DevKit, and upgrade it with sima-cli.
sidebar_position: 2
---

# Install and Upgrade

## In the Neat SDK

The SDK container installs Insight and starts it with the container. `insight-admin` manages it:

```bash
insight-admin status        # is it running
insight-admin restart
insight-admin logs 200      # its last 200 log lines
```

Open `https://localhost:9900`, or `https://<host-ip>:9900` from another machine. If port 9900 was
taken when the SDK was set up, the SDK published Insight on another port: `neat --json` gives the
address as `insight.webUiUrl` ([Ports and network](ports-network.md)).

## On a DevKit

Insight needs two programs on the DevKit: [mkcert](https://github.com/FiloSottile/mkcert), for its
HTTPS certificate (without it, Insight does not start and says so), and `ffmpeg`, for its sources
and media library. Install them once, then install Insight with `sima-cli` and start it from the
virtual environment the installer creates:

```bash
sudo apt install mkcert ffmpeg
sima-cli neat install insight
source ~/.simaai/neat-insight/venv/bin/activate
neat-insight                # serves https://<devkit-ip>:9900; --port picks another port
```

## The certificate

Insight serves HTTPS only: with the SDK's certificate in the SDK, with its mkcert certificate
elsewhere. A browser that does not trust the certificate warns before it opens the page, and allows
camera access (a webcam source) only once it trusts it. Trust the certificate's authority in your
browser, or accept the warning for the page and for the webcam publishing port
([Use a webcam](workflows.md#use-your-webcam-as-a-source)).

## Upgrade

In the SDK, `insight-admin update` installs the version the SDK names and restarts Insight;
`insight-admin update main` installs the latest build of the `main` branch instead.

On a DevKit, run `sima-cli neat install insight` again (`insight@<release-tag>` for a given
release), then restart `neat-insight`.
