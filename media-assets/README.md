# Insight Media Assets

This folder contains the asset conversion pipeline used to publish reusable Insight
media files.

The generated media assets are licensed under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) and are provided
for non-commercial testing, evaluation, and demonstration purposes only. See
[`LICENSE.md`](LICENSE.md).

Run locally:

```bash
python3 media-assets/build_media_assets.py \
  --sources media-assets/sources.json \
  --output dist/media-assets
```

The script downloads each source video, generates the configured resolution, frame
rate, and codec renditions with `ffmpeg`, probes the outputs with `ffprobe`, and
writes `index.json` for tools and workflows to consume.

Use `--regenerate` to rebuild outputs even when an existing destination manifest
already lists them.

The GitHub publishing workflow uploads each completed rendition directly to the
durable `media-assets/` artifact prefix and updates a per-run shard index as
progress is made. If a long conversion job is cancelled or times out, already
uploaded files can be reused by a later run instead of being transcoded again.
The canonical `media-assets/index.json` is refreshed only after all workflow
shards complete successfully, avoiding concurrent writes from parallel jobs.
