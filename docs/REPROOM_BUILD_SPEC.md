# REP ROOM — 建置規格書

給 Claude Code 的完整實作規格。這份文件是唯一事實來源，遇到與其他來源衝突時以此為準。

---

## 0. 專案是什麼

用手機鏡頭偵測伏地挺身次數的網頁 App，可以建房間、分享四碼房號給朋友，兩人即時對戰比誰在限時內做得多，並記錄戰績。

**完全免費、開源、無商業模式。** 不做金流、不做廣告、不做訂閱。

---

## 1. 現況

`index.html` 已完成並在實機驗證通過的單機版，包含：

- MediaPipe Pose Landmarker 即時姿勢偵測
- 自動訊號選擇 + 兩段式校正
- Web Audio 合成音效回饋
- 計時、結算、節奏圖表
- 測試模式（系統自我檢查、即時訊號、門檻調整、診斷紀錄）
- Wake Lock 防鎖屏

**這份程式碼的偵測邏輯已經過實機調校，不要重寫、不要「優化」演算法。** 第 3 節是它的規格，改動前必須先問人類。

---

## 2. 技術決策（已定案，不要重新選型）

| 項目 | 選擇 | 理由 |
|---|---|---|
| 前端 | 原生 HTML/CSS/JS，無框架 | 已經跑起來了，不要引入 React/Vue/建置工具 |
| 姿勢偵測 | MediaPipe Tasks Vision (CDN) | 已驗證 |
| 登入 | Firebase Authentication — Google | Spark 方案免費、無閒置暫停 |
| 即時房間 | Firebase Realtime Database | 需要 `onDisconnect()`，Firestore 沒有 |
| 戰績儲存 | Cloud Firestore | 需要查詢與排序 |
| 託管 | GitHub Pages（公開 repo） | 免費 |
| 授權 | MIT | |

**不要**改用 Supabase（免費專案七天閒置會暫停）。**不要**加 Cloud Functions（免費條件會變動，且純客戶端 + 安全規則足夠）。

---

## 3. 偵測演算法規格（勿改）

### 3.1 候選訊號

同時計算四種，全部使用寬高比校正後的正規化座標：

| 代號 | 內容 | landmark |
|---|---|---|
| `elbow` | 雙側手肘角度平均 | 11-13-15 / 12-14-16 |
| `eyes` | 兩眼間距 × 100 | 2, 5 |
| `shoulders` | 肩寬 × 100 | 11, 12 |
| `height` | 雙肩 y 平均 × 100 | 11, 12 |

任一 landmark 的 visibility < 0.5 時該訊號回傳 null。

### 3.2 校正

三步驟。**每一步都是「先給緩衝期擺姿勢，再取樣」，緩衝期絕對不能取樣** —— 這是原本最嚴重的 bug，取到移動中的樣本會讓標準差爆表。

1. 偵測到身體（連續 700ms）
2. 撐直手臂：緩衝 `SETTLE_MS=2200` → 嗶聲 → 取樣 `HOLD_MS=1800`
3. 下到最低點：同上

取樣完成後，對每個訊號分別計算上下兩組的**中位數與 MAD**（不是平均值與標準差，關節點會偶發跳動），分離度分數 = `|中位數差| / (MAD和 + 1e-3)`。取分數最高者，需 ≥ `PASS=2.0`。

未達標時**不可只顯示「訊號太弱」**，必須列出四個訊號各自的分數，並提供「仍然使用最佳訊號」的選項。

### 3.3 計數狀態機

深度 `d = (EMA(訊號) - up基準) / (down基準 - up基準)`，夾在 0～1.25。EMA 係數 0.38。

- `up` → `down`：`d > TH.down`（預設 0.72）且距上次邊緣 > 140ms
- `down` → `up`：`d < TH.up`（預設 0.32）且距上次邊緣 > 380ms，此時計數 +1

門檻可由使用者在測試模式即時調整。

---

## 4. 資料模型

### 4.1 Realtime Database（短命、即時）

```
rooms/{code}
  host:    { uid, name, online, reps, ready }
  guest:   { uid, name, online, reps, ready }
  config:  { durationSec, createdAt }
  state:   "waiting" | "counting" | "live" | "done"
  startAt: <伺服器時間戳，倒數結束的絕對時刻>
  result:  { hostReps, guestReps, winner }
```

### 4.2 Firestore（長期）

```
users/{uid}
  displayName, photoURL, createdAt
  stats: { totalReps, bestSession, wins, losses, draws, matches }

matches/{matchId}
  players: [uidA, uidB]        // 供 array-contains 查詢
  a: { uid, name, reps }
  b: { uid, name, reps }
  durationSec, winner, playedAt
```

`users/{uid}` 不儲存 email。顯示名稱由使用者自訂，不要直接沿用 Google 帳號的真實姓名。

---

## 5. 安全規則（優先於功能，先寫好再推 GitHub）

repo 是公開的，專案 ID 等於昭告天下。規則沒設好的資料庫遲早被清空。

**Firestore**
- `users/{uid}`：本人可讀寫；`stats` 欄位只能由本人寫入
- `matches`：僅該場兩位參與者可建立，且 `players` 必須包含自己；建立後不可修改或刪除

**Realtime Database**
- `rooms/{code}`：僅 host / guest 可寫入各自的節點
- 任何人不得寫入他人的 `reps`
- 房間節點需設定合理的資料驗證（`reps` 為非負整數等）

---

## 6. 房間流程

### 6.1 房號

- 四碼，字元集為大寫英數但**排除 `0 O 1 I L`**（約 31 字元）
- 輸入時大小寫不敏感，並自動將 `0→O`、`1→I`、`L→I` 之類的常見誤輸入正規化
- 建立時檢查碰撞，重複則重新產生

### 6.2 分享

同時提供房號與帶參數的連結（`?room=XXXX`），兩者一起分享。

優先使用 `navigator.share()`（系統原生分享選單，iOS/Android 都會列出 LINE）。不支援時退回複製到剪貼簿 + LINE URL scheme (`https://line.me/R/msg/text/?...`)。

**不要**引入 LINE SDK 或 LIFF，不需要申請任何東西。

### 6.3 流程

建房（選時長）→ 等待 → 訪客加入 → **房主看到訪客後手動按開始**（這同時擋掉亂猜房號的人）→ 雙方同步倒數 3 秒 → 對戰 → 結算寫入 Firestore

### 6.4 Presence 與斷線

用 `onDisconnect()` 在連線中斷時自動標記離線。

**斷線不可立即解散房間**，必須有約 30 秒寬限期。實際情境是：手機躺在地上、有來電或通知讓頁面進背景、iOS 凍結背景分頁。寬限期內對方畫面顯示「對手連線不穩，等待中…」，人回來就接回去。

邊界情況：
- 房主建房後訪客未到 → 房間只有一人是正常狀態，不算「沒有人」
- 房主離開 → 整個房間結束
- 訪客離開 → 只是空出位子，房主可繼續等新的人
- 兩人皆離線超過寬限期 → 刪除房間節點

### 6.5 時鐘同步

**絕對不可用客戶端計時器互相信任。** 讀取 RTDB 的 `.info/serverTimeOffset` 校正本機時鐘，房主按下開始時寫入一個絕對的伺服器時間戳，雙方各自校正後對齊倒數。

---

## 7. UI / UX 原則

**效能優先於特效。** 姿勢推論已經在吃 GPU，訓練中疊複雜特效會掉幀，而掉幀直接傷害計數準確度。

- **訓練中極簡** —— 使用者趴在地上、手臂在抖、視線距螢幕約 40 公分。滿螢幕粒子只會讓他看不到自己做幾下。維持現有的 `mix-blend-mode: difference` 巨大數字（不論背景明暗都可讀）
- **對戰中唯一該強化的是對手的即時數字** —— 落後幾下、追上了沒，這個緊張感勝過任何特效
- **非偵測時段可以盡情做效果** —— 開場、等待、對手出現、倒數、結算。這些時候相機推論應完全關閉，GPU 全給動畫
- **聲音是動作中唯一的回饋頻道**（iOS Safari 不支援震動）。現有音效設計要保留：到底部低頻悶響、完成時高頻且音高隨連續次數走音階上行

沿用現有設計語彙：ink `#0B0F14`、訊號橘 `#FF5A1F`、冷青 `#35E0D4`、Anton 標題字、Noto Sans TC 內文。

---

## 8. 安全性實作要求

- **顯示任何使用者輸入的文字（暱稱、房號）一律用 `textContent`，禁止 `innerHTML`。** 否則對手可用暱稱注入腳本
- Firebase 設定物件可公開，那不是密鑰
- 建立 `.gitignore` 排除 `.env`、service account JSON 等憑證檔
- 首次使用顯示簡短運動免責提醒（有身體狀況請先諮詢醫師、不適即停）
- 在介面明確告知：影像完全在裝置本機處理，不會上傳

---

## 9. PWA

`manifest.json` + 圖示 + 基本 service worker（快取靜態資源即可，不做離線對戰）。目標是「加入主畫面」後全螢幕、無網址列。

注意：iOS 上 PWA 首次開啟需重新授權相機。

---

## 10. 專案結構與部署

現在功能變多，單一 HTML 檔會難以維護。拆成：

```
index.html
css/
js/     pose.js  audio.js  room.js  auth.js  stats.js  ui.js
manifest.json  sw.js  icons/
firebase.rules  database.rules.json
README.md  LICENSE (MIT)  .gitignore
```

**不要引入打包工具。** 用原生 ES modules，GitHub Pages 直接吃靜態檔案。

部署到 GitHub Pages（公開 repo，`main` 分支根目錄或 `/docs`）。

---

## 11. 實作順序

1. 拆檔重構 + `.gitignore` + LICENSE（確認重構後偵測功能仍正常）
2. 安全規則（**先於任何資料庫程式碼**）
3. Google 登入 + 暱稱設定
4. Firestore 個人戰績
5. 房間：建房、房號、加入、presence、斷線寬限
6. 即時對戰：時鐘同步、即時比分、結算
7. PWA
8. 部署

每個階段結束後停下來讓人類實機測試，特別是第 5、6 步 —— 需要兩台裝置才能驗證。

---

## 12. 需要人類操作的步驟

以下無法自動化，遇到時停下來明確告知需要什麼：

- `firebase login` / `gh auth login`（瀏覽器授權）
- Firebase Console 啟用 Google 登入提供者
- Firebase Console 將 GitHub Pages 網域加入授權網域清單（**不做這步登入一定失敗**）
- 兩台實體裝置的對戰測試

---

## 13. 不要做的事

- 不要重寫或「優化」第 3 節的偵測演算法
- 不要引入前端框架或打包工具
- 不要加隨機配對、線上佇列、全球排行榜
- 不要在訓練畫面加重度特效
- 不要為了防作弊加伺服器端驗證（朋友之間玩，社交壓力就是約束）
- 不要收集非必要個資
