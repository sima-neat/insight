---
title: 輔助視覺化
description: 將與影格相關聯的資料傳送到檢視器端的視覺化面板。
sidebar_position: 4
---

# 輔助視覺化

視訊檢視器可將與影格相關聯的資料顯示在影片旁，而不是作為疊加層。每個頻道都有獨立面板，多個檢視會顯示為分頁。Insight 會將不透明的 JSON 承載資料傳遞給已註冊的呈現器；第一個內建呈現器會將 BlazePose 世界座標標記顯示為 3D 骨架。

將輔助資料傳送到頻道的中繼資料 UDP 連接埠（`metadataUDP + N`）。將 `timestamp` 設為來源影片的整數毫秒 PTS。檢視器僅接受與解碼 RTP 影格完全相符的輔助資料，並在短暫傳送中斷期間保留最後相符的檢視，最長 160 毫秒。

## 訊息合約

```json
{
  "type": "auxiliary-visualization",
  "timestamp": 1234,
  "frame_id": "42",
  "data": {
    "schema_version": 1,
    "id": "world-pose",
    "renderer": "blazepose-3d",
    "title": "3D Pose",
    "payload": {
      "poses": [{
        "id": "pose_1",
        "keypoints": [
          {"name": "nose", "x": 0.01, "y": -0.42, "z": -0.08, "confidence": 0.98}
        ]
      }]
    }
  }
}
```

| 欄位 | 需求 |
| --- | --- |
| `schema_version` | 整數 `1`；未知版本會被忽略。 |
| `id` | 穩定且非空的檢視識別碼。 |
| `renderer` | 已註冊的檢視器呈現器；未知名稱會被忽略。 |
| `title` | 選用的面板標籤。 |
| `payload` | 呈現器專用的 JSON 物件。 |

此封裝並非姿勢專用。點雲、網格、圖表或其他 3D 檢視可註冊呈現器並定義自己的承載資料，而不必變更傳輸或面板。

## BlazePose 3D

`blazepose-3d` 承載資料接受 `poses[]`；每個項目包含具有限 `x`、`y`、`z` 世界座標的具名 `keypoints[]`。信賴度為選用；低信賴度關節會淡化而不是消失。骨架以不同顏色顯示頭部、軀幹、主體左側與右側。多個姿勢也會使用不同的外框顏色。

在 Viewer Configuration 中開啟 **3D Pose**，可全域或依頻道設定可見性、面板大小、透明度、相機偏航角與俯仰角，以及參考立方體可見性。面板控制項可切換立方體或重設相機；拖曳畫布可選擇固定視角。呈現器會直接繪製每個相關聯的影格，不會獨立於 2D 疊加層進行平滑或動畫處理。

預設相機使用穩定的公制座標框架。傳送端可使用 `payload.view.center.{x,y,z}` 和 `payload.view.half_extent` 覆寫。

## 多個檢視與呈現器

每個檢視使用不同的 `data.id` 傳送一則訊息；同一時間戳最多可有 16 個檢視顯示為分頁。一般疊加訊息可使用相同影格並繼續呈現在影片上。屬於同一影格的所有資料都必須使用相同的頻道與來源 PTS。

呈現器註冊於 `frontend/src/viewer/auxiliaryVisualization.js`。呈現器提供名稱、標題與 `draw(context, viewport, payload, frame)` 函式。互動式呈現器也可提供含控制項與指標處理常式的工作階段。面板負責重新繪製排程、設定與清理。

變更通訊協定或呈現器後，請執行檢視器檢查：

```bash
cd frontend
npm ci
npm run test:viewer
npm run build:viewer
```
