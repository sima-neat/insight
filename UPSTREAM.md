# Upstream

`insight-next` is a copy of [`sima-neat/insight`](https://github.com/sima-neat/insight).

- Upstream branch: `integration/sources-and-viewer` (PR #170)
- Baseline commit: `829ec7c`, which contains `develop` at `9d335f0`
- Copied: 2026-10-21, with fresh history (`git archive`, no upstream commits)
- PR #123 is superseded by the baseline and not included

Upstream backend changes are ported by hand. Each port appends a line to the log below, as
`upstream commit -> local commit`.

## Local backend changes

Routes this copy changed on its own, so a later port of upstream's version of them knows to
merge rather than copy. Tests and the API docs (`neat_insight/openapi.json`, the skill) go with
each.

- `POST /api/upload/media` (1e2a185, fe282c6, eb3fa57, and the stop fix after the final review):
  - takes an optional `on_conflict` (`ask` by default, `keep_both`, `replace`); a taken name that
    was not asked about answers 409 with `{error, conflict: {existing, suggested}}`, and every
    refusal (400, 409) is decided before the stream starts;
  - stages the upload in a `.upload-*` folder on the media filesystem and moves it into place
    without overwriting (a hard link, or an exclusive reservation where hard links are not
    supported); stale staging folders are swept;
  - on `replace`, stops the file slots streaming the replaced files, restarts them once the new
    content is in place (`Restarted srcN.` / `Could not restart srcN: …`, a warning, not a
    failure), restarts them on every other exit too, and unassigns slots whose file a replaced
    archive no longer has.
- `POST /api/vf/offer` and the viewer URL (7c71a11, 1cc8e23, 55547e8): vf offers are proxied
  through Flask (JSON only, a bounded channel, vf errors as text), and the viewer URL points at
  `/viewer`.
- `GET /api/sysinfo`: when `neat` is not on PATH it answers 200 with the `neat --json` shape, unknown
  fields null or empty and a `missing: ["neat"]` list (ports and the web UI address still filled in),
  where upstream returns invented sample data (`_fake_sysinfo_payload`, removed here). A `neat`
  answer passes through unchanged.
- `GET /api/sentinel/metrics`: takes optional `after` (the newest sample timestamp the caller holds) and
  `epoch` (the caller's `history.epoch`), and `history` in the answer gains `full` and `epoch`. With both
  parameters the answer holds only the samples after `after` (`full: false`); a reset, gap, restart or
  reseed of the history, an unknown `after`, or more new samples than `history` asks for answers the
  whole window with `full: true`. A non-integer `epoch` is `400 invalid_request`. `BoardCache` keeps the
  epoch and limits the window (`window()`); `metrics.build` and `series` no longer take a history limit.
  Additive: no existing field changes.
- `GET /api/metrics`: the local `cpu_load` is read without blocking (upstream blocks the request for 0.1 s
  in `psutil.cpu_percent(interval=0.1)`) through `LocalCpuReader`, which makes every psutil call from one
  worker thread (psutil keeps its baseline per thread) and does not re-measure within 0.5 s; the remote
  `cpu_load` is total time, 100 minus the `id` field of `top` (`remote_cpu_percent`), where upstream reports
  user time. The response gains a typed schema (`HostMetrics`). Additive: no field changes.

## Port log

<!-- upstream commit -> local commit -->
