---
title: "일반적인 작업 흐름"
description: "Insight를 사용하여 단일 스트림 앱, 다중 스트림 앱, 누락된 비디오 또는 메타데이터를 검증합니다."
sidebar_position: 4
---

# 일반적인 작업 흐름

## 표준 테스트 비디오를 가져옵니다.

예시, 연기 테스트 또는 다중 스트림 검증에 사용할 수 있는 반복 가능한 미디어가 필요할 때는 표준 비디오 세트를 사용하세요.

```text
https://artifacts.sima-neat.com/assets/videos/720p16/video01.mp4
...
https://artifacts.sima-neat.com/assets/videos/720p16/video16.mp4

https://artifacts.sima-neat.com/assets/videos/480p30/video01.mp4
...
https://artifacts.sima-neat.com/assets/videos/480p30/video16.mp4
```

수동으로 사용하려면 필요한 파일을 다운로드하여 미디어 소스에서 업로드하십시오.

API 기반 설정의 경우, 다음을 확인하십시오. Insight 이미 미디어 파일이 있습니다.

```bash
curl -k https://127.0.0.1:9900/api/media-files
```

미디어 라이브러리가 비어 있으면 표준 비디오를 다운로드하여 업로드하십시오.

```bash
tmpdir="$(mktemp -d)"
curl -fL "https://artifacts.sima-neat.com/assets/videos/480p30/video01.mp4" \
  -o "${tmpdir}/video01.mp4"
curl -k -F "file=@${tmpdir}/video01.mp4" \
  https://127.0.0.1:9900/api/upload/media
```

다른 파일에 대해서도 이 과정을 반복하거나, 더 많은 미디어 파일을 한 번에 업로드하려면 압축 파일을 업로드하세요.

## 단일 스트림 비전 앱을 검증합니다.

1. Insight를 엽니다.
2. 미디어 소스로 이동하여 짧은 테스트 비디오를 업로드하세요.
3. 스트리밍 소스로 이동하여 비디오를 `src1`에 할당합니다.
4. 시작 `src1`.
5. 올바른 RTSP URL을 사용하여 애플리케이션을 실행하세요.
   - SDK 컨테이너 내부: `rtsp://127.0.0.1:8554/src1`
   - DevKit 또는 외부 장치에서: `rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src1`
6. 비디오 뷰어를 열고 채널 `0`을 시청하세요.
7. 앱에서 메타데이터를 전송하는 경우, 비디오에 오버레이가 표시되는지 확인하세요.
8. 다음 버전에서 시스템 부하 진단 정보가 표시될 위치를 확인하려면 ‘통계’ 자리 표시자를 사용하세요.

## 여러 입력 스트림을 검증합니다.

1. 미디어 소스에서 여러 개의 비디오를 업로드하거나 준비합니다.
2. 스트리밍 소스 사용 `Auto Assign` 비디오를 소스 슬롯에 매핑합니다.
3. 애플리케이션에서 예상하는 소스 수에 대해 `Bulk Start`를 사용하여 시작합니다.
4. 해당하는 `srcN` 스트림 URL을 사용하여 애플리케이션을 실행합니다.
5. 예상되는 채널로 설정하여 비디오 뷰어를 엽니다.
6. 뷰어 진단 기능을 사용하여 스트림 병목 현상을 확인합니다. 통계 뷰는 이번 버전에 임시로 포함되었으며, 다음 버전에서는 런타임 병목 현상 진단 기능을 추가할 예정입니다.

애플리케이션이 SDK 컨테이너 외부에서 실행될 때, 테스트를 시작하기 전에 `neat --json`에서 RTSP, 비디오 UDP 및 메타데이터 UDP 호스트 포트를 확인합니다.

## SDK 포트 맵에서 애플리케이션 엔드포인트를 구성합니다.

애플리케이션이 DevKit에서 실행되고 Insight이 SDK 내에서 실행될 때 이 워크플로를 사용하세요.

1. SDK에서 Insight가 실행 중인지 확인하세요.

   ```bash
   insight-admin status
   ```

2. SDK 포트 맵을 확인하세요.

   ```bash
   neat --json
   ```

3. `insight.webUiUrl`에서 SDK 호스트 IP를 찾거나, SDK 설정 과정에서 출력되는 호스트 IP를 사용하세요.
4. `exposedPorts`에서 `rtsp.tcp.hostPortStart`, `videoUDP.hostPortStart` 및 `metadataUDP.hostPortStart`를 찾으세요.
5. 다음과 같이 애플리케이션 입력 스트림을 구성합니다.

   ```text
   rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src1
   rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src2
   ```

6. 채널별로 애플리케이션 출력 포트를 구성합니다.

   ```text
   video channel N:    <sdk-host-ip>:<videoUDP hostPortStart + N>
   metadata channel N: <sdk-host-ip>:<metadataUDP hostPortStart + N>
   ```

7. 애플리케이션을 실행하고 비디오 뷰어를 엽니다.
8. 시청자가 비디오를 보지 못하는 경우 `/api/ingest/stats`를 사용하세요. 이 기능은 브라우저 또는 WebRTC 동작을 디버깅하기 전에 RTP 및 메타데이터가 Insight에 제대로 전달되는지 여부를 알려줍니다.

## 비디오 또는 오버레이가 제대로 표시되지 않는 문제를 해결합니다.

다음 단계를 따라 문제의 원인을 파악하십시오.

1. 애플리케이션이 실행 중이고 올바른 Insight 호스트를 대상으로 하는지 확인합니다.
2. 애플리케이션이 SDK 컨테이너 내부에서 실행 중인지, 아니면 외부 장치에서 실행 중인지 확인합니다.
3. 외부 소스인 경우, `neat --json`에서 매핑된 `videoUDP` 및 `metadataUDP` 호스트 포트를 사용하는지 확인하십시오.
4. SDK 컨테이너 내부에 있는 경우, 출력 비디오 포트가 `9000-9079`에 있는지 확인하십시오.
5. 메타데이터를 사용하는 경우, 메타데이터 포트가 메타데이터 UDP 범위 내의 해당 채널과 일치하는지 확인합니다.
6. 비디오 뷰어를 열고 예상되는 채널을 확인하세요.
7. 시스템 정보를 사용하여 Insight가 기본 포트 또는 SDK에 매핑된 포트를 사용하는지 확인하십시오.
8. 시스템 정보와 로그를 사용하여 장치 상태를 확인하세요. 현재 'Stats'는 임시 기능이며, 다음 버전에서는 장치 부하 및 런타임 상태를 포함하도록 개선될 예정입니다.

비디오는 표시되지만 오버레이가 보이지 않는 경우, 메타데이터 경로에 집중하십시오. 오버레이가 지연되거나 동기화되지 않은 상태로 표시되는 경우, 뷰어의 메타데이터 지연 설정을 조정하십시오.

## 팁

- 새로운 앱 루프를 구축할 때 짧은 미디어 클립을 사용하세요. 이렇게 하면 소스 설정과 반복적인 검증을 더 빠르게 수행할 수 있습니다.
- HTTP를 통해 멀티파트 MJPEG를 전송하는 카메라를 시뮬레이션해야 할 경우 HTTP MJPEG 소스를 사용하세요.
- 채널 번호를 일관되게 유지합니다. 비디오가 채널 `N`로 전송되는 경우, 동일한 채널 `N`의 메타데이터 포트로 메타데이터를 전송합니다.
- 파일을 환경에서 복사하기 전에 생성된 모델과 프로파일링 결과물을 검토하려면 작업 공간 보기를 사용하세요.
- 새로운 개발자에게 해당 도구를 소개할 때 Insight UI의 오른쪽 상단에 있는 빠른 사용법 안내 기능을 활용하세요.
- 포트가 잘못되었다고 단정하기 전에 시스템 정보를 확인하세요. SDK 배포 시 브라우저에 표시되는 포트와 내부 서비스 포트가 다를 수 있습니다.
