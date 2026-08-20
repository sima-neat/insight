---
title: "설치 및 업그레이드"
description: "Neat 개발 환경에서 Insight를 실행하고, DevKit에 설치한 후 sima-cli를 사용하여 업그레이드합니다."
sidebar_position: 2
---

# 설치 및 업그레이드

Insight는 Neat 개발 환경과 함께 제공됩니다. 또한 Modalix DevKit에 직접 설치하고 `sima-cli neat install`을 사용하여 업그레이드할 수 있습니다.

## Neat 개발 환경에서

Insight가 활성화된 상태로 SDK 컨테이너가 시작되면, Insight가 자동으로 설치, 구성 및 관리됩니다. 서버는 HTTPS를 통해 연결을 수신하며, SDK는 브라우저, DevKit 및 기타 외부 클라이언트를 위한 호스트 포트 세트를 게시합니다.

서비스 상태를 확인하세요.

```bash
insight-admin status
```

브라우저에서 Insight를 엽니다.

```text
https://localhost:9900
```

동일 네트워크의 다른 장치에서 접속하는 경우, SDK 호스트 IP 주소를 사용하십시오.

```text
https://<host-ip>:9900
```

기본 웹 UI 포트는 `9900`이며, SDK는 `9900`이 이미 사용 중인 경우 다른 호스트 포트를 할당할 수 있습니다. `neat` 명령은 실제 Insight 웹 UI URL과 노출된 포트 매핑을 보고합니다.

```bash
neat --json
```

주요 UI에는 `insight.webUiUrl`을 사용하십시오. DevKit 애플리케이션, RTSP 클라이언트 또는 외부 미디어 전송기를 구성할 때 `exposedPorts` 배열을 사용하십시오.

## DevKit에서

Insight는 Modalix DevKit에 직접 설치할 수 있습니다. 이는 검사 콘솔을 대상 장치에서 실행하거나 독립 실행형 DevKit 설정을 검증하려는 경우에 유용합니다.

`sima-cli`를 사용하여 Insight를 설치합니다.

```bash
sima-cli neat install insight@{release-tag}
```

개발 빌드에서는 릴리스 태그를 설치하려는 브랜치 또는 태그로 대체하세요.

```bash
sima-cli neat install insight@main
```

설치가 완료되면 생성된 가상 환경을 활성화하고 Insight를 시작합니다.

```bash
source ~/.simaai/neat-insight/venv/bin/activate
neat-insight --port 9900
```

그러면 다음을 엽니다.

```text
https://<devkit-ip>:9900
```

Insight가 DevKit에서 직접 실행될 때, 해당 DevKit의 애플리케이션은 일반적으로 기본 로컬 포트를 사용할 수 있습니다. DevKit 외부의 애플리케이션이 해당 DevKit에 연결할 때는 해당 Insight 인스턴스의 IP 주소와 노출된 포트를 사용해야 합니다.

## Insight를 업그레이드하세요.

Insight가 Neat 형식의 패키지로 제공되므로, 설치에 사용된 것과 동일한 `sima-cli neat install` 절차를 사용하여 업그레이드할 수 있습니다.

릴리스 버전:

```bash
sima-cli neat install insight@{release-tag}
```

특정 브랜치의 최신 빌드:

```bash
sima-cli neat install insight@main
```

Neat 개발 환경에서 Insight는 일반적으로 `/opt/neat-insight/venv`에서 실행됩니다. 관리형 SDK 인스턴스를 업그레이드하려면 해당 가상 환경에 설치하고 서비스를 다시 시작하십시오.

```bash
NEAT_INSIGHT_VENV_DIR=/opt/neat-insight/venv sima-cli neat install insight@main
supervisorctl restart neat-insight
```

SDK 이미지에 `/opt/neat-insight`를 사용하려면 더 높은 수준의 권한이 필요할 수 있습니다. 이 경우, 해당 환경에 적합한 권한으로 설치 명령을 실행하십시오.
