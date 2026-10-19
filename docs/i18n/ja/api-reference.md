---
title: "REST API リファレンス"
description: "Neat Insight を、その OpenAPI ドキュメント、Swagger UI、HTTP エンドポイントを使って自動化します。"
sidebar_position: 6
---

# REST API リファレンス

Insight は、ブラウザの制御機能を HTTP API として公開します。これを使用すると、ヘルスチェック、メディアのインポート、ストリーミングソースの設定、ビューアーの検出、ワークスペースの検査、ランタイムの診断を自動化できます。

実行中のサービスは、次の 2 つの API ドキュメントのエンドポイントを公開します:

- `GET /api/docs` は、インタラクティブな Swagger UI を開きます。
- `GET /api/openapi.json` は、クライアント生成やその他のツールで使用する OpenAPI 3.1 ドキュメントを返します。

デフォルトのローカルインストールでは、次の URL を開きます:

```text
https://127.0.0.1:9900/api/docs
```

Insight は通常、ローカルで生成された開発用証明書を使用します。コマンドラインクライアントでは、その証明書を信頼するか、ローカルでの診断に `-k` を使用する必要がある場合があります:

```bash
curl -k https://127.0.0.1:9900/api/health
curl -k https://127.0.0.1:9900/api/openapi.json -o neat-insight-openapi.json
```

## 一般的な自動化の流れ

ファイルをアップロードし、ソーススロットに割り当てて、再生を開始します:

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

別のフレームレートでストリーミングするには、アサインメントに `fps` を含めます。必要に応じて、エンコードの進行状況を確認することもできます。

```sh
curl -k -H "Content-Type: application/json" -d '{"index":1,"file":"person_clip.mp4","fps":15}' https://localhost:9900/api/mediasrc/assign
curl -k -N -H "Content-Type: application/json" -d '{"index":1}' https://localhost:9900/api/mediasrc/prepare
curl -k -H "Content-Type: application/json" -d '{"index":1}' https://localhost:9900/api/mediasrc/start
```

`prepare` は `progress <seconds>/<total>` 形式の行をストリーミングし（別のレンディションのエンコード中は、その前に `Waiting for another rendition to finish encoding…` 行が繰り返し出力されます。Insight は一度に 1 つずつエンコードします）、最後に `Rendition ready: …`、`Reusing rendition: …`、または `Error: …` を出力します。`prepare` を省略した場合は、`start` が同じ準備処理を出力なしで実行します。`GET /api/mediasrc/renditions` はキャッシュされたレンディションのディスク使用量を返します。`POST /api/mediasrc/renditions/clear` は、再生中のソースが使用していないキャッシュ済みのレンディションを削除します。

割り当てや再生状態を変更する前に、`/api/mediasrc` を読み取ってください。可能であれば、メディアを削除する前に、そのメディアを使用しているアクティブなソースを停止してください。

Insight 以外から配信されているスロットは、`state: "external"` と `external` オブジェクト（プロトコル、アドレス、配信開始時刻、コーデックのサポート状況、映像サイズ、ビットレート）を返します。また、すべてのスロットが現在の `readers` を一覧表示します。このようなスロットに対して `start` と `assign` は `409` を返し、Insight 自身のストリームがそのスロットに残っていない場合は `stop` も同様です。`POST /api/mediasrc/takeover` は配信元を切断します。一括操作は外部ストリームを実行したままにし、そのスロットを `skipped_external` に列挙します。`reset` は引き続き、すべてのスロットの保存済みレコードをクリアします。`GET /stream/preview/src<N>.mjpg` は、ライブ状態の任意のスロットの MJPEG プレビューをソースのフレームレートでレンダリングします。

`POST /api/mediasrc/pull` に `{"index": 3, "url": "rtsp://192.168.1.10:554/stream1", "username": "admin", "password": "…"}` を指定すると、既存の RTSP/RTSPS ストリームをスロットにプルします。その後、スロットは `state: "pulled"` と `pull` オブジェクト（`connecting`、`live`、`unreachable`、`auth_failed` のいずれかの `status` に加え、スキーム、ホスト、パス、エラー、開始時刻、コーデックのサポート状況、映像サイズ、フレームレート、ビットレート。認証情報は含まれません）を返します。認証情報が拒否された場合は `"reason": "auth_failed"` とともに `400` を返し、ストリーミング中、外部、ウェブカメラソース、またはすでにプル済みのスロットは `409` を返し、`502` は mediamtx が設定を拒否したか mediamtx に接続できなかったことを意味します。`stop` はプルを解除します。プルしたスロットに対して `assign`、`assign-webcam`、`start`、`prepare`、`takeover` は `409` を返します。`stop-all` と `reset` はプルも解除して `stopped_pulled` に列挙し、`auto-assign-all` と `start-bulk` はプルしたスロットをスキップして `skipped_pulled` に列挙します。プルはセッション中のみ有効です。

## レスポンスとストリーミングの規則

- ほとんどのエンドポイントは JSON を返します。エラーには通常、HTTP エラーステータスとともに `{"error": "message"}` が使用されます。
- アップロードとインポートは、単一の JSON オブジェクトではなく、`text/plain` でストリーミングの進行状況を返します。
- `/api/neat-metrics` は Server-Sent Events のストリームです。
- MJPEG のプレビューエンドポイントとソースエンドポイントは、マルチパートの画像ストリームを返します。
- メディアとワークスペースの生ファイルエンドポイントは、要求されたバイナリコンテンツを返します。

Swagger UI は Insight と同じホストを使用するため、**Try it out**（試してみる）のリクエストは現在のインストールを対象とします。削除、リセット、開始、停止などの操作は、サービスの状態を直ちに変更します。

## API グループ

OpenAPI ドキュメントは、操作を目的別にグループ化しています:

- **サービスとシステム** — ヘルス、環境、ビルドの詳細、メトリクス、ログ、およびオプションのツール。
- **診断** — RTP の受信（ingest）、WebRTC の送信（egress）、およびサーバー送信のメトリクス。
- **メディアライブラリとインポート** — カタログ、YouTube、アップロード、削除、検査、プレビュー、ダウンロード。
- **メディアソース** — 割り当てと RTSP/HTTP 再生の制御。
- **ビューアー** — ブラウザからアクセス可能なビューアーの URL と、設定されたチャンネル容量。
- **ワークスペース** — ワークスペースのファイルと MPK アーカイブのメンバーの参照、検索、検査、プレビュー。
- **DevKit シェル** — 設定されている場合に、ホストされたシェルブリッジを検出して起動します。
- **ボード** — ボード向けの機能が使用するボードを選択し、SSH 接続をテストし、再フラッシュされたボードのホストキーを信頼します。
- **ペリフェラル** — 選択中のボードで SiMa Sentinel が報告する MIPI カメラと USB カメラ、および ALSA マイクを一覧表示し、一時的なカメラプレビューの開始、検査、ストリーミング、停止を行い、API を通じてマイクをテストします。
- **Sentinel** — 選択中のボードで SiMa Sentinel の有無を確認してインストールし、ボードのテレメトリーを読み取り、トレースを開始・停止し、保存済みの実行を一覧表示、検査、削除、比較します。

生の OpenAPI ファイルは、Insight リポジトリの `neat_insight/openapi.json` でも管理されています。テストでは、その操作を Flask に登録された `/api` のルートと比較するため、リファレンスを更新せずに新しいエンドポイントが黙って追加されることはありません。
