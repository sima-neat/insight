# Insight mediaserver

`mediaserver` is a standalone container for looping prerecorded sources. It serves interleaved RTSP over TCP on port 8554 and multipart MJPEG over HTTP on port 8088. For the colo deployment, point `colo-rtsp` and `colo-http` at the published TCP endpoints.

## Run

```sh
docker run -d --name mediaserver --restart unless-stopped \
  --read-only --tmpfs /tmp \
  --mount "type=bind,source=/path/to/media,target=/media,readonly" \
  -p 8554:8554/tcp -p 8088:8088/tcp \
  ghcr.io/sima-neat/insight-mediaserver:latest
```

The mounted files must be readable by UID 10001. Put the listeners on a trusted network or bind the published ports to a dedicated interface. The container accepts anonymous viewers, restricts RTSP publishing to loopback, and exposes MediaMTX’s management API only on loopback. RTSP/UDP, WebRTC, SRT, HLS, and RTMP are disabled.

At startup the server scans the top level of `/media` for supported video files and assigns sorted, zero-based `srcN` IDs independently for each protocol. RTSP accepts H.264, HEVC, and RTP-compatible MJPEG. Automatic HTTP discovery selects MJPEG AVI files. Restart the container to rescan. Use pre-encoded renditions with regular keyframes for fast RTSP startup.

For a stable deployment, put a `mediaserver.json` in the volume. Map the legacy RTSP and HTTP IDs separately during a migration. Paths must be relative to the media volume and may reference subdirectories. An invalid manifest fails startup.

```json
{
  "schema_version": 1,
  "sources": [
    {"protocol": "rtsp", "id": "src0", "file": "video-avc.mp4"},
    {"protocol": "http", "id": "src0", "file": "video-mjpeg.avi"}
  ]
}
```

- RTSP playback at `rtsp://colo-rtsp:8554/src0`. Configure the player for TCP.
- MJPEG playback at `http://colo-http:8088/src0.mjpeg`. The HTTP index and `/streams.json` list sources.
- `/healthz` returns the latest local status and responds with HTTP 503 during startup or when a configured source is unavailable. `MEDIASERVER_HTTP_MAX_READERS` sets the concurrent HTTP viewer limit (default 64).

## Discover streams

Fetch the combined RTSP and HTTP catalog from `GET /media-sources.json` on
port 8088. On a Kerrigan-managed DevKit, read `http.discovery_url` from
`/etc/colo-services.json`.

```sh
curl -fsS "$(jq -r .http.discovery_url /etc/colo-services.json)" |
  jq -r '.links["h264-rtsp"][]'
```

The `links` object contains ready-to-use playback URLs. Each key is always
present. A group with no configured sources has an empty array.

```json
{
  "h264-rtsp": ["rtsp://media.example:8554/src0"],
  "h265-rtsp": ["rtsp://media.example:8554/src1"],
  "mjpeg-rtsp": ["rtsp://media.example:8554/src2"],
  "mjpeg-http": ["http://media.example:8088/src0.mjpeg"]
}
```

The same response includes `schema_version` and `sources`. Each source has its
own `url` alongside its ID, transport, codec, path, and container listener
port. Dimensions and the numeric frame rate are included when available.
Source IDs are unique within each transport. Use explicit manifest IDs for
fixtures that need to stay stable when the mounted inventory changes.

By default, HTTP links use the host and port in the discovery request, and RTSP
links use that hostname with TCP port 8554. Set `MEDIASERVER_RTSP_ORIGIN`
(for example, `rtsp://colo-rtsp.example:9554`) or `MEDIASERVER_HTTP_ORIGIN`
(for example, `https://colo-http.example`) when clients use different hosts,
published ports, or an HTTPS proxy. Set these on the mediaserver container
that serves discovery.

The catalog describes the media inventory loaded at startup. Check `/healthz`
for current readiness. The existing `/streams.json` endpoint continues to
list HTTP MJPEG sources.

For Kerrigan-managed DevKits, allow TCP 8554 and 8088 to the deployed colo address in the effective DevKit egress policy. Verify the destination DNS and playback from a managed DevKit.

## IoT reporting

### Provision the AWS IoT identity

Create a dedicated AWS IoT Thing named `colo-media` in the target account and
region. Create and activate an X.509 client certificate, attach it to the Thing,
and save the client certificate, private key, and Amazon Root CA 1 PEM file.
Attach an IoT policy to the certificate with the following permissions. Replace
`REGION` and `ACCOUNT_ID` with the values for the target account.
[AWS IoT setup guide](https://docs.aws.amazon.com/iot/latest/developerguide/create-iot-resources.html)

| Action | Resource |
| --- | --- |
| `iot:Connect` | `arn:aws:iot:REGION:ACCOUNT_ID:client/colo-media` |
| `iot:Publish` | `arn:aws:iot:REGION:ACCOUNT_ID:topic/insight/production/mediaservers/colo-media/status` |

Get the broker hostname using the same AWS account and region.
[AWS IoT endpoint documentation](https://docs.aws.amazon.com/iot/latest/developerguide/server-authentication.html)

```sh
aws iot describe-endpoint --region YOUR_REGION \
  --endpoint-type iot:Data-ATS --query endpointAddress --output text
```

### Configure the container

Save `profile.json` alongside the three PEM files and replace the example
endpoint with the hostname returned above. The certificate paths are relative to
the profile. The container uses `service_id` as its MQTT client ID and connects
over TCP port 8883 by default. If you change the service ID or environment,
update the policy to match.

```json
{
  "service_id": "colo-media",
  "environment": "production",
  "endpoint": "YOUR_DATA_ATS_HOSTNAME",
  "ca_certs": "AmazonRootCA1.pem",
  "certfile": "client.pem",
  "keyfile": "client.key"
}
```

Keep the private key restricted and give container UID 10001 read access to the
profile and credential files. Add these options to the `docker run` command
above, before the image name.

```sh
--mount "type=bind,source=/absolute/path/to/iot-profile,target=/run/mediaserver-iot,readonly" \
-e MEDIASERVER_IOT_PROFILE=/run/mediaserver-iot/profile.json
```

### Verify delivery

In the AWS IoT console's MQTT test client, subscribe to
`insight/production/mediaservers/colo-media/status`. Start the container and
look for a JSON snapshot within about 30 seconds of connecting.

The reporter connects over mutual TLS and sends a QoS 1 snapshot every 30 seconds. The snapshot includes readiness, configured and ready source counts, active playback readers, byte counters, version, and uptime. Each snapshot also lists the first 48 catalog entries with their stream IDs, transports, and codecs. The `catalog_truncated` flag indicates when the HTTP discovery catalog contains more entries. RTSP publishers are excluded from reader counts. The HTTP byte counter accumulates JPEG payload bytes. The RTSP total sums MediaMTX path counters, which can reset when paths restart. Playback continues if the broker is unavailable.

Saving snapshots to S3 requires a separate IoT Rule. For NeatOps, store the
latest snapshot per service with the broker receipt timestamp so the dashboard
can identify stale reports.

## Build and publish

```sh
docker build -t insight-mediaserver:local mediaserver
bash mediaserver/smoke.sh insight-mediaserver:local
```

The GitHub Actions workflow runs playback and viewer-count smoke tests on Linux amd64 and arm64. After both pass, pushes to `develop` publish `:develop`, pushes to `main` publish `:latest`, and tags such as `mediaserver-v1.2.3` publish `:1.2.3`. Published builds also get a commit SHA tag. The workflow uses the repository’s GitHub token for GHCR.
