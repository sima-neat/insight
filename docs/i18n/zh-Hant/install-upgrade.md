---
title: "安裝與升級"
description: "從 Neat 開發環境執行 Insight，將其安裝在 DevKit 上，並使用 sima-cli 進行升級。"
sidebar_position: 2
---

# 安裝與升級

Insight 與 Neat 開發環境一同提供。它也可以直接安裝在 Modalix DevKit 上，並使用 `sima-cli neat install` 進行升級。

## 在 Neat 開發環境中

當啟動 SDK 容器時，如果啟用了 Insight，則會自動安裝、設定和監控 Insight。伺服器會透過 HTTPS 進行通訊，並且 SDK 會為瀏覽器、DevKit 以及其他外部用戶端發佈一組主機連接埠。

檢查服務狀態：

```bash
insight-admin status
```

從瀏覽器開啟 Insight：

```text
https://localhost:9900
```

如果您是從同一個網路中的另一部電腦瀏覽，請使用 SDK 主機的 IP 位址：

```text
https://<host-ip>:9900
```

預設的網頁 UI 連接埠為 `9900`，但如果 `9900` 已經在使用中，SDK 可以配置不同的主機連接埠。`neat` 命令會回報實際的 Insight 網頁 UI URL 和公開的連接埠對應關係：

```bash
neat --json
```

針對主要使用者介面，請使用 `insight.webUiUrl`。在設定 DevKit 應用程式、RTSP 用戶端或外部媒體傳送器時，請使用 `exposedPorts` 陣列。

## 在 DevKit 上

您可以直接在 Modalix DevKit 上安裝 Insight。當您希望檢測主控台在目標裝置上執行，或是在驗證獨立的 DevKit 設定時，這會非常有用。

使用 `sima-cli` 安裝 Insight：

```bash
sima-cli neat install insight@{release-tag}
```

對於開發版本，請將發布標籤替換為您想要安裝的分支或標籤：

```bash
sima-cli neat install insight@main
```

安裝完成後，請啟用您建立的虛擬環境，然後啟動 Insight：

```bash
source ~/.simaai/neat-insight/venv/bin/activate
neat-insight --port 9900
```

然後開啟：

```text
https://<devkit-ip>:9900
```

當 Insight 直接在 DevKit 上執行時，該 DevKit 上的應用程式通常可以使用預設的本機連接埠。當 DevKit 外部的應用程式連接到它時，請使用 DevKit 的 IP 位址，以及該 Insight 實例所公開的連接埠。

## 升級 Insight

由於 Insight 以 Neat 套件的形式封裝，因此您可以透過與安裝時使用的相同流程 `sima-cli neat install` 來升級它。

對於一個版本：

```bash
sima-cli neat install insight@{release-tag}
```

若要取得分支的最新版本：

```bash
sima-cli neat install insight@main
```

在 Neat 開發環境中，Insight 通常會從 `/opt/neat-insight/venv` 啟動。若要升級受監督的 SDK 實例，請安裝到該虛擬環境中，然後重新啟動服務：

```bash
NEAT_INSIGHT_VENV_DIR=/opt/neat-insight/venv sima-cli neat install insight@main
supervisorctl restart neat-insight
```

如果您的 SDK 映像檔需要更高的權限才能執行 `/opt/neat-insight`，請使用適合您環境的權限來執行安裝指令。
