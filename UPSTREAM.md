# Upstream

`insight-next` is a private copy of [`sima-neat/insight`](https://github.com/sima-neat/insight).

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

## Port log

<!-- upstream commit -> local commit -->
