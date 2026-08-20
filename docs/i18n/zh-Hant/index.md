---
title: "Insight"
description: "使用 Neat 和 Insight 來檢查工作區、準備媒體串流、檢視執行階段影片，以及偵錯 Neat 應用程式的行為。"
sidebar_position: 0
---

# Insight

Insight 是一個以瀏覽器為基礎的檢測和測試控制台，用於 Neat 視覺應用程式的開發。它將視覺執行階段迴圈的各個部分整合到一個地方：專案工作區、測試媒體、串流來源設定、即時 WebRTC 影片、中繼資料疊加層，以及系統/執行階段統計資料的預定位置。

當您想要快速解答實際的開發問題時，請使用 Insight。

- 我的工作區中有哪些檔案、模型、套件和分析檔案？
- 有哪些測試媒體檔案可以使用？目前正在播放哪些串流媒體來源？
- 我的應用程式是否正在預期的頻道上輸出影片？
- 中繼資料是否與影片畫面同步傳輸？
- 問題出在應用程式、串流路徑，還是裝置的執行階段？

Insight 與 Neat 開發環境捆綁在一起，同時也提供 Neat 構件套件，您可以透過 `sima-cli neat install` 來安裝或升級。在 SDK 中，Insight 會自動設定主機埠對應，因此瀏覽器、DevKit 或網路上的其他裝置可以連接到其使用者介面、串流來源和視訊轉譯埠。

## 文件

- [概念](concepts.md) 說明了如何 Insight 符合 Neat 開發流程。
- [安裝與升級](install-upgrade.md)涵蓋了捆綁的 SDK 使用方式、DevKit 的安裝，以及升級指令。
- [使用者介面](user-interface.md)描述了工作區、媒體來源、串流媒體來源、影片檢視器、統計資料和系統資訊檢視。
- [常見工作流程](workflows.md)介紹了單一流程、多重流程和除錯流程。
- [埠和網路行為](ports-network.md) 列出 Insight 使用的埠，以及 SDK 埠對應如何影響連線。
- [REST API 參考資料](api-reference.md)，其中包含自動化端點以及應用程式內 OpenAPI/Swagger 參考資料。

## 快速入門

在「Neat」開發環境中，首先檢查「Insight」是否正在執行：

```bash
insight-admin status
```

然後從瀏覽器開啟 Insight：

```text
https://localhost:9900
```

如果您是從同一個網路中的另一部電腦瀏覽，請使用 SDK 主機的 IP 位址：

```text
https://<host-ip>:9900
```

如果建立 SDK 時預設的連接埠無法使用，則瀏覽器使用的連接埠可能會有所不同。請在 SDK 內部執行此指令，以查看實際的連接埠對應表：

```bash
neat --json
```

請查看 `insight.webUiUrl` 以了解主要的使用者介面，以及 `exposedPorts`，包括 RTSP、視訊 UDP、中繼資料 UDP、WebRTC，以及視訊檢視器使用者介面。

基本開發迴圈如下：

1. 開啟 Insight。
2. 在「媒體來源」中上傳或選擇媒體。
3. 啟動一個或多個串流來源。
4. 執行您的 Neat 應用程式。
5. 在「影片檢視器」中觀看輸出結果和中繼資料疊加層。
6. 在設定在 DevKit 或其他外部機器上執行的應用程式時，請使用 SDK 埠對應表。
7. 使用「工作區」來檢查構件，並使用「統計資料」佔位符來了解系統/執行階段診斷資訊將會在下一個版本中顯示於何處。

如果您目前沒有任何媒體檔案，請從 [Common Workflows](workflows.md#import-standard-test-videos) 中列出的標準測試影片開始。
