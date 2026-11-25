FROM bluenviron/mediamtx:1.14.0@sha256:206139c58377b7544d6ef63f8af86bcf46b9e89262aaa6f7513e1347dbab7d36 AS rtsp
FROM alpine:3.23

RUN apk add --no-cache ca-certificates ffmpeg py3-paho-mqtt \
    && addgroup -g 10001 media \
    && adduser -D -H -u 10001 -G media media
COPY --from=rtsp /mediamtx /usr/local/bin/mediamtx
COPY server.py mediamtx.yml /opt/mediaserver/

ARG VERSION=dev
ENV MEDIASERVER_VERSION=${VERSION} PYTHONUNBUFFERED=1
LABEL org.opencontainers.image.source="https://github.com/sima-neat/insight" \
      org.opencontainers.image.title="Insight mediaserver"

USER 10001:10001
EXPOSE 8554/tcp 8088/tcp
ENTRYPOINT ["python3", "/opt/mediaserver/server.py"]
