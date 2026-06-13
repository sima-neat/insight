---
title: Install and Upgrade
description: Run Insight from the Neat Development Environment, install it on a DevKit, and upgrade it with sima-cli.
sidebar_position: 2
---

# Install and Upgrade

Insight is bundled with the Neat Development Environment. It can also be installed directly on a Modalix DevKit and upgraded with `sima-cli neat install`.

## In the Neat Development Environment

When the SDK container starts with Insight enabled, the Insight server starts automatically and listens over HTTPS.

Open Insight from a browser:

```text
https://localhost:9900
```

If you are browsing from another machine on the same network, use the SDK host IP address:

```text
https://<host-ip>:9900
```

The `neat` command reports the actual Insight Web UI URL and exposed port mapping when that information is available.

## On a DevKit

Insight can be installed directly on a Modalix DevKit. This is useful when you want the inspection console to run on the target device, or when you are validating a standalone DevKit setup.

Install Insight with `sima-cli`:

```bash
sima-cli neat install insight@{release-tag}
```

For development builds, replace the release tag with the branch or tag you want to install:

```bash
sima-cli neat install insight@main
```

After installation, activate the created virtual environment and start Insight:

```bash
source ~/.simaai/neat-insight/venv/bin/activate
neat-insight --port 9900
```

Then open:

```text
https://<devkit-ip>:9900
```

## Upgrade Insight

Because Insight is packaged as a Neat artifact, you can upgrade it with the same `sima-cli neat install` flow used for installation.

For a release:

```bash
sima-cli neat install insight@{release-tag}
```

For the latest build from a branch:

```bash
sima-cli neat install insight@main
```

In the Neat Development Environment, Insight normally runs from `/opt/neat-insight/venv`. To upgrade the supervised SDK instance, install into that virtual environment and restart the service:

```bash
NEAT_INSIGHT_VENV_DIR=/opt/neat-insight/venv sima-cli neat install insight@main
supervisorctl restart neat-insight
```

If your SDK image requires elevated permissions for `/opt/neat-insight`, run the install command with the appropriate privileges for your environment.
