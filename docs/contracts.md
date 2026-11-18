---
title: Contracts
description: The rules an app follows to read Insight's streams and to show its video and AI metadata in Insight.
sidebar_position: 7
---

# Contracts

Insight serves video streams an app can read, and it shows the video and AI metadata (boxes,
classes, poses, masks, tracks) an app sends it. This page states the rules for both. An app that
follows them shows up in Insight with no change to Insight. Following them is optional: an app that
does not has no tile in Insight, and works as before.

This is **version 1** of the contracts. It is the interface the Insight backend and the Viewer
implement. Where today's build differs from it, [Open points](#open-points) says how.

| To | Use |
| --- | --- |
| Read a video Insight serves | `rtsp://<insight-host>:8554/srcN`, `N` from 1 to 48 ([Sources](#sources)) |
| Show your video on tile `N` | RTP over UDP to `<insight-host>:9000+N` ([Video](#video)) |
| Draw your results on tile `N` | JSON over UDP to `<insight-host>:9100+N` ([Metadata](#metadata)) |
| Look at it | `https://<insight-host>:9900/viewer` ([Viewing](#viewing)) |

```text
Insight source srcN ──RTSP──▶ your app ──RTP video, UDP 9000+N──────▶ Insight ──▶ browser, tile N
                                      └──JSON metadata, UDP 9100+N──▶
```

`<insight-host>` is the address of the machine Insight runs on, as your app reaches it. Inside the
Neat SDK container that is `127.0.0.1`; from a DevKit it is the SDK host's address, and the ports
may differ ([Port remapping](#port-remapping-in-the-sdk-container)).

## Minimal app

A pyneat app that reads one of Insight's sources, runs a detector on the board and shows the video
with its boxes on tile 1. Core's `VideoSender` and `MetadataSender` already follow the contracts,
so the app passes a host and a channel and nothing else.

```python
import json, struct
import pyneat

INSIGHT = "127.0.0.1"  # the machine running Insight
CHANNEL = 1            # tile 1: video to UDP 9001, metadata to UDP 9101

options = pyneat.ModelOptions()
options.preprocess.kind = pyneat.InputKind.Image
options.preprocess.color_convert.input_format = pyneat.PreprocessColorFormat.NV12
options.preprocess.preset = pyneat.NormalizePreset.COCO_YOLO
options.decode_type = pyneat.BoxDecodeType.YoloV26
model = pyneat.Model("yolo26n_mpk.tar.gz", options)  # your compiled detector

camera = pyneat.RtspDecodedInputOptions()
camera.url = "rtsp://127.0.0.1:8554/src1"            # an Insight source
video = pyneat.VideoSenderOptions.from_raw(pyneat.SimaEncodeOptions())
video.host = INSIGHT                                   # the video goes to Insight
video.channel = CHANNEL

graph = pyneat.Graph()
split = pyneat.graphs.branch("frames", ["video", "detector"])
graph.connect(pyneat.groups.rtsp_decoded_input(camera), split)
graph.connect(split, pyneat.Graph().connect(pyneat.nodes.input("video"), pyneat.groups.video_sender(video)))
detector = pyneat.Graph().connect(pyneat.nodes.input("detector"), model)
graph.connect(split, detector)
graph.connect(detector, pyneat.nodes.output("boxes"))
run = graph.build(pyneat.RunOptions())

metadata = pyneat.MetadataSenderOptions()
metadata.host = INSIGHT                                # the boxes go to Insight
metadata.channel = CHANNEL
insight = pyneat.MetadataSender(metadata)

while (sample := run.pull(timeout_ms=5000)) is not None:
    data = sample.tensors[0].copy_payload_bytes()      # a count, then (x, y, w, h, score, class) per box
    count = struct.unpack_from("<I", data)[0]
    boxes = [struct.unpack_from("<iiiif", data, 4 + 24 * i) for i in range(count)]
    objects = [{"label": "object", "confidence": s, "bbox": [x, y, w, h]} for x, y, w, h, s in boxes]
    insight.send_metadata("object-detection", json.dumps({"objects": objects}),
                          sample.pts_ns // 1_000_000,  # matches the boxes to their frame
                          str(sample.frame_id))
```

Only a few lines carry the contract: the source URL, `host` and `channel` on both senders, and
`send_metadata` with the type, the `data` object and `pts_ns // 1_000_000` as the timestamp. The
video and the metadata come from one `Run`, so the timestamp names the frame the encoder sent.

## Sources

A source is a video stream Insight serves, from a file in its media library, a browser's webcam
or a camera URL it pulls. You set sources up in Insight's Streaming page; an app reads them.

### RTSP

Source `N` is at:

```text
rtsp://<insight-host>:8554/srcN
```

- `N` runs from 1 to 48. There is no `src0`.
- The codec is H.264 or H.265, as the file or camera has it, and RTP/JPEG for an MJPEG file. A
  webcam is H.264 baseline at 30 fps with a keyframe every second.
- A file plays in a loop, in real time.
- Reading needs no credentials. In the SDK container Insight serves RTSP over TCP.
- Take the URL as a parameter of your app. Assume nothing else about Insight.

Neat apps read it with `RtspDecodedInput` (or `RtspEncodedInput` to pass the video on without
decoding).

### HTTP MJPEG

An MJPEG source is also served over HTTPS, as a multipart stream
(`multipart/x-mixed-replace`), on Insight's main port:

```text
https://<insight-host>:9900/stream/http/srcN.mjpg
```

Every reader gets the same live stream. Insight's certificate is its own (mkcert, or the SDK's),
so a Neat app reading it with `HttpMjpegDecodedInput` sets `ssl_strict = false` unless it trusts
that certificate authority.

### Publishing into a source

A program may publish its own stream into an unused source over RTSP, at the same URL. The first
publisher wins; a second one is refused. Insight shows such a source as External and warns unless
it is H.264, H.265 or MJPEG.

Browser webcams reach Insight over WHIP (on port 8889, ICE on UDP 8189). That is Insight's own
way in, used by its Streaming page, and not a contract for apps.

## Channels

A channel is one tile of the Viewer. An app shows up on channel `N` by sending its video and its
metadata to two UDP ports:

```text
video:     <insight-host>:9000 + N    RTP
metadata:  <insight-host>:9100 + N    JSON
```

Send the video and the metadata of one picture to the same `N`. Channel and source numbers are
separate: an app may read `src1` and show it on channel 1, as the example does, but nothing ties
the two.

### Channel numbers

Insight serves channels `0` to `C − 1`:

- On a DevKit, `C` is 80.
- In the SDK container, `C` is the number of channels the container publishes (`insightVideoChannels`
  in the SDK's port map, 4 by default, at most 80).

`GET /api/viewer-url` returns `C` as `max_video_channels`.

### Video

RTP ([RFC 3550](https://www.rfc-editor.org/rfc/rfc3550)) over UDP to `9000 + N`. Core's
`VideoSender` sends exactly this.

| Item | Rule |
| --- | --- |
| Codec | Chosen by the RTP payload type, since Insight reads no SDP: **96** is H.264 ([RFC 6184](https://www.rfc-editor.org/rfc/rfc6184): single NAL units, STAP-A, FU-A), **98** is H.265 ([RFC 7798](https://www.rfc-editor.org/rfc/rfc7798)). **26**, RTP/JPEG ([RFC 2435](https://www.rfc-editor.org/rfc/rfc2435)), is **planned**; until then such a tile waits. Insight ignores any other payload type. |
| Clock | 90 kHz. All packets of one picture share its RTP timestamp, and the last one has the marker bit set. |
| Keyframes | Send one (an IDR for H.264, an IRAP for H.265) at least every second. A viewer starts at the next keyframe and Insight cannot ask the app for one, so the keyframe interval is the longest a new viewer waits. |
| Parameter sets | In band, at least before every keyframe (SPS and PPS; VPS too for H.265). Core sends them every second (`config-interval=1`). |
| Packet size | Up to 65,507 bytes per datagram. Keep packets at about 1,400 bytes, as GStreamer's payloaders do, so they are not fragmented. |
| Senders | One sender per channel. A sender may restart at any time with a new SSRC, sequence and timestamps; the tile goes on playing. Changing the codec on a channel reconnects its viewers. |
| RTCP | None expected, none sent back. |
| Browser | The browser decodes the video. A browser without H.265 shows "Codec not supported by this browser" on an H.265 tile. Insight offers H.264 as constrained baseline but passes any profile the browser decodes. |

### Metadata datagrams

UTF-8 JSON over UDP to `9100 + N`, one [message](#metadata) per datagram or split into chunks.
Core's `MetadataSender` sends exactly this.

- **A whole message** is one datagram holding the JSON text, up to 65,507 bytes.
- **A chunked message** is split into datagrams of at most 1,200 bytes, each a 12-byte header and a
  piece of the JSON text. Core chunks every message over 1,200 bytes; do the same, since a lost IP
  fragment loses a large datagram whole.

| Byte | Size | Value |
| --- | --- | --- |
| 0 | 1 | `0x4e` (a JSON text never starts with it, which tells a chunk from a whole message) |
| 1 | 1 | Version, `0x01`. Other versions are dropped. |
| 2 | 8 | Message ID, unsigned, big-endian, unique per sender address while its chunks are in flight |
| 10 | 1 | Chunk index, from 0 |
| 11 | 1 | Chunk count, 1 to 56 |

Insight joins the chunks of one sender address and message ID in index order, in whatever order
they arrive. It drops a message whose chunks do not all arrive within 250 ms, whose joined size
passes 65,507 bytes, or that repeats a chunk with other content. It joins at most four messages per
channel at once and drops the oldest for a fifth.

### Port remapping in the SDK container

Inside the SDK container, use the ports on this page. Outside it (an app on a DevKit sending to
Insight in the SDK), `sima-cli` may have published them on other host ports. `neat --json` lists
them in `exposedPorts`:

| Port-map name | Use |
| --- | --- |
| `rtsp.tcp` | the RTSP port in a source URL |
| `mainUI` | the HTTPS port of the Viewer and the HTTP MJPEG URL |
| `videoUDP` | `hostPortStart + N` for channel `N`'s video |
| `metadataUDP` | `hostPortStart + N` for channel `N`'s metadata |

Pass them to your app: `video_port_base` on `VideoSenderOptions`, `metadata_port_base` on
`MetadataSenderOptions`. See [Ports and network behavior](ports-network.md) for the whole map.

## Metadata

A metadata message describes one video frame: the objects found in it, its class, its poses, its
masks or its tracks. Insight draws it over that frame.

### The envelope

```json
{
  "type": "object-detection",
  "timestamp": 12345,
  "frame_id": "370",
  "data": { "objects": [{ "label": "car", "confidence": 0.92, "bbox": [120, 80, 96, 64] }] }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | A string naming the overlay that draws the message: one of the [types](#types) below. |
| `data` | yes | An object, as the type defines it. |
| `timestamp` | no | Which frame the message describes ([Matching a message to its frame](#matching-a-message-to-its-frame)). Without it the message is drawn on the next frame shown. |
| `frame_id` | no | Your own frame identifier, any JSON value, a string recommended. Shown in diagnostics; never used to match. |
| `_insight` | never | Reserved. Insight adds it to what it forwards to the browser; do not send it. |

Core's `send_metadata(type, data_json, timestamp_ms, frame_id)` builds this envelope. It leaves
`timestamp` out for a negative value and `frame_id` out for an empty string.

A message is at most 65,507 bytes of JSON. Send at most one message of each type per frame: a
second one of the same type for the same frame replaces the first. Messages of different types for
one frame are all drawn.

### Matching a message to its frame

`timestamp` is the frame's presentation time in **whole milliseconds on its RTP clock**. For a Neat
sample:

```python
timestamp = sample.pts_ns // 1_000_000
```

The rule Insight applies: a message with `timestamp = T` describes the frame whose RTP timestamp
`R` satisfies

```text
| R − (T × 90 mod 2³²) | ≤ 90      (90 kHz ticks, the difference taken modulo 2³²)
```

and of several such frames, the closest. 90 ticks is 1 ms, the most the rounding down to whole
milliseconds loses, so the rule never picks a neighboring frame.

- **Core apps meet it with no work.** Core's RTP payloaders start at offset 0, so a frame's RTP
  timestamp is its PTS at 90 kHz, modulo 2³². It holds while the video and the metadata come from
  the same `Run`: the PTS your metadata uses must be the one `VideoSender` sent the frame with.
- **Other producers** (ffmpeg, a sender in another process) compute `T = R // 90` from the RTP
  timestamp they put on the frame.
- `T` is an integer. A number with a fraction, a string, or a time in another unit (seconds,
  nanoseconds, the wall clock) matches no frame.
- Either side may arrive first. Insight waits up to 5 s for the other, then drops the message and
  counts it. The tile says when messages match no frame.
- The browser holds the video back by its sync buffer (300 ms by default, a Viewer setting), so a
  message that lags its frame by less than that is still drawn on it. One that arrives after its
  frame was shown is late; the tile shows "Metadata late".
- Inference often runs slower than the video. A frame with no message of a type redraws that type's
  last message for up to 200 ms. Send an empty list (`"objects": []`) to clear the overlay at once.

Frame-accurate drawing needs a browser that reports each frame's RTP timestamp: Chromium-based
browsers (Chrome, Edge). Other browsers draw the newest message on each frame.

### Coordinates

All positions are **pixels of the video frame as sent**: the picture's own width and height, which
the browser reports as the video's size, with the origin at the top-left corner, x to the right and
y down. Fractions are allowed. Insight scales them with the picture to whatever size the tile has.

If your app scales the video before sending it, scale its results the same way. A box is
`[x, y, width, height]`, its top-left corner and its size.

Confidences run from 0 to 1 and are shown as percentages. The Viewer's confidence threshold hides
what scores below it; an entry without a confidence always passes.

### Types

Each type has a JSON Schema in [`schemas/metadata/`](schemas/metadata/), which validates a whole
message. They are strict on what the Viewer needs to draw and allow any other field.

| `type` | Draws | Schema |
| --- | --- | --- |
| `object-detection` | boxes with a caption, in the class color | [object-detection](schemas/metadata/object-detection.schema.json) |
| `classification` | the top three classes, top left | [classification](schemas/metadata/classification.schema.json) |
| `tracking` | boxes with the track's id and a trail, in the id's color | [tracking](schemas/metadata/tracking.schema.json) |
| `pose-estimation` | keypoints, links and a box, in the pose's color | [pose-estimation](schemas/metadata/pose-estimation.schema.json) |
| `segmentation` | filled masks with a caption, in the class color | [segmentation](schemas/metadata/segmentation.schema.json) |

The envelope alone: [envelope](schemas/metadata/envelope.schema.json).

#### object-detection

```json
{
  "type": "object-detection",
  "timestamp": 12345,
  "data": {
    "objects": [
      { "label": "car", "confidence": 0.92, "bbox": [120, 80, 96, 64] },
      { "label": "ship", "confidence": 0.91, "bbox": [558, 300, 164, 121], "oriented_bbox": [640, 360, 160, 50, 0.5] }
    ]
  }
}
```

`data.objects` is a list, one entry per detection:

| Field | Required | Meaning |
| --- | --- | --- |
| `bbox` | yes | `[x, y, width, height]` in video pixels. |
| `label` | no | The class name, in the caption. It picks the color, so a class has one color in every tile. |
| `confidence` | no | 0 to 1, in the caption and compared with the threshold. |
| `id` | no | Your identity for the detection. Not drawn. |
| `oriented_bbox` | no | **Planned.** A rotated box `[cx, cy, width, height, angle]`: its center and size in video pixels and its rotation in radians, a positive angle turning it clockwise on screen. The Viewer then draws it instead of `bbox`. Keep `bbox` as the rotated box's upright extent: it places the caption, drives the region-of-interest filter, and is what a viewer without rotated boxes draws. A value other than five finite numbers falls back to `bbox`. |

#### classification

```json
{
  "type": "classification",
  "timestamp": 12345,
  "data": { "top_classes": [{ "label": "cat", "confidence": 0.87 }, { "label": "dog", "confidence": 0.09 }] }
}
```

`data.top_classes` is a list, best first. The Viewer lists the first three in the frame's top-left
corner, each in its class color, with no threshold.

| Field | Required | Meaning |
| --- | --- | --- |
| `label` | yes | The class name. |
| `confidence` | no | 0 to 1, shown as a percentage. |

#### tracking

```json
{
  "type": "tracking",
  "timestamp": 12345,
  "data": { "tracks": [{ "id": "7", "label": "drone", "confidence": 0.81, "bbox": [412, 96, 38, 22] }] }
}
```

`data.tracks` is a list, one entry per track seen on the frame. Each track is drawn as a box with a
caption (`drone #7 (81%)`) and a trail of its recent centers, in its id's color.

| Field | Required | Meaning |
| --- | --- | --- |
| `bbox` | yes | `[x, y, width, height]` in video pixels. An entry without four finite numbers is skipped. |
| `id` | no, but needed for a trail | The track's identity, a string or an integer, stable while the track lives. It picks the color and keeps the trail. |
| `label` | no | In the caption; `track` when absent. |
| `confidence` | no | 0 to 1, in the caption and compared with the threshold. |

A trail ends a while after its track stops appearing (a Viewer setting).

#### pose-estimation

```json
{
  "type": "pose-estimation",
  "timestamp": 12345,
  "data": {
    "poses": [
      {
        "id": "person_1",
        "label": "person",
        "keypoints": [
          { "name": "left_shoulder", "x": 300, "y": 210, "confidence": 0.94 },
          { "name": "left_elbow", "x": 286, "y": 268, "confidence": 0.88 },
          { "name": "left_wrist", "x": 279, "y": 320, "confidence": 0.71 }
        ]
      }
    ]
  }
}
```

`data.poses` is a list, one entry per body or hand. The Viewer draws each keypoint, links named
pairs, and boxes the keypoints whose confidence is above 0.3.

| Field | Required | Meaning |
| --- | --- | --- |
| `keypoints` | yes | A list of `{name, x, y, confidence}`: `x` and `y` (required) in video pixels; `confidence` (0 to 1) fades the point and its links. |
| `keypoints[].name` | no | Links are drawn between the [COCO body names](#keypoint-names) and between the MediaPipe hand names. Any other name is drawn as a point. |
| `id` | no | The pose's identity. It picks the color and shows in the caption (`person #person_1`). |
| `label` | no | In the caption; `pose` when absent. |
| `bbox`, `confidence` | no | Accepted and not drawn in version 1. |

##### Keypoint names

- **Body (COCO 17):** `nose`, `left_eye`, `right_eye`, `left_ear`, `right_ear`, `left_shoulder`,
  `right_shoulder`, `left_elbow`, `right_elbow`, `left_wrist`, `right_wrist`, `left_hip`,
  `right_hip`, `left_knee`, `right_knee`, `left_ankle`, `right_ankle`.
- **Hand (MediaPipe 21):** `wrist`, `thumb_cmc`, `thumb_mcp`, `thumb_ip`, `thumb_tip`,
  `index_finger_mcp`, `index_finger_pip`, `index_finger_dip`, `index_finger_tip`,
  `middle_finger_mcp`, `middle_finger_pip`, `middle_finger_dip`, `middle_finger_tip`,
  `ring_finger_mcp`, `ring_finger_pip`, `ring_finger_dip`, `ring_finger_tip`, `pinky_mcp`,
  `pinky_pip`, `pinky_dip`, `pinky_tip`.

The two sets share no name, so a pose needs no kind: send a hand's names for a hand.

#### segmentation

```json
{
  "type": "segmentation",
  "timestamp": 12345,
  "data": {
    "segments": [
      { "label": "person", "confidence": 0.9, "mask_format": "polygon", "mask": [[100, 50], [180, 60], [170, 240], [95, 230]] },
      { "label": "car", "confidence": 0.8, "bbox": [300, 200, 120, 60], "mask_format": "rle", "mask": { "size": [3, 4], "counts": [1, 2, 3, 3, 3] } }
    ]
  }
}
```

`data.segments` is a list, one entry per instance. The Viewer fills each mask at its mask opacity,
outlines a polygon, and captions it in its class color.

| Field | Required | Meaning |
| --- | --- | --- |
| `mask_format` | yes | `polygon` or `rle`. A segment with another value is skipped. |
| `mask` | yes | For `polygon`: `[[x, y], ...]` in video pixels, at least three points. For `rle`: see below. |
| `bbox` | for `rle` | `[x, y, width, height]` in video pixels. It places the caption and drives the region-of-interest filter. A polygon without one uses its extent. |
| `label` | no | The class name, in the caption; it picks the color. |
| `confidence` | no | 0 to 1, in the caption and compared with the threshold. |
| `id` | no | Names the segment in the browser console's warnings. |
| `show_rectangle` | no | `true` also outlines `bbox`. Only the boolean `true` does. |

An **RLE mask** is `{"size": [height, width], "counts": [run, run, ...]}`, uncompressed:

- It covers the `bbox` rectangle, not the frame, and is stretched over it. Send it at the mask
  head's resolution, at most 2048 × 2048 cells.
- The runs go over the mask column by column (column-major). The first run is background, then
  runs alternate between mask and background.
- `counts` is a JSON array of integers, not the compressed string `pycocotools.mask.encode()`
  returns.

The Viewer warns once per channel and segment in the browser console when it cannot draw an RLE
mask. Polygons with many points grow large: Core's segmentation examples keep a frame's message
under 32 KB by dropping the lowest-scoring segments.

### What Insight ignores

- **A type it does not know:** the message is skipped, with one browser console warning per channel
  and type.
- **A field it does not know**, at the top level or inside `data`: kept as it is and not used.
- **A message without a string `type`, or that is not a JSON object:** dropped.

### Changes to the contract

Changes are additive: a new type, a new optional field. A message valid in version 1 stays valid
and is drawn the same way. A version field comes with the first change that would break a version
1 message, not before; a message without one is version 1.

## Viewing

The Viewer is on Insight's main port:

```text
https://<insight-host>:9900/viewer
```

It shows every channel, a page of tiles at a time. Its URL parameters, all optional:

| Parameter | Meaning |
| --- | --- |
| `src` | The channels to show, in order: `src=1` shows channel 1 alone, `src=3,0` shows 3 then 0. |
| `max_channels` | How many channels to offer, 1 to 80. Insight sets it in the links it makes. |
| `mode` | `light` or `dark`, for this page load. |
| `debug` | `1` logs connection events to the browser console. |

`GET /api/viewer-url?src=1&mode=dark` returns `{"url": ..., "max_video_channels": ...}`: a Viewer
link on the address the caller reached Insight on (or on the public address a hosted Insight has).

The browser receives the video over WebRTC from Insight's own UDP ports. In the SDK container they
are published as `webRTC` in the port map; the browser must reach them.

## Open points

Places where the code, Core's docs and the apps disagree, or where this document chose. Each says
what disagrees, the choice, and why.

1. **Match tolerance.** The design draft said "within one frame"; vf matches within 90 ticks (1 ms)
   and takes the closest (vf's `metadata_sync.go`, since removed). *Choice:* 90 ticks. *Why:* it is the most
   the rounding to milliseconds loses; a frame-wide window would match a neighboring frame at high
   frame rates. *Now:* the server's channels match this way.
2. **Stamping on arrival.** The design's default for the new backend is to stamp each message on
   arrival with `T × 90 + offset`. The kit draws a message only on a frame whose RTP timestamp
   equals `_insight.rtp_timestamp` exactly (`metadata-sync.ts`), and `T × 90` is up to 89 ticks
   below the frame's. *Choice:* the contract keeps the rule in [Matching](#matching-a-message-to-its-frame);
   the backend must stamp the matched frame's outgoing time, so it keeps recent frames' times per
   channel (no frame buffering), or the kit gains a tolerance. *Why:* the producer's side must not
   change. The 5 s wait is vf's value (also capped at 256 entries, about 2.5 s at 100 messages a
   second). *Now:* the server keeps the last 5 s of frames' times per channel and stamps a matched
   message with its frame's outgoing time; no frames are held back.
3. **Whole numbers written with a fraction.** vf decodes `timestamp` as an int64, so `12345.0`
   (Python's `json.dumps` of a float) fails the whole envelope and the message is drawn by arrival.
   JSON Schema counts `12345.0` as an integer. *Choice:* Insight accepts any whole number.
   *Why:* one rule for the schema and the backend. *Now:* the server accepts them.
4. **Silent loss on a wrong timestamp.** A float is drawn by arrival order, which hides the
   mistake; an integer in the wrong unit is held 5 s and dropped, visible only in
   `expired_metadata` of vf's verbose ingest stats. `neat_insight/tools/metadata_test.py` sends
   `time.time()` seconds. *Choice:* integer milliseconds as stated; Insight counts unmatched
   messages per channel and the tile says so (the design's "says so on the tile"; not built yet).
   The test tool follows the contract when it is rewritten. *Now:* `/api/channels` counts
   `unmatched` per channel; the tile does not say so yet.
5. **Negative timestamps.** Core's `send_metadata` leaves `timestamp` out for a negative value;
   the apps' `support/object_detection/detection_egress.h` writes `-1` itself; vf treats a negative
   value as absent. *Choice:* negative means absent, and the schema allows any integer. *Why:* it
   is what every receiver already does; the doc recommends leaving the field out.
6. **Required envelope fields.** Core's doc requires `type` and `data`; vf requires neither; the kit
   needs only a string `type`. *Choice:* `type` and `data` required. *Why:* Core's sender enforces
   both, and every type reads `data`.
7. **A producer's `_insight`.** vf overwrites `_insight` only on a matched message; an unmatched or
   untimestamped one keeps a producer's, and the kit trusts it. *Choice:* reserved; Insight removes
   it from every incoming message. *Why:* a producer must not be able to pick the frame by
   Insight's internal clock. *Now:* the server removes it.
8. **Other timing fields.** The high-density detector also sends top-level `rtp_timestamp`,
   `pts_ns`, `stream_id` and more (`detection_egress.h`). *Choice:* ignored; `timestamp` is the one
   key. *Why:* two ways to say one thing; `rtp_timestamp` is a third name beside `timestamp` and
   `_insight.rtp_timestamp`.
9. **`frame_id`.** A string from Core, an integer from `scripts/test_feed_metadata.py`; nothing uses
   it. *Choice:* any JSON value, a string recommended, diagnostics only.
10. **Trailing NUL bytes.** vf strips them from every message, for fixed-size padded senders; no
    sender in the public repos pads. *Choice:* not part of the contract; the new backend drops
    the trimming unless a producer that needs it turns up. *Now:* the server does not trim.
11. **RTP datagram size.** vf reads RTP into a 4 KiB buffer and truncates a larger datagram without
    a sign; Insight's older docs state "at most 4096 bytes". *Choice:* up to 65,507 bytes, about
    1,400 recommended. *Why:* a truncation is a bug, not a limit anyone chose. *Now:* the server
    reads datagrams of any size.
12. **RTP/JPEG (payload type 26).** Core's `video_sender.md` says Insight's viewer shows MJPEG
    "in releases after v0.0.8"; Core's `node.mdx` says it does not; USB-camera apps send it;
    insight-next's vf drops it, so the tile waits forever. Upstream insight added JPEG channels
    after insight-next's copy. *Choice:* planned, in a later phase; until then Insight's channel
    list reports the unsupported payload type (`/api/channels`: `payload_type`,
    `unsupported_packets`). Core's docs need an update outside Insight.
13. **Keyframe interval.** "At least every second" is the target. Core's `SimaEncodeOptions` leaves
    `gop_length` and `idr_interval` unset by default, which keeps the hardware encoder's own
    default (not documented as a value; `idr_interval = 0` means three times the frame rate).
    Insight's file sources copy the file's keyframes, however sparse. *Choice:* a recommendation
    ("send"), not a requirement Insight checks. *Why:* nothing breaks with fewer keyframes; a new
    viewer waits longer. Not verified on a board: which encoder setting gives an IDR every second.
14. **H.264 profile.** vf offers H.264 as constrained baseline 3.1 (`42e01f`) whatever the stream
    is; browsers decode main and high in practice. *Choice:* any profile the browser decodes, not
    checked.
15. **Channel count.** vf binds all 80 channels everywhere; Insight's docs and the SDK say
    `9000-9079`; `sima-cli` publishes 4 channels by default, so a DevKit app on channel 4 or above
    gets no tile. *Choice:* channels `0` to `C − 1` as Insight resolves `C` (80 on a DevKit, the
    published count in the SDK), stated by `/api/viewer-url`. *Why:* one number everywhere, the
    design's default. *Now:* the server binds channels `0` to `C − 1` only.
16. **Sources from 1, channels from 0.** One apps config comment names `/src0`
    (`single-stream-thermal-face-detector`). *Choice:* keep both numberings. *Why:* apps, docs and
    tests use both; this page says they are separate.
17. **HTTP MJPEG.** Today only an MJPEG file source set to the HTTP transport serves it, and every
    reader gets its own ffmpeg playing the file from its start. *Choice:* every MJPEG source, one
    shared live stream (the design's default). The single-frame route `/stream/http/srcN.jpg`
    exists today with no known consumer and is left out of the contract.
18. **Port 8554 on a board.** Neat's own RTSP server also defaults to 8554, and Insight kills
    whatever holds its ports at start. *Choice:* the source URL keeps 8554; the new backend stops
    killing other programs and reports the port as taken. An app running its own RTSP server
    beside Insight picks another port.
19. **Liveness.** "Hide empty slots" counts video only, so a channel with metadata and no video is
    hidden. *Choice:* Insight's channel list reports video and metadata separately, so the Viewer
    can say "metadata, no video". *Now:* `/api/channels` does; the Viewer still hides by video.
20. **Tracking in Core's docs.** `metadata_sender.md` says Insight's tracking overlay "is tracked
    separately in `sima-neat/insight#8`"; the Viewer draws `tracking`, and the tracking examples
    send it. *Choice:* part of version 1. Core's doc needs an update outside Insight.
21. **`oriented_bbox`.** The OBB detector example sends it; upstream insight draws it; the kit does
    not, so insight-next draws `bbox`. *Choice:* an optional field of version 1 with upstream's
    definition, marked planned until the kit draws it. *Why:* apps send it today, and `bbox` keeps
    them correct meanwhile.
22. **Captions with a missing label or confidence.** The kit's detection and segmentation captions
    read `undefined (NaN%)` when either is missing; tracking leaves them out. *Choice:* both
    optional, as tracking treats them. The kit's two captions leave out what is missing (a kit
    change).
23. **Pose box and confidence.** The pose examples send a pose `bbox` and `confidence`; the kit
    ignores both and boxes the keypoints instead. A keypoint without a confidence is drawn as fully
    confident but never counts toward the box. *Choice:* both pose fields optional and not drawn in
    version 1; a keypoint without a confidence should count as confident for the box too (a kit
    change).
24. **`auxiliary-visualization`.** The BlazePose 3D example sends it; insight-next draws nothing
    for it, while the kit's queue still keys it by `data.id`. *Choice:* not a type of version 1,
    ignored as an unknown type. The kit's special case can go.
25. **RLE masks.** No app sends them; only Insight's test tool does. *Choice:* kept, since the kit
    draws them and large masks need them. Not verified end to end with a real producer.
26. **Metadata ports' reach.** Insight binds its UDP ports on all interfaces, with no
    authentication, as the RTSP sources have none. *Choice:* stated as is; Insight is a developer
    tool for a trusted network (the design's decision on network access).
