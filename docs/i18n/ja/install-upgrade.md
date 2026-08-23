---
title: "インストールとアップグレード"
description: "Insight を Neat 開発環境から実行し、DevKit にインストールし、sima-cli を使用してアップグレードします。"
sidebar_position: 2
---

# インストールとアップグレード

Insightは、Neat開発環境に同梱されています。また、Modalix DevKitに直接インストールし、`sima-cli neat install`を使用してアップグレードすることもできます。

## Neat 開発環境において

SDKコンテナがInsightを有効にして起動すると、Insightが自動的にインストール、設定、および監視されます。サーバーはHTTPS経由でリクエストを待ち受け、SDKはブラウザ、DevKit、およびその他の外部クライアント用に、ホストポートのセットを公開します。

サービスのステータスを確認してください。

```bash
insight-admin status
```

ブラウザからInsightを開きます。

```text
https://localhost:9900
```

同じネットワーク上の別のマシンからアクセスする場合は、SDKホストのIPアドレスを使用してください。

```text
https://<host-ip>:9900
```

デフォルトのウェブUIポートは`9900`ですが、SDKは、`9900`がすでに使用されている場合、別のホストポートを割り当てることができます。`neat`コマンドは、実際のInsightウェブUI URLと公開されているポートマッピングを表示します。

```bash
neat --json
```

メインのUIには、`insight.webUiUrl`を使用してください。DevKitアプリケーション、RTSPクライアント、または外部メディア送信元を構成する際には、`exposedPorts`配列を使用してください。

## DevKit 上で

Insight は、Modalix DevKit 上に直接インストールできます。これは、検査コンソールをターゲットデバイス上で実行したい場合や、スタンドアロンの DevKit 環境を検証したい場合に役立ちます。

Insight は、`sima-cli` を使用してインストールしてください。

```bash
sima-cli neat install insight@{release-tag}
```

開発ビルドの場合、リリースタグをインストールしたいブランチまたはタグに置き換えてください。

```bash
sima-cli neat install insight@main
```

インストール後、作成した仮想環境を有効にし、Insight を起動します。

```bash
source ~/.simaai/neat-insight/venv/bin/activate
neat-insight --port 9900
```

次に、開きます。

```text
https://<devkit-ip>:9900
```

Insight が DevKit 上で直接実行される場合、その DevKit 上のアプリケーションは通常、デフォルトのローカルポートを使用できます。DevKit 外部のアプリケーションがこれに接続する場合は、DevKit の IP アドレスと、その Insight インスタンスによって公開されているポートを使用してください。

## Insight をアップグレードします。

Insight は Neat の成果物としてパッケージ化されているため、インストールに使用するのと同じ `sima-cli neat install` の手順でアップグレードできます。

リリースの場合：

```bash
sima-cli neat install insight@{release-tag}
```

ブランチから最新バージョンをビルドするには：

```bash
sima-cli neat install insight@main
```

Neat 開発環境では、Insight は通常、`/opt/neat-insight/venv` から実行されます。監視対象の SDK インスタンスをアップグレードするには、その仮想環境にインストールし、サービスを再起動してください。

```bash
NEAT_INSIGHT_VENV_DIR=/opt/neat-insight/venv sima-cli neat install insight@main
supervisorctl restart neat-insight
```

SDKイメージで`/opt/neat-insight`を使用するために、より高い権限が必要な場合は、適切な権限でインストールコマンドを実行してください。
