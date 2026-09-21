# Distinct, stable colors for Insight metadata

Issue: https://github.com/sima-neat/insight/issues/112 (refs #8)

## Problem

The viewer overlay renderers in `webrtc/static/drawing.js` pick colors
independently. Tracking hashes the track id into a private 10-color list.
Object detection and segmentation read a per-label style list from the
viewer settings, and that list always contains a `default` entry colored
`#00ff00`, so every class without an explicit entry draws in the same green.
Pose estimation draws every person in aqua. Classification draws its text
in yellow. Crowded scenes are hard to read.

## Goal

One shared palette and mapping function. Each renderer supplies the value
that represents identity for its metadata type and receives a color.
Colors are stable across frames, distinct while the palette allows, safe
when identities outnumber the palette, and overridable by user settings.

## Decisions

- Automatic colors are allocated per channel on first sight, not hashed.
  Distinctness within a session is guaranteed up to the palette size. The
  same label may get a different color in another session or channel. This
  is accepted for now.
- Identities without a value (a pose or track with no `id`) draw in one
  neutral color. No index fallback, because index order can change between
  frames and the colors would flicker.
- A pose is drawn in one color for all its parts. No keypoint-group colors.
- Classification lines are colored by class label.
- The stock `default` style entry is removed from the defaults. Explicit
  label entries are overrides. A `default` entry a user recolored is kept
  as an override for all unlisted classes.
- CI runs both the viewer tests and the Python unittest suite.

## Shared color module

New file `webrtc/static/js/metadata-colors.js`, loaded in `viewer.html`
before `drawing.js`, in the same style as `viewer-settings-resolver.js`
(an IIFE that attaches an API to `window`). It exports on
`window.metadataColors`:

- `PALETTE`: about 20 hex colors chosen to stay distinguishable over
  video. The current `TRACK_COLORS` list is the seed.
- `NEUTRAL_COLOR`: used when identity is missing. `#f8fafc`, the current
  track fallback.
- `createColorAllocator()`: returns an allocator with
  - `colorFor(channelIndex, namespace, identity, now)`: returns a palette
    color. State is one map per `(channelIndex, namespace)` from identity
    string to `{ slot, lastSeen }`. A new identity takes the lowest free
    slot. When no slot is free, the identity with the oldest `lastSeen` is
    evicted and its slot reused, ties broken by insertion order. Every call
    updates `lastSeen`.
  - `clear()`: drops all state. Called wherever the viewer clears the track
    history today.
- `resolveColor({ allocator, channelIndex, namespace, identity, overrides, now })`:
  returns `overrides[identity]` when present, else `overrides.default`
  when present, else `NEUTRAL_COLOR` when identity is null, undefined or
  empty, else `allocator.colorFor(...)`. `overrides` is a plain object
  from label to color string, or absent.

The allocator instance lives in `ViewerApp.jsx` next to `trackHistoryRef`
and is passed to renderers through `drawContext.colorAllocator`. Renderers
fall back to a module-level allocator when `drawContext` has none, so the
tests and any non-React caller keep working.

## Identity per metadata type

| Type | Namespace | Identity | Override source |
|---|---|---|---|
| object-detection | `class` | `object.label` | `settings.type.objects` by label |
| segmentation | `class` | `segment.label` | `settings.type.objects` by label |
| classification | `class` | `top_class.label` | none |
| tracking | `track` | `track.id` | none |
| pose-estimation | `pose` | `pose.id` | none |

The `class` namespace is shared on a channel, so "person" has the same
color in detection, segmentation and classification. `track` and `pose`
have their own maps, so a busy tracking stream cannot exhaust the class
colors. ROI polygons keep their fixed green and red; they are not metadata.

The unused settings keys `poseStrokeColor`, `poseFillColor` and
`classificationColor` are removed from the renderers. Nothing writes them.

## Settings changes

`webrtc/static/js/viewer-settings-resolver.js`:

- `DEFAULT_OBJECTS` becomes `[]`. `mergeObjectStyles` no longer injects a
  `default` entry.
- `SETTINGS_VERSION` becomes 4. `normalizeSettings` and
  `settingsOverrides` accept versions 2, 3 and 4. When the incoming
  version is below 4, any `default` entry whose color is `#00ff00` is
  dropped from `object-detection` and `segmentation` object lists. Other
  `default` entries are kept unchanged.
- The `viewerSettings.test.js` cases that assert the injected default entry
  are updated to the new behavior, plus a case for the migration.

`webrtc/static/settings.js` and `viewer.html`: one hint line under each
object table: "Unlisted classes are colored automatically. Add a `default`
row to override them all." No new controls.

## Renderer changes in `drawing.js`

- Remove `TRACK_COLORS`, `TRACK_FALLBACK_COLOR` and `colorForTrackId`.
- object-detection and segmentation: build the override map from
  `settings.type.objects`. Per object, `style` is the label entry, else the
  `default` entry, else none. Color comes from `resolveColor` with the
  `class` namespace. Line width and dash come from `style` when present,
  otherwise width 2 and solid. Box, label text, mask fill and outline use
  the resolved color.
- classification: each line is drawn with `resolveColor` on its label in
  the `class` namespace.
- tracking: `resolveColor` in the `track` namespace for boxes, labels and
  trails, keyed by `track.id`. Trails of tracks no longer present resolve
  the same way, so a returning track keeps its color until evicted.
- pose-estimation: per pose, `resolveColor` in the `pose` namespace on
  `pose.id`. Apply it to skeleton lines, keypoint dots, keypoint names, a
  bounding box, and a label. The box is the min/max of keypoints with
  confidence above 0.3, padded by 8 source pixels, and is skipped when
  fewer than two keypoints qualify. The label is drawn with
  `drawTrackLabel` at the box top and reads `<label> #<id>`, or just
  `<label>` without an id, defaulting the label to `pose`.

## Test sender changes

`neat_insight/tools/metadata_test.py`:

- pose-estimation: three people with ids `pose_1` to `pose_3` at fixed
  positions, jittered slightly per frame.
- object-detection: four classes (`car`, `person`, `bicycle`, `dog`) at
  the four corner positions each frame.
- segmentation: labels `person`, `car`, `truck`.
- tracking: unchanged, three tracks.

## Automated tests

`frontend/src/viewer/metadataColors.test.js`, run by `npm run test:viewer`:

- Loads `metadata-colors.js` and `drawing.js` into a `vm` context with a
  `window` object, the way `rleMask.test.js` does, and stubs
  `window.resolveTypeSettings` to return chosen settings.
- A stub 2D context records `{ op, strokeStyle, fillStyle }` for every
  `strokeRect`, `fillText`, `stroke`, `fill`, `fillRect` and `arc` call, so
  each drawn item can be attributed to a color.
- Cases:
  - allocator: same identity same slot, distinct slots while free, oldest
    identity evicted when full, `clear()` resets.
  - tracking: three tracks over five frames keep their colors and differ.
  - detection: four classes differ, repeated across frames, and match the
    same labels in segmentation and classification on the same channel.
  - override: a per-label entry wins; a kept `default` entry wins for
    unlisted labels; the stock green default never appears.
  - pose: three people, each with box, label, skeleton and keypoints in
    one color, three different colors; a pose without id is neutral.
  - exhaustion: palette size plus five identities on one channel; all
    palette colors are reused, and the last palette-size identities seen
    in a frame are pairwise distinct.

Python: no new tests. The CI job runs the existing suite.

## CI

New `.github/workflows/tests.yml`, triggered on `pull_request` and on
`push` to `main`:

- `viewer-tests`: Node 20 with npm cache on `frontend/package-lock.json`,
  `npm ci` in `frontend`, `npm run test:viewer`.
- `python-tests`: Python 3.11, `pip install -e .`,
  `python -m unittest discover -s tests -v`.

Both are required to pass. No changes to `vulcan-ci.yml`.

## Documentation

- `docs/user-interface.md`: a "Metadata colors" subsection with the
  identity table, the override rules, the neutral color rule, and the note
  that senders must include `id` on tracks and poses to get per-instance
  colors.
- `README.md` and `skills/use-neat-insight/SKILL.md`: one line each
  pointing at that subsection, next to the existing metadata test sender
  usage.

## PR evidence

The PR description lists the test commands, the Insight ref, the sender
commands used, expected and observed colors per type, pass or fail per
test, a link to the CI run, and a screenshot per metadata type from the
real viewer with the extended test sender.

## Out of scope

- Hash-based or cross-session stable colors.
- Viewer-side matching of poses without ids.
- Keypoint-group coloring.
- Color controls for tracking, pose or classification.
