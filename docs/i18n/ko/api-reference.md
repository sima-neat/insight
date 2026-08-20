---
title: "REST API 레퍼런스"
description: "Neat 및 Insight를 자동화하기 위해 해당 OpenAPI 문서, Swagger UI 및 HTTP 엔드포인트를 활용합니다."
sidebar_position: 6
---

# REST API 레퍼런스

Insight는 브라우저 제어 기능을 HTTP API로 제공합니다. 이를 통해 상태 확인, 미디어 가져오기, 스트리밍 소스 설정, 뷰어 검색, 작업 공간 검사, 런타임 진단 등의 작업을 자동화할 수 있습니다.

실행 중인 서비스는 다음과 같은 두 개의 API 문서 엔드포인트를 게시합니다.

- `GET /api/docs`를 사용하면 대화형 Swagger UI가 열립니다.
- `GET /api/openapi.json`은 클라이언트 생성 및 기타 도구에 사용되는 OpenAPI 3.1 문서를 반환합니다.

기본 로컬 설치의 경우 다음을 엽니다.

```text
https://127.0.0.1:9900/api/docs
```

Insight는 일반적으로 로컬에서 생성된 개발 인증서를 사용합니다. 명령줄 클라이언트는 해당 인증서를 신뢰하거나 로컬 진단에 `-k`를 사용해야 할 수 있습니다.

```bash
curl -k https://127.0.0.1:9900/api/health
curl -k https://127.0.0.1:9900/api/openapi.json -o neat-insight-openapi.json
```

## 일반적인 자동화 흐름

파일을 업로드하고, 소스 슬롯에 할당한 다음, 재생을 시작합니다.

```bash
curl -k -F "file=@person_clip.mp4" \
  https://<INSIGHT_HOST>:9900/api/upload/media

curl -k -H "Content-Type: application/json" \
  -d '{"index":1,"file":"person_clip.mp4"}' \
  https://<INSIGHT_HOST>:9900/api/mediasrc/assign

curl -k -H "Content-Type: application/json" \
  -d '{"index":1}' \
  https://<INSIGHT_HOST>:9900/api/mediasrc/start
```

할당 또는 재생 상태를 변경하기 전에 `/api/mediasrc`를 읽어보세요. 가능하면 미디어를 삭제하기 전에 활성 상태의 소스를 중지하세요.

## 응답 및 스트리밍 규칙

- 대부분의 엔드포인트는 JSON 형식으로 응답합니다. 오류 발생 시에는 일반적으로 HTTP 오류 상태와 함께 `{"error": "message"}`를 사용합니다.
- 업로드 및 가져오기 `text/plain` 단일 값이 아닌 스트리밍 진행 상황 JSON 객체.
- `/api/neat-metrics`는 서버에서 전송하는 이벤트 스트림입니다.
- MJPEG 미리보기 및 소스 엔드포인트는 다중 부분 이미지 스트림을 반환합니다.
- 미디어 및 작업 공간의 원본 파일 엔드포인트는 요청된 이진 콘텐츠를 반환합니다.

Swagger UI는 Insight와 동일한 호스트를 사용하므로, **사용해 보기** 요청은 현재 설치된 환경을 대상으로 합니다. 삭제, 재설정, 시작, 중지와 같은 작업은 서비스 상태를 즉시 변경합니다.

## API 그룹

OpenAPI 문서는 작업을 목적에 따라 그룹화합니다.

- **서비스 및 시스템** — 건강 상태, 환경, 빌드 정보, 지표, 로그, 그리고 선택적인 도구.
- **진단** — RTP 수신, WebRTC 전송, 서버에서 전송되는 지표.
- **미디어 라이브러리 및 가져오기** — 카탈로그, YouTube, 업로드, 삭제, 검사, 미리 보기 및 다운로드.
- **미디어 소스** — 할당 및 RTSP/HTTP 재생 제어.
- **뷰어** — 브라우저에서 접근 가능한 뷰어 URL과 구성된 채널 용량입니다.
- **작업 공간** — 작업 공간 파일과 MPK 아카이브 구성원을 찾아보고, 검색하고, 검사하고, 미리 볼 수 있습니다.
- **DevKit 셸** — 구성된 경우 호스팅된 셸 브리지를 검색하고 시작합니다.

원본 OpenAPI 파일은 `neat_insight/openapi.json`에 있는 Insight 저장소에서도 유지 관리됩니다. 테스트에서는 해당 파일의 작동 방식을 Flask에 등록된 `/api` 경로와 비교하므로, 참조를 업데이트하지 않고는 새로운 엔드포인트를 자동으로 추가할 수 없습니다.
