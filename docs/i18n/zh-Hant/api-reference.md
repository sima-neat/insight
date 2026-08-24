---
title: "REST API 參考資料"
description: "透過其 OpenAPI 文件、Swagger UI 以及 HTTP 端點，自動化 Neat Insight。"
sidebar_position: 6
---

# REST API 參考資料

Insight 將其瀏覽器控制平面公開為 HTTP API。 您可以使用它來自動執行健康檢查、媒體導入、串流來源設定、檢測觀看者、檢查工作區以及執行階段診斷。

正在運行的服務會發布兩個 API 文件端點：

- `GET /api/docs` 會開啟互動式的 Swagger 使用者介面。
- `GET /api/openapi.json` 會傳回 OpenAPI 3.1 文件，用於產生客戶端程式碼和其他工具。

對於預設的本機安裝，請開啟：

```text
https://127.0.0.1:9900/api/docs
```

Insight 通常會使用本機產生的開發憑證。命令列客戶端可能需要信任該憑證，或使用 `-k` 進行本機診斷：

```bash
curl -k https://127.0.0.1:9900/api/health
curl -k https://127.0.0.1:9900/api/openapi.json -o neat-insight-openapi.json
```

## 常見的自動化流程

上傳檔案，將其指派到來源插槽，然後開始播放：

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

在變更指定內容或播放狀態之前，請先閱讀 `/api/mediasrc`。如果可能，在刪除媒體內容之前，請先停止正在使用的來源。

## 回應和串流協定

- 大多數端點都會傳回 JSON。錯誤通常會使用 `{"error": "message"}`，並搭配 HTTP 錯誤狀態碼。
- 上傳和匯入會以 `text/plain` 串流傳回處理進度，而不是傳回單一 JSON 物件。
- `/api/neat-metrics` 是一種由伺服器推送的事件串流。
- MJPEG 預覽和來源端點會傳回多部分影像串流。
- 媒體和工作區的原始檔案端點會傳回所要求的二進位內容。

Swagger UI 使用與 Insight 相同的伺服器，因此其「試用」請求會指向目前的安裝環境。刪除、重設、啟動和停止等操作會立即變更服務狀態。

## API 群組

OpenAPI 文件會依用途將作業分組：

- **服務與系統** — 包括健康狀況、環境資訊、建置細節、指標、日誌，以及可選的工具。
- **診斷資訊** — RTP 輸入、WebRTC 輸出，以及伺服器傳送的指標。
- **媒體庫和匯入功能** — 包含目錄、YouTube、上傳、刪除、檢視、預覽和下載等功能。
- **媒體來源** — 指定並控制 RTSP/HTTP 播放。
- **檢視者** — 可透過瀏覽器存取的檢視者網址，以及已設定的頻道容量。
- **工作區** — 瀏覽、搜尋、檢查和預覽工作區檔案以及 MPK 封存檔中的成員。
- **DevKit shell** — 在設定完成後，即可探索並啟動託管的 shell 橋接。

原始的 OpenAPI 檔案也保存在 Insight 儲存庫的 `neat_insight/openapi.json` 中。測試會將其操作與 Flask 註冊的 `/api` 路由進行比較，因此無法在不更新參考資料的情況下，悄悄地新增端點。
