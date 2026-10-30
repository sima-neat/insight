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
| `webrtcWhip` | `8889` | HTTPS/TCP | WHIP を介してブラウザーのウェブカメラを MediaMTX に配信し、RTSP ソースとして再配信します。 |
| `webrtcWhipIce` | `8189` | UDP | ブラウザーのウェブカメラ配信用の ICE メディアです。シグナリングは `webrtcWhip` を使い、ビデオ自体はここへ届くため、両方に接続できる必要があります。 |
| `webSSH` | `8022` | HTTPS/TCP | 利用可能な場合は、ペアリングされた DevKit にブラウザシェルを接続します。 |

Insight は、mediamtx の制御 API も `127.0.0.1:9901`（TCP）で実行します。この API はループバック専用で、起動のたびに生成されるパスワードで保護されており、Insight 自身がウェブカメラソースの確認、外部の配信元の検出、プルしたストリームの設定のためだけに使用します。そのため、ポートマッピングは不要です。ほかの mediamtx ポートと同様に、別のプロセスがこのポートを使用している場合は、起動時に解放されます。

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
    {"hostPortEnd": null, "hostPortStart": 8889, "name": "webrtcWhip", "protocol": "tcp"},
    {"hostPortEnd": null, "hostPortStart": 8189, "name": "webrtcWhipIce", "protocol": "udp"},
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

ビデオポートは、RTP の H.264（ペイロードタイプ `96`）、H.265（`98`）、または JPEG（`26`、GStreamer の `rtpjpegpay` が送信する RFC 2435 形式）を受け付けます。各 RTP パケットは 4096 バイト以下にしてください。JPEG の場合は `rtpjpegpay mtu=` を 4096 以下に設定します。JPEG フレームはメタデータと同じ WebRTC 接続でブラウザーに届くため、追加のポートは不要です。

## SDK ポートマッピング

Neat 開発環境では、SDKコンテナーによってポートが再マッピングされる場合があります。Insight は、利用可能な場合にSDKポートマップ構成を読み込み、UIリンクがブラウザからアクセス可能なホストポートを指すようにします。

これは、特にビデオビューアーにとって重要です。内部のデフォルトビューアーポートは`8081`ですが、SDKが`videoUI`を別のホストポートにマッピングする場合、ブラウザに表示されるポートが異なる場合があります。

URLが間違っていると仮定する前に、Insight UIのシステム情報を使用して、実際に公開されているポートを確認してください。

## ブラウザー向けのオプション設定

ホスト環境では、ペアリングされた DevKit が使用するアドレスと、外部ブラウザーに通知するアドレスを分離できます。Insight は起動時にのみ適用される、次の 2 つのオプションファイルを読み込みます。

| ファイル | 用途 |
| --- | --- |
| `/home/docker/.insight-config/browser-ice-address` | vf ビューアーと MediaMTX WHIP エンドポイントの両方が通知する、ブラウザーから到達可能な単一の IPv4 アドレス。 |
| `/home/docker/.insight-config/launch-url` | 信頼済みの絶対 HTTP または HTTPS 起動 URL。Insight はそのオリジンを使用して、ビューアー、WHIP、および HTTP MJPEG の URL を生成します。 |

`browser-ice-address` がない場合、Insight は従来の `CONTAINER_HOST_IP` の動作を維持します。`launch-url` がない場合、生成されるブラウザー URL は引き続きリクエストホストと SDK ポートマップを使用します。したがって、この 2 つのファイルはホスト環境向けの動作を個別に有効化し、通常のローカル環境や DevKit のインストールには影響しません。

`browser-ice-address` は vf または MediaMTX の起動前に検証されます。空または不正なブラウザーアドレスが指定されている場合、到達不能なアドレスを通知したままにせず、Insight は準備完了になりません。`launch-url` は補助的な設定です。Insight はパス、クエリ、フラグメントを含む ASCII ホスト名の完全な URL を受け入れますが、HTTP(S) オリジンのみを使用します。不正な起動 URL は警告として記録され、従来のリクエストホストおよびポートマップによる URL 生成が維持されます。ファイルをアトミックに置き換え、`insight-admin restart` を実行し、`/api/health` を確認して、新しいプロセスにアドレスと公開オリジンが適用されたことを確認してください。

ブラウザー ICE アドレスはローカルネットワークインターフェースに割り当てられている必要はありません。パブリッククラウドの IPv4 アドレスは、通常 1:1 NAT を介してホストに到達します。ただし、WebRTC と `webrtcWhipIce` の UDP ポートは引き続き公開し、周辺のネットワークポリシーで許可する必要があります。

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

### SDK への直接アクセスと共有プロキシ

`/home/docker/.insight-config/url-routing` で URL のルーティングを明示的に選択します。`direct` または `proxy` を 1 行で記述し、変更後に Insight を再起動してください。空または無効な値では起動に失敗します。ファイルがない場合は、既存のホスト環境との互換性を維持するため `proxy` が選択されます。

`proxy` モードでは、ポート番号に関係なく、`launch-url` がビューアー、WHIP、HTTP MJPEG の共有オリジンになります。プロキシは各パスを対応するサービスへ転送する必要があります。`direct` モードでは、SDK の起動機能は引き続き `launch-url` を利用できますが、Insight の公開オリジンには使用されません。生成される URL はリクエストのホスト名と各サービスの設定済みポートを使用します。ビューアーは SDK のポートマップの `videoUI` を使用し、未設定時は `8081` にフォールバックします。ブラウザーの ICE アドレス設定は、この設定とは独立しています。

`https://127.0.0.1:9900/` のような起動 URL を指定したローカル SDK では、`url-routing` に `direct` を設定してください。起動 URL の上書きが不要なら `launch-url` を削除することもできます。`insight-admin restart` で再起動後、`/api/health` を確認してください。直接アクセスでは `network.public_origin: null` と表示されます。プロキシのポートが SDK の `mainUI` と一致しても、プロキシのオリジンは変更されません。

## 関連ツール

- **Neat 開発環境**は、Insight がパッケージ化されたコンテナ化されたビルドおよび実行環境を提供します。
- **Neat ライブラリ**は、ビジョン関連のワークロードを構築および実行するために使用されるアプリケーション API を提供します。
- **sima-cli** は、Insight パッケージやその他の Neat 関連ファイルをインストールおよびアップグレードします。
- **モデルコンパイラとLLiMa**は、ワークスペースを通じて確認でき、Insightとともに実行されるアプリケーションを通じて検証できるモデル成果物を生成します。
