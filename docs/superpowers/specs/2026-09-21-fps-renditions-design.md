# FPS-specific video renditions — design

Issue: [#111](https://github.com/sima-neat/insight/issues/111)
Date: 2026-09-21
Status: approved design, awaiting implementation plan

## Goal

Let a user pick a frame rate for a streaming slot in the Insight UI and start
the stream at that rate. Insight creates a re-encoded copy of the source video
("rendition") on first use, stores it, records it, and reuses it on later starts
— including after a restart and across slots. Renditions follow the same
encoding contract as the Insight media catalog so the streaming step can pass
them through untouched.

Out of scope: MJPEG frame-rate changes, fractional frame rates, background/async
encoding, a rendition browser, garbage collection beyond what delete-media
already does.

## Decisions taken during brainstorming

| Topic | Decision |
|---|---|
| Encode UX | Synchronous inside Start. The UI shows a determinate progress bar in the preview panel (styled like the external-stream "Connecting…" state). |
| FPS scope | Per slot, persisted on the slot record in `media_sources.json`. |
| Codec | Rendition keeps the source codec: H.264 → libx264 baseline, H.265 → libx265 main. MJPEG sources reject any FPS other than native with HTTP 400. |
| Storage | Hidden `MEDIA_DIR/.renditions/` directory (dot-prefixed entries are already hidden from `/api/media-files`). Index in `renditions.json` next to `media_sources.json`. |
| Source identity | SHA-256 of the file content, cached in the index and validated by size + mtime_ns. |
| Native FPS | If the box equals the source's detected FPS (rounded to integer), no rendition is made and the source streams exactly as today. |
| FPS range | Integers 1–240. Arrows step by 5. |
| Progress channel | New `POST /api/mediasrc/prepare` streams `text/plain` progress like upload. `/api/mediasrc/start` stays JSON and also ensures the rendition silently, so API callers and bulk start honour the slot FPS. |
| Encoding rules | New importable module `neat_insight/renditions.py`, ported from `media-assets/build_media_assets.py`. The asset script is left untouched (follow-up: make it import the module). |
| UI placement | Option A: a `[−] N fps [+]` stepper column in every source row between the codec pill and the play button. |

## Data model

### Slot record (`media_sources.json`)

One new field:

```json
{ "index": 3, "file": "demo.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264", "fps": 15 }
```

- `fps`: positive integer or `null`. `null`, missing, or invalid values normalize
  to `null` = "source frame rate", so existing files migrate without change.
- Set through `POST /api/mediasrc/assign` (optional `fps`). Assigning a
  different `file` resets `fps` to `null`.

### Rendition index (`renditions.json`, peer of `media_sources.json`)

```json
{
  "schema": "sima.neat.insight.renditions.v1",
  "sources": {
    "demo.mp4": { "size": 52428800, "mtime_ns": 1758441600000000000, "sha256": "3a9f…c2" }
  },
  "renditions": [
    {
      "key": "3a9f…c2:15:h264:baseline",
      "source_file": "demo.mp4",
      "source_sha256": "3a9f…c2",
      "fps": 15, "codec": "h264", "profile": "baseline",
      "path": ".renditions/demo_3a9fc2_15fps_h264.mp4",
      "sha256": "…", "bytes": 1234567, "width": 1280, "height": 720,
      "created_at": "2026-09-21T08:00:00Z"
    }
  ]
}
```

- **Lookup key** = `{source_sha256}:{fps}:{codec}:{profile}`. Profile is fixed
  per codec (`baseline` / `main`) and included for future-proofing.
- **Rendition file name** = `{source stem}_{first 6 hex of source sha}_{fps}fps_{codec}.mp4`,
  so two versions of the same filename never collide.
- **`sources` table** is a persistent hash cache. On lookup: `stat` the source;
  if `size` and `mtime_ns` match, reuse `sha256`; otherwise hash (1 MiB chunks),
  update the entry. Steady-state cost is one `stat`.
- Writes are whole-file, `indent=2`, `sort_keys=True`, atomic via temp +
  `replace()`.
- A record whose `path` no longer exists is dropped on lookup and treated as a
  miss. Records for a replaced source are orphans and are pruned the same way
  when encountered; there is no separate garbage collection.

**Known limitation:** a replacement that preserves both size and mtime
(`cp -p`, `rsync -a` with identical byte length) is not detected until the
file's stat changes. This is the same failure mode as a pure fingerprint
scheme, never worse. A future `force=true` on `prepare` can re-hash.

## Backend

### `neat_insight/renditions.py`

Pure functions plus index I/O; no Flask imports.

| Function | Behaviour |
|---|---|
| `detect_fps(path) -> int \| None` | `avg_frame_rate` (fallback `r_frame_rate`) via `_ffprobe_json`, rounded to nearest integer. |
| `validate_fps(value) -> int` | Accepts int or numeric string. Raises `ValueError` unless `1 ≤ fps ≤ 240` and integral. |
| `source_hash(index, media_dir, rel_path) -> str` | The `sources` cache above. |
| `rendition_key(sha, fps, codec) -> str` | `f"{sha}:{fps}:{codec}:{PROFILE[codec]}"`. |
| `encode_command(src, dst, fps, codec, width, height) -> list[str]` | ffmpeg argv, ported from `common_h26x_args`, `ffmpeg_codec_args`, `video_filter`, `run_ffmpeg` in the asset builder. |
| `validate_rendition(path, fps, codec) -> None` | ffprobe/ffmpeg checks; raises `RenditionError`. |
| `load_index(path) / save_index(path, data)` | Atomic JSON I/O with schema check. |
| `ensure_rendition(...) -> Iterator[Progress]` | Orchestrator, below. |

**Encoder arguments** (identical rules to the catalog):

- Common: `-map 0:v:0 -an -vf fps={fps} -fps_mode cfr -pix_fmt yuv420p -g {fps}
  -keyint_min {fps} -bf 0 -flags +cgop -movflags +faststart
  -avoid_negative_ts make_zero -progress pipe:1 -nostats`; rate control
  `-b:v/-maxrate/-bufsize` all equal, from the catalog's `video_bitrate` rule.
- H.264: `-c:v libx264 -preset medium -profile:v baseline -level:v {level}
  -refs 1 -sc_threshold 0 -x264-params repeat-headers=1:force-cfr=1:open-gop=0
  -tag:v avc1`; level from the catalog's `video_level(height, fps)`.
- H.265: `-c:v libx265 -profile:v main -level:v {level} -tag:v hvc1 -x265-params
  level-idc={…}:high-tier=0:keyint={fps}:min-keyint={fps}:scenecut=0:bframes=0:ref=1:open-gop=0:log-level=error`.
- Bitstream filter for VUI timing (`h264_metadata` / `hevc_metadata` with
  `tick_rate`, AUD insert, `dump_extra=freq=keyframe`) exactly as the catalog.
- Upsampling above the source rate uses plain frame duplication (`fps=` filter),
  not `minterpolate`.

**`validate_rendition`** checks: `avg_frame_rate == r_frame_rate == fps/1`,
`pix_fmt == yuv420p`, `has_b_frames == 0`, codec profile/level match the
request, reference frames == 1 (parsed from `ffmpeg -loglevel verbose`), exactly
one video stream, and keyframes at every `fps`-th frame starting at 0 with
PTS == DTS (`-show_packets`).

### `ensure_rendition` workflow

A generator so `prepare` can stream it and `start` can drain it.

1. Probe the source → `native_fps`, `codec`, `width`, `height`.
   `codec == mjpeg and fps != native_fps` → `RenditionError("FPS changes are not supported for MJPEG sources")`.
   `fps == native_fps` → yield `done(source_path)`; stop.
2. `source_hash`, `rendition_key`. Index hit and file exists → yield
   `done(rendition_path)`; the encoder is **not** run.
3. Miss: encode to `MEDIA_DIR/.renditions/.{name}.tmp.mp4` (pre-existing tmp is
   unlinked first). Parse `-progress pipe:1` into `progress(seconds, total)`
   events, throttled to 1 Hz; keep the last 8 non-progress stderr lines as
   diagnostics.
4. Non-zero exit or `validate_rendition` failure → unlink tmp, raise
   `RenditionError` with the last diagnostic lines. Index untouched; the source
   is never opened for writing.
5. Success → `tmp.replace(final)`, append record, `save_index`, yield `done(final)`.
6. Consumer disconnect (`GeneratorExit`) → terminate ffmpeg, unlink tmp.

**Concurrency:** a per-key `threading.Lock` (dict guarded by a global lock).
Two slots starting the same source at the same FPS at once: the second waits,
then hits the index. Different keys encode in parallel.

### Endpoints (`neat_insight/app.py`)

| Route | Change |
|---|---|
| `POST /api/mediasrc/assign` | Optional `fps` (validated → 400). Stored on the slot. Changing `file` resets `fps` to `null`. Restart-while-playing branch goes through the shared start helper. |
| `POST /api/mediasrc/prepare` (new) | `{index}`. `text/plain` stream: `Encoding {file} at {fps} fps…`, `progress {done}/{total}`, then `Rendition ready: {path}` or `Error: {message}`. 400 for invalid slot, unassigned slot, invalid FPS, MJPEG; the encode error is reported in-stream (HTTP 200) like upload. |
| `POST /api/mediasrc/start` | Resolves the slot's `fps`; drains `ensure_rendition` synchronously; passes the resulting path to `start_media_stream`. 400 for validation errors, 500 for encode failure. |
| `POST /api/mediasrc/start-bulk` | Same helper per slot; encodes sequentially per key. |
| `GET /api/mediasrc` | Each slot additionally reports `native_fps` (probe cached via the `sources` stat validator) and `active_file` (the path actually streaming, or `null`). |
| `POST /api/delete-media` | Also removes the source's `sources` entry, its rendition records and files. |

All new routes and fields are documented in `neat_insight/openapi.json`
(`tests/test_api_docs.py` enforces this) and in
`skills/use-neat-insight/playbook.yml`.

### Streaming

`mediasrc._codec_args` already emits `-c:v copy` when the file's codec matches
the slot codec. The rendition is in the same codec as the source, so the slot
codec still matches and ffmpeg passes the rendition through; the requested FPS
reaches RTSP. `MediaStream` gains a `rendition: str | None` field so
`media_stream_identity` distinguishes "same file, different FPS".

## Frontend

### `frontend/src/fps.js` (pure, tested with `node --test`)

- `FPS_MIN = 1`, `FPS_MAX = 240`, `FPS_STEP = 5`.
- `stepFps(value, direction)` → `value ± 5`, clamped to the range.
- `parseFps(text)` → integer or `null`; rejects empty, non-numeric, decimals,
  `0`, negatives, out of range.

### `FpsStepper` in `App.jsx`

One per source row, in a new `112px` grid column between the codec pill and the
play/stop button (`.source-row` and both responsive overrides in `styles.css`).

- `[−]` `<input inputmode="numeric">` `[+]`. Typing edits local state; commit on
  blur or Enter → `updateSource(index, { fps })` → `/api/mediasrc/assign`.
- Invalid input: red outline, `aria-invalid`, revert to the last committed
  value, ▶ disabled with tooltip "FPS must be a whole number between 1 and 240".
- Value equals `native_fps` → plain; differs → blue outline (`.changed`).
- Unassigned slot → disabled showing `—`. MJPEG slot → disabled, tooltip "FPS
  changes are not supported for MJPEG sources". Locked while encoding or live.
- Selecting a different file shows the new file's `native_fps` (server resets
  `fps` to `null`).

### Start flow

`startSource(index)`:

1. If the slot's `fps` differs from `native_fps`: `fetch('/api/mediasrc/prepare')`,
   read the body with the upload reader loop, store progress in
   `encodeProgress[index]`. An `Error:` line → error toast, clear progress, stop.
2. `fetchJson('/api/mediasrc/start')` as today, then `loadSources()`.

While `encodeProgress[index]` exists: badge shows **Encoding**, stepper and file
select are locked, ▶ is replaced by ■ which aborts the fetch (server-side
`GeneratorExit` kills ffmpeg and unlinks the tmp).

Preview panel for the selected slot:

- Encoding: `.preview-loading` live region with `upload-progress-track` /
  `upload-progress-bar` at `done/total`, text "Encoding {fps} fps rendition… {pct}%",
  second line "{m:ss} / {m:ss} · {encoder} {profile}".
- `File:` line adds `· {W}×{H} · {native_fps} fps`.
- `Output:` line adds `· {fps} fps`, plus "· streaming rendition {path}" when
  `active_file` differs from `file`, or "(rendition will be created on start)"
  when idle with a non-native value.
- Failure: existing error toast — "Encoding src{N} at {fps} fps failed. Partial
  output was removed; the source file is unchanged." followed by ffmpeg's last
  diagnostic line. Slot returns to Idle keeping the value so ▶ retries.

Bulk Start modal gains one line: "Slots with a custom FPS may take longer to
start while renditions are created."

### Docs

`docs/user-interface.md` Streaming Sources section gets a paragraph on the FPS
control and renditions; i18n mirrors receive the English text and are noted as
translation debt per `docs/i18n/README.md`. `docs/api-reference.md` common flow
mentions `fps` on assign.

## Tests and CI

### `tests/test_fps_renditions.py` (stdlib `unittest`, real ffmpeg/ffprobe)

Skips with a clear message when ffmpeg/ffprobe are absent locally; CI always has
them. Fixture: a 2-second 320×240 30 fps H.264 clip generated in `setUpClass`
with `ffmpeg -f lavfi -i testsrc=size=320x240:rate=30 -t 2 -c:v libx264
-pix_fmt yuv420p` into a temporary `MEDIA_DIR` (module globals monkeypatched
like `tests/test_streaming_sources.py`). `subprocess.Popen` for the *stream*
process is mocked; the encoder runs for real.

Cases:

- `GET /api/mediasrc` reports `native_fps == 30` for the assigned slot.
- `assign` accepts `15`; rejects `0`, `-5`, `"abc"`, `2.5`, `999` with 400.
- `prepare` streams progress lines and ends with `Rendition ready`.
- ffprobe on the rendition: `avg_frame_rate == r_frame_rate == 15/1`,
  `pix_fmt yuv420p`, `has_b_frames 0`, keyframes at frames 0, 15, 30, …,
  reference frames 1, profile baseline.
- `start` passes the rendition path (not the source) to the stream process.
- Second `start` with the same value → the encoder is not invoked (patched
  encoder call counter) and the same path streams.
- Re-import the app module against the same data dir → still no encode,
  proving the index survives restart.
- Overwrite the fixture with different content (different `-t`) → new hash,
  new encode, old record pruned.
- MJPEG fixture with `fps != native` → 400 on `prepare` and `start`.
- Encoder forced to fail (patched argv → `ffmpeg -i missing`) → `prepare` ends
  with `Error:`, `start` → 500, no `.tmp` or rendition file, index unchanged,
  source bytes identical.
- `delete-media` on the source removes rendition files and index records.
- Direct unit tests: `encode_command` argv for both codecs, `validate_fps`,
  `rendition_key`, `stepFps`-equivalent range rules.

### `frontend/src/fps.test.js`

`node --test`: `stepFps` (+5/−5, clamps at 1 and 240), `parseFps` (accepts
`"30"`, rejects `""`, `"0"`, `"-3"`, `"abc"`, `"29.97"`, `"241"`). Wired to a new
`npm run test:unit` script.

### `scripts/test-fps-renditions.sh`

Checks `ffmpeg` and `ffprobe` are on PATH, runs
`python -m unittest tests.test_fps_renditions -v` and `npm --prefix frontend run
test:unit`, exits non-zero on any failure. This is the reusable script the
issue asks for.

### CI

New `tests` job in `.github/workflows/vulcan-ci.yml` on `ubuntu-latest`:
`sudo apt-get install -y ffmpeg`, `npm ci` in `frontend`, `pip install -e .`,
then `scripts/test-fps-renditions.sh` followed by
`python -m unittest discover tests` (keeps the OpenAPI check enforced). Runs on
every PR before the build matrix; a failure fails the workflow.

### Manual evidence for the PR

Cannot be automated in CI (needs a real server and mediamtx):

```sh
neat-insight --port 9900 &
curl -sk -X POST https://localhost:9900/api/mediasrc/assign -H 'Content-Type: application/json' -d '{"index":1,"file":"demo.mp4","fps":15}'
curl -sk -N -X POST https://localhost:9900/api/mediasrc/prepare -H 'Content-Type: application/json' -d '{"index":1}'
curl -sk -X POST https://localhost:9900/api/mediasrc/start -H 'Content-Type: application/json' -d '{"index":1}'
ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate,r_frame_rate,pix_fmt,has_b_frames,profile -of default=nw=1 rtsp://localhost:8554/src1
ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate,r_frame_rate,pix_fmt,has_b_frames,profile -of default=nw=1 ~/.simaai/neat-insight/media/.renditions/demo_*_15fps_h264.mp4
# restart neat-insight, start slot 1 again, confirm no ffmpeg encode process appears and the same rendition path is reported by GET /api/mediasrc
```

Plus a screenshot or short recording of the stepper and the live stream.

## Housekeeping

- Add `.superpowers/` to `.gitignore`.
