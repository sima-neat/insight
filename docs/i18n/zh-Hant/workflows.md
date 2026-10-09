---
title: "常見工作流程"
description: "使用 Insight 來驗證單串流應用程式、多串流應用程式，以及缺少影片或中繼資料的情況。"
sidebar_position: 4
---

# 常見工作流程

## 匯入標準測試影片 {#import-standard-test-videos}

當您需要用於範例、煙霧測試或多串流驗證的可重複媒體時，請使用標準影片素材：

```text
https://artifacts.sima-neat.com/assets/videos/720p16/video01.mp4
...
https://artifacts.sima-neat.com/assets/videos/720p16/video16.mp4

https://artifacts.sima-neat.com/assets/videos/480p30/video01.mp4
...
https://artifacts.sima-neat.com/assets/videos/480p30/video16.mp4
```

若要手動使用，請下載您需要的檔案，然後從媒體來源上傳。

若要透過 API 設定，請檢查 Insight 是否已包含媒體檔案：

```bash
curl -k https://127.0.0.1:9900/api/media-files
```

如果媒體庫是空的，請下載並上傳一個標準影片：

```bash
tmpdir="$(mktemp -d)"
curl -fL "https://artifacts.sima-neat.com/assets/videos/480p30/video01.mp4" \
  -o "${tmpdir}/video01.mp4"
curl -k -F "file=@${tmpdir}/video01.mp4" \
  https://127.0.0.1:9900/api/upload/media
```

針對其他檔案重複執行此操作，或者在您想要上傳較大的媒體檔案集時，上傳壓縮檔。

## 驗證單一串流的視覺應用程式。

1. 開啟 Insight。
2. 前往「媒體來源」，然後上傳一段簡短的測試影片。
3. 前往「串流來源」並將影片指派給 `src1`。
4. 開始 `src1`。
5. 使用正確的 RTSP URL 執行您的應用程式：
   - 在 SDK 容器內部：`rtsp://127.0.0.1:8554/src1`
   - 在 DevKit 或外部機器上：`rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src1`
6. 開啟「視訊瀏覽器」，觀看頻道 `0`。
7. 如果您的應用程式傳送中繼資料，請確認覆蓋圖確實會顯示在影片上。
8. 使用「統計資料」佔位符，即可查看系統負載診斷資訊將在下一個版本中顯示於何處。

## 使用即時網路攝影機驗證應用程式

使用此流程以實體相機而非錄製檔案測試應用程式。網路攝影機連接至執行瀏覽器的電腦，而非板端：瀏覽器將畫面發布至 Insight，Insight 再以一般 RTSP 來源提供，應用程式的使用方式與檔案完全相同。

1. 透過 HTTPS 開啟 Insight，並確認瀏覽器信任其憑證。
2. 前往 Media Sources，在 **本機相機** 下選取 **啟用相機存取**。瀏覽器詢問時允許存取；相機隨即出現在清單中。
3. 前往 Streaming Sources，在 `src1` 下拉選單的 **相機** 群組選取相機。選取後該列顯示 `[CAM]` 標記。
4. 啟動 `src1`，確認槽位顯示 `Live` 且預覽顯示相機畫面。
5. 讓應用程式使用與檔案來源相同的 RTSP URL。Insight 會將網路攝影機正規化為與檔案來源相同、具有規律關鍵影格的 baseline H.264，因此板端硬體解碼器及 GStreamer `rtspsrc` 不需要額外步驟即可使用；無須手動執行 `ffmpeg`，也沒有獨立處理路徑：
   - SDK 容器內：`rtsp://127.0.0.1:8554/src1`
   - DevKit 或外部機器：`rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src1`
6. 開啟 Video Viewer 並查看頻道 `0`。

發布網路攝影機時，請讓瀏覽器分頁保持可見並位於前景：分頁負責將影片傳送至 Insight，而瀏覽器會限制隱藏或背景分頁，造成串流中斷。關閉分頁、拔除相機或選取 **停止** 都會結束串流。

Insight 在 SDK 內執行時，除了應用程式使用的 RTSP 連接埠，瀏覽器也需要連線至 `neat --json` 中的 `webrtcWhip` 主機連接埠。參閱[連接埠與網路行為](ports-network.md)。

## 驗證多個輸入串流。

1. 在「媒體來源」中上傳或準備多個影片。
2. 使用串流來源 `Auto Assign` 將影片對應到來源插槽。
3. 使用 `Bulk Start` 來設定您的應用程式預期使用的來源數量。
4. 執行應用程式，並針對對應的 `srcN` 串流網址進行測試。
5. 使用預期的頻道設定開啟影片檢視器。
6. 使用檢視器診斷功能來檢查串流瓶頸。在本次版本中，「統計資料」檢視僅為佔位符，我們計畫在下一個版本中新增執行階段瓶頸診斷功能。

當應用程式在 SDK 容器外部執行時，請在啟動測試之前，從 `neat --json` 中解析 RTSP、視訊 UDP 和中繼資料 UDP 的主機連接埠。

## 從外部工具串流

1. 開啟「串流來源」，並選擇一個顯示為閒置的插槽。
2. 從主機發布到該插槽，例如 `ffmpeg -f v4l2 -i /dev/video0 -c:v libx264 -preset veryfast -tune zerolatency -g 30 -pix_fmt yuv420p -f rtsp -rtsp_transport tcp rtsp://<insight-host>:8554/src2`。
3. 插槽會變為外部。選取該插槽並開啟預覽以檢查畫面；第一個畫面會在發布端的下一個關鍵幀出現，因此請保持較短的關鍵幀間隔（上方的 `-g 30`）。
4. 如同其他來源，針對插槽的 RTSP URL 執行應用程式。
5. 若要將插槽改用於檔案，請停止外部工具或按下「接管」。

`sima-ai/tool-mediasources`（`mediasrc.sh`）會在相同的 RTSP 連接埠上啟動自己的 MediaMTX，並從 `src0` 開始為串流編號；請在不同的連接埠上執行它，或改用 Insight 的插槽，而不要同時執行兩者。

## 從 SDK 埠對應表中設定應用程式端點。

當應用程式在 DevKit 上執行，且 Insight 在 SDK 內部執行時，請使用此工作流程：

1. 在 SDK 中，請確認 Insight 是否正在執行：

   ```bash
   insight-admin status
   ```

2. 取得 SDK 埠對應表：

   ```bash
   neat --json
   ```

3. 從 `insight.webUiUrl` 找到 SDK 主機的 IP 位址，或者使用 SDK 安裝流程中顯示的主機 IP 位址。
4. 在 `exposedPorts` 中找到 `rtsp.tcp.hostPortStart`、`videoUDP.hostPortStart` 和 `metadataUDP.hostPortStart`。
5. 使用以下方式設定應用程式的輸入資料流：

   ```text
   rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src1
   rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src2
   ```

6. 依據頻道設定應用程式的輸出埠：

   ```text
   video channel N:    <sdk-host-ip>:<videoUDP hostPortStart + N>
   metadata channel N: <sdk-host-ip>:<metadataUDP hostPortStart + N>
   ```

7. 啟動應用程式，然後開啟「影片檢視器」。
8. 如果觀看者沒有顯示影片，請使用 `/api/ingest/stats`。它會報告在您偵錯瀏覽器或 WebRTC 行為之前，RTP 和中繼資料是否已傳送到 Insight。

## 偵錯缺少或未正確顯示的影片或疊加圖層。

請使用此步驟來找出問題所在：

1. 確認應用程式正在執行，並且目標主機是正確的 Insight 主機。
2. 確認應用程式是否在 SDK 容器內執行，或是在外部機器上執行。
3. 如果它是外部來源，請確認它是否使用從 `neat --json` 映射而來的 `videoUDP` 和 `metadataUDP` 主機連接埠。
4. 如果它位於 SDK 容器內，請確認輸出影片埠位於 `9000-9079`。
5. 確認已使用的中繼資料連接埠是否與中繼資料中的對應通道相符。 UDP 範圍。
6. 開啟「視訊檢視器」，並確認是否為預期的頻道。
7. 使用系統資訊來確認 Insight 是否正在使用預設連接埠或透過 SDK 映射的連接埠。
8. 使用「系統資訊」和日誌來檢查裝置狀態。目前，「統計資料」僅為一個佔位符，計畫在下一個版本中新增裝置負載和執行階段健康狀況的相關資訊。

如果影片可以正常顯示，但疊加圖層卻不見了，請檢查中繼資料的路徑。如果疊加圖層出現延遲或不同步的情況，請調整播放器的中繼資料延遲設定。

## 小技巧

- 在建立新的應用程式迴圈時，請使用簡短的媒體片段。這樣可以加快原始素材的設定和重複驗證的速度。
- 當您需要模擬一個透過 HTTP 傳輸多部分 MJPEG 格式的攝影機時，請使用 HTTP MJPEG 來源。
- 保持頻道編號的一致性：如果影片傳送到頻道 `N`，則將中繼資料傳送到相同頻道 `N` 的中繼資料埠。
- 使用「工作區」檢視，在將檔案複製出環境之前，檢查產生的模型和分析結果。
- 當您向新開發人員介紹這項工具時，請使用位於 Insight 使用者介面右上角的「快速導覽」功能。
- 在判斷某個通訊埠有問題之前，請先使用「系統資訊」功能。在 SDK 部署中，瀏覽器使用的通訊埠可能與內部服務的通訊埠不同。
