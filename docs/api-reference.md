---
title: REST API Reference
description: Automate Neat Insight with the OpenAPI document its server serves.
sidebar_position: 6
---

# REST API Reference

Everything the web UI does goes through Insight's HTTP API, on its main port. The running server
describes the whole API in an OpenAPI 3.0 document, which is the reference:

```bash
curl -k https://127.0.0.1:9900/api/openapi.yaml -o neat-insight-openapi.yaml
curl -k https://127.0.0.1:9900/api/health           # {"status": "ok", ...}
```

`-k` skips the check of Insight's certificate, which `curl` does not trust unless you add its
authority ([The certificate](install-upgrade.md#the-certificate)).

Routes marked **Frozen** in the document keep their paths and fields, since tools outside Insight
use them: `/api/health`, `/api/ingest/stats`, `/api/viewer-url` and the HTTP MJPEG stream
`/stream/http/srcN.mjpg`. Other routes may change with a release. Every error has one shape:

```json
{"error": {"code": "not_found", "message": "…", "hint": "…"}}
```

`code` is a stable word to branch on, and `hint`, when present, says what to do. For coding agents,
the `use-neat-insight` skill (`skills/use-neat-insight` in the Insight repository) explains the API
by task.
