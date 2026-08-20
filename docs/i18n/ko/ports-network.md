---
title: "포트 및 네트워크 동작"
description: "Insight 포트 사용 방식, 채널 매핑, SDK 포트 재매핑을 이해합니다."
sidebar_position: 5
---

# 포트 및 네트워크 동작

Insight는 일반적인 작동 중에 여러 포트를 사용합니다. 기본 포트는 SDK 컨테이너 내부 또는 직접 설치된 DevKit에서 사용되는 포트입니다. Neat 개발 환경에서 SDK는 해당 서비스를 호스트 포트에 게시합니다. 기본 호스트 포트가 이미 사용 중인 경우, `sima-cli`는 다른 사용 가능한 호스트 포트를 할당할 수 있습니다.

![ 브라우저 클라이언트, Modalix DevKit, SDK 호스트 머신, SDK 컨테이너 간의 Insight 포트 및 네트워크 경로.](images/insight-ports-network.jpg)

| 포트 맵 이름 | 기본 포트 또는 포트 범위 | 프로토콜 | 목적 |
| --- | --- | --- | --- |
| `mainUI` | `9900` | HTTPS/TCP | 주요 Insight 웹 UI, HTTP API 및 HTTP MJPEG 스트리밍 소스입니다. |
| `videoUI` | `8081` | HTTPS/TCP | WebRTC 비디오 뷰어 사용자 인터페이스. |
| `rtsp.tcp` | `8554` | RTSP/TCP | 업로드된 미디어에서 생성된 RTSP 스트리밍 소스입니다. |
| `videoUDP` | `9000-9079` | UDP | 시청자 채널을 위한 비디오 RTP 콘텐츠 업로드 `0-79`. |
| `metadataUDP` | `9100-9179` | UDP | 뷰어 채널을 위한 메타데이터 JSON 가져오기 `0-79`. |
| `webRTC` | `40000-40199` | UDP | WebRTC 미디어 및 메타데이터가 비디오 프레임워크에서 브라우저로 전송되는 DataChannel. |
| `webSSH` | `8022` | HTTPS/TCP | 사용 가능한 경우 브라우저 셸을 페어링된 DevKit로 연결합니다. |

## 실제 SDK 포트 맵을 찾아보세요.

SDK에서 기본 호스트 포트가 사용 가능하다고 가정하지 마십시오. 다음 명령을 실행하십시오.

```bash
neat --json
```

출력 결과에는 `insight.webUiUrl`과 `exposedPorts` 배열이 포함됩니다.

```json
{
  "exposedPorts": [
    {"hostPortEnd": null, "hostPortStart": 9900, "name": "mainUI", "protocol": "tcp"},
    {"hostPortEnd": 9179, "hostPortStart": 9100, "name": "metadataUDP", "protocol": "udp"},
    {"hostPortEnd": null, "hostPortStart": 8554, "name": "rtsp.tcp", "protocol": "tcp"},
    {"hostPortEnd": 9079, "hostPortStart": 9000, "name": "videoUDP", "protocol": "udp"},
    {"hostPortEnd": null, "hostPortStart": 8081, "name": "videoUI", "protocol": "tcp"},
    {"hostPortEnd": 40199, "hostPortStart": 40000, "name": "webRTC", "protocol": "udp"},
    {"hostPortEnd": null, "hostPortStart": 8022, "name": "webSSH", "protocol": "tcp"}
  ],
  "insight": {
    "serviceState": "Running",
    "venv": "/opt/neat-insight/venv",
    "webUiUrl": "https://10.0.0.210:9900"
  }
}
```

호스트 포트가 재매핑된 경우, `hostPortStart` 값은 외부 클라이언트가 사용해야 하는 포트입니다. `hostPortEnd`는 비디오, 메타데이터, WebRTC와 같은 포트 범위에 사용됩니다.

## 채널 매핑

비디오 뷰어는 쌍으로 연결된 비디오 및 메타데이터 포트를 사용합니다. 채널 `N`의 경우:

```text
video:    UDP 9000 + N
metadata: UDP 9100 + N
```

예를 들어:

| 시청 채널 | 비디오 포트 | 메타데이터 포트 |
| --- | --- | --- |
| `0` | `9000` | `9100` |
| `1` | `9001` | `9101` |
| `2` | `9002` | `9102` |

비디오와 메타데이터 간에 채널 번호를 일관되게 유지하십시오. 애플리케이션이 채널 `3`로 비디오를 전송하는 경우, 해당 메타데이터를 채널 `3`의 메타데이터 포트로 전송하십시오.

## SDK 포트 매핑

Neat 개발 환경에서 SDK 컨테이너가 포트를 재매핑할 수 있습니다. Insight는 사용 가능한 경우 SDK 포트 매핑 구성을 읽어 UI 링크가 브라우저에서 접근 가능한 호스트 포트를 가리키도록 합니다.

이는 특히 비디오 뷰어에 중요합니다. 내부 기본 뷰어 포트는 `8081`이지만, SDK가 `videoUI`를 다른 호스트 포트에 매핑하는 경우 브라우저에 표시되는 포트가 다를 수 있습니다.

Insight UI의 시스템 정보를 사용하여 URL이 잘못되었다고 가정하기 전에 실제 노출된 포트를 확인하십시오.

## 포트 맵을 사용하여 애플리케이션을 구성합니다.

애플리케이션 위치를 기준으로 기본 컨테이너 포트 또는 SDK 호스트에서 노출된 포트를 사용할지 결정합니다.

| 애플리케이션 위치 | Insight에서 제공하는 RTSP 입력 | 비디오/메타데이터를 Insight로 출력합니다. |
| --- | --- | --- |
| SDK 컨테이너 내부 | `rtsp://127.0.0.1:8554/srcN` | `127.0.0.1:9000 + channel` 및 `127.0.0.1:9100 + channel` |
| DevKit 또는 다른 외부 장치에서 | `rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/srcN` | `<sdk-host-ip>:<videoUDP hostPortStart + channel>` 및 `<sdk-host-ip>:<metadataUDP hostPortStart + channel>` |

HTTP MJPEG 소스는 주 Insight UI/API 포트를 사용합니다. SDK에서 해당 URL에 대해 `neat --json`의 `mainUI` 호스트 포트를 사용하십시오.

예를 들어, `neat --json`에서 다음과 같이 보고하는 경우:

```json
{"name": "rtsp.tcp", "hostPortStart": 18554, "protocol": "tcp"}
{"name": "videoUDP", "hostPortStart": 19000, "hostPortEnd": 19079, "protocol": "udp"}
{"name": "metadataUDP", "hostPortStart": 19100, "hostPortEnd": 19179, "protocol": "udp"}
```

그러면 DevKit에서 실행되는 애플리케이션은 다음을 사용해야 합니다.

```text
RTSP source src1:   rtsp://<sdk-host-ip>:18554/src1
video channel 0:    <sdk-host-ip>:19000
metadata channel 0: <sdk-host-ip>:19100
video channel 3:    <sdk-host-ip>:19003
metadata channel 3: <sdk-host-ip>:19103
```

애플리케이션과 Insight가 동일한 SDK 컨테이너에서 실행되는 경우 기본 로컬 포트를 사용하세요.

## 관련 도구

- **Neat 개발 환경**은 컨테이너화된 빌드 및 실행 환경을 제공하며, 여기에서 Insight가 함께 제공됩니다.
- **Neat 라이브러리**는 비전 워크로드를 구축하고 실행하는 데 사용되는 애플리케이션 API를 제공합니다.
- **sima-cli**는 Insight 패키지와 기타 Neat 아티팩트를 설치하고 업그레이드합니다.
- **모델 컴파일러 및 LLiMa**는 모델 결과물을 생성하며, 사용자는 작업 공간을 통해 이러한 결과물을 검토하고, Insight와 함께 실행되는 애플리케이션을 통해 유효성을 확인할 수 있습니다.
