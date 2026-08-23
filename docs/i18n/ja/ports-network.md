---
title: "ポートとネットワークの動作"
description: "Insight のポートの使用状況、チャネルマッピング、および SDK ポートのリマッピングについて理解してください。"
sidebar_position: 5
---

# ポートとネットワークの動作

Insightは、通常動作中に複数のポートを使用します。デフォルトのポートは、SDKコンテナー内または直接インストールされたDevKitで使用されるポートです。Neat開発環境では、SDKはこれらのサービスをホストポートに公開します。デフォルトのホストポートがすでに使用されている場合、`sima-cli`を使用して、別の利用可能なホストポートを割り当てることができます。

![ブラウザクライアント、Modalix DevKit、SDKホストマシン、およびSDKコンテナー間のInsightポートとネットワークパス。](../../images/insight-ports-network.jpg)

| ポートマップ名 | デフォルトのポートまたはポート範囲 | プロトコル | 目的 |
| --- | --- | --- | --- |
| `mainUI` | `9900` | HTTPS/TCP | 主な Insight ウェブ UI、HTTP API、および HTTP MJPEG ストリーミングソース。 |
| `videoUI` | `8081` | HTTPS/TCP | WebRTC ビデオビューアーのユーザーインターフェース。 |
| `rtsp.tcp` | `8554` | RTSP/TCP | アップロードされたメディアから作成された、RTSP ストリーミングソース。 |
| `videoUDP` | `9000-9079` | UDP | 動画 RTP 視聴者向けチャンネルに配信 `0-79`. |
| `metadataUDP` | `9100-9179` | UDP | メタデータ JSON 視聴者向けチャンネルに配信 `0-79`. |
| `webRTC` | `40000-40199` | UDP | WebRTC：メディアおよびメタデータ。vfからブラウザへのDataChannelによるデータ送信。 |
| `webSSH` | `8022` | HTTPS/TCP | 利用可能な場合は、ペアリングされた DevKit にブラウザシェルを接続します。 |

## 実際の SDK ポートマップを見つけてください。

SDKでは、デフォルトのホストポートが利用可能であると仮定しないでください。次のコマンドを実行してください。

```bash
neat --json
```

出力には、`insight.webUiUrl` と、`exposedPorts` という配列が含まれます。

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

ホストポートが再マッピングされた場合、`hostPortStart`の値は、外部クライアントが使用すべきポートです。`hostPortEnd`は、ビデオ、メタデータ、WebRTCなどのポート範囲に対して使用されます。

## チャンネルマッピング

ビデオビューワーは、ペアになったビデオポートとメタデータポートを使用します。チャンネルについては、 `N`:

```text
video:    UDP 9000 + N
metadata: UDP 9100 + N
```

例：

| 視聴者チャンネル | ビデオポート | メタデータポート |
| --- | --- | --- |
| `0` | `9000` | `9100` |
| `1` | `9001` | `9101` |
| `2` | `9002` | `9102` |

ビデオとメタデータのチャンネル番号を一致させてください。アプリケーションがチャンネル`3`にビデオを送信する場合は、対応するメタデータをチャンネル`3`のメタデータポートに送信してください。

## SDK ポートマッピング

Neat 開発環境では、SDKコンテナーによってポートが再マッピングされる場合があります。Insight は、利用可能な場合にSDKポートマップ構成を読み込み、UIリンクがブラウザからアクセス可能なホストポートを指すようにします。

これは、特にビデオビューアーにとって重要です。内部のデフォルトビューアーポートは`8081`ですが、SDKが`videoUI`を別のホストポートにマッピングする場合、ブラウザに表示されるポートが異なる場合があります。

URLが間違っていると仮定する前に、Insight UIのシステム情報を使用して、実際に公開されているポートを確認してください。

## ポートマップを使用してアプリケーションを設定します。

アプリケーションのインストール場所に基づいて、デフォルトのコンテナポートを使用するか、SDKで公開されているホストポートを使用するかを決定します。

| アプリケーションの場所 | InsightからのRTSP入力 | ビデオ/メタデータを出力して、Insight に送信します。 |
| --- | --- | --- |
| SDKコンテナ内 | `rtsp://127.0.0.1:8554/srcN` | `127.0.0.1:9000 + channel`と`127.0.0.1:9100 + channel` |
| DevKit、または別の外部マシンで | `rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/srcN` | `<sdk-host-ip>:<videoUDP hostPortStart + channel>`と`<sdk-host-ip>:<metadataUDP hostPortStart + channel>` |

HTTP MJPEGソースは、メインのInsight UI/APIポートを使用します。SDKでは、これらのURLに対して、`neat --json`から`mainUI`ホストポートを使用してください。

たとえば、`neat --json`が以下のように報告する場合：

```json
{"name": "rtsp.tcp", "hostPortStart": 18554, "protocol": "tcp"}
{"name": "videoUDP", "hostPortStart": 19000, "hostPortEnd": 19079, "protocol": "udp"}
{"name": "metadataUDP", "hostPortStart": 19100, "hostPortEnd": 19179, "protocol": "udp"}
```

次に、DevKit 上で動作するアプリケーションは、以下を使用する必要があります。

```text
RTSP source src1:   rtsp://<sdk-host-ip>:18554/src1
video channel 0:    <sdk-host-ip>:19000
metadata channel 0: <sdk-host-ip>:19100
video channel 3:    <sdk-host-ip>:19003
metadata channel 3: <sdk-host-ip>:19103
```

アプリケーションとInsightが同じSDKコンテナー内で実行される場合は、代わりにデフォルトのローカルポートを使用してください。

## 関連ツール

- **Neat 開発環境**は、Insight がパッケージ化されたコンテナ化されたビルドおよび実行環境を提供します。
- **Neat ライブラリ**は、ビジョン関連のワークロードを構築および実行するために使用されるアプリケーション API を提供します。
- **sima-cli** は、Insight パッケージやその他の Neat 関連ファイルをインストールおよびアップグレードします。
- **モデルコンパイラとLLiMa**は、ワークスペースを通じて確認でき、Insightとともに実行されるアプリケーションを通じて検証できるモデル成果物を生成します。
