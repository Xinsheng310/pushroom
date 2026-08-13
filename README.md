# PUSH ROOM

用手機鏡頭偵測伏地挺身次數的網頁 App。可以建房間、分享四碼房號給朋友，兩人即時對戰比誰在限時內做得多，並記錄戰績。

**完全免費、開源、無商業模式。** 不做金流、不做廣告、不做訂閱。

影像完全在裝置本機處理，不會上傳到任何伺服器。

## 現況 — V0.9

規格第 11 節的八個步驟全部完成，另加三輪 UI/UX 演出與效能優化。

**功能**
- 單機計數：姿勢偵測、兩段式校正（結果存本機自動帶入）、音效、計時結算、測試模式
- Google 登入與自訂暱稱（不沿用 Google 真名、不儲存 email）
- 四碼房號對戰：建房/加入/分享、presence 與 30 秒斷線寬限、伺服器時鐘同步、對手即時比分
- 判定標準可選：標準 / 寬鬆 / 房主的 / 各自 —— 雙方套用同一組門檻，基準各自校正
- 對戰時長：30 秒 / 1 分 / 2 分 / 無限（無限由任一方長按 ✕ 結束）
- 戰績：勝敗統計與對戰紀錄清單（Firestore）
- PWA：可加入主畫面

**效能與省電**
- 只在校正/倒數/計數時做姿勢推論，其餘畫面完全停止
- 同一 video frame 只推論一次（原本因去重失效而推論兩次）
- 首頁不啟用相機；進背景停止供幀、超過 30 秒完整釋放
- **比賽進行中一律豁免**：不停供幀、不釋放相機，避免回來時漏算
- 測試模式可看推論/幀時間的 p50/p95 與長幀次數

**演出**
- 面板轉場、倒數放大收縮、勝負以形態區分（不靠顏色）、結算數字滾動
- 骨架顏色隨下壓深度由冷青燒到訊號橘（零成本，同時是功能回饋）
- 深度計是完整刻度尺，含上下兩條判定門檻線
- 音效層次：深度驅動的漸強嗡鳴、每 5/10 下的和聲、對手加分的低音撥弦

**尚未驗證**：兩台實體裝置的多場對戰、長時間使用的熱節流表現。

## 線上版

https://xinsheng310.github.io/pushroom/

## 本機測試

相機需要安全來源，`file://` 直接開檔案不行，必須用 https 或 localhost。

```bash
python -m http.server 8000
```

然後開 `http://localhost:8000`。

用手機實機測試時，手機連的是區域網路 IP 而非 localhost，瀏覽器會判定為不安全來源而拒絕給相機權限，需要 https。最簡單的做法是推到 GitHub Pages 測。

## 迴歸測試

### 偵測演算法

用合成 landmark 序列驗證，不需相機也不需瀏覽器：

```bash
node tests/detect.test.mjs
```

測試內含一份原始單檔版演算法作為對照組，比對校正分數、rep 數、depth 逐幀軌跡是否完全一致。
**動到 `js/detect.js` 後務必跑這個** —— 它就是用來擋住「不小心改壞演算法」的。

### 安全規則（靜態檢查）

不需 Java、不需 emulator，檢查規則檔結構與每條約束是否都在：

```bash
node tests/rules.test.mjs
```

### 安全規則（行為驗證，49 項）

真的用 emulator 去攻擊規則。需要 Java 與 firebase-tools：

```bash
npm install -g firebase-tools
npm install --no-save @firebase/rules-unit-testing firebase
powershell -File tests/run-emulator.ps1
```

沒有系統 Java 時可用免安裝版，並把路徑傳給腳本：

```bash
powershell -File tests/run-emulator.ps1 -JavaHome "C:\path\to\jdk-21-jre"
```

驗證項目包含：他人不可寫我的 reps、不可偽造比賽參與者、不可自己跟自己打刷勝場、
winner 必須與次數相符、`startAt` 必須是伺服器時間戳、已寫入的戰績不可篡改、
房間層無法被一次覆寫。**動到任何規則後務必跑這個。**

## 專案結構

```
index.html              畫面結構（11 個 panel）
css/app.css             樣式與所有演出
manifest.json           PWA 設定
sw.js                   Service Worker（只快取靜態資源；localhost 不介入）
icons/                  PWA 圖示（程式產生的 PR 字標）
firestore.rules         Firestore 安全規則
firestore.indexes.json  複合索引（戰績查詢用）
database.rules.json     Realtime Database 安全規則
firebase.json           規則/索引位置與 emulator 設定
tests/                  迴歸測試（10 支）
docs/                   規格書與原始單檔版
```

`js/` 模組：

| 檔案 | 職責 |
|---|---|
| `log.js` | 畫面內日誌與錯誤橫幅（手機沒有 console） |
| `audio.js` | Web Audio 合成音效 + 深度驅動的嗡鳴 |
| `pose.js` | 相機開關/省電 + MediaPipe 模型 + 骨架繪製 |
| `detect.js` | **偵測演算法**（訊號、校正、計數狀態機）— 勿改 |
| `perf.js` | 推論/幀時間的 p50/p95 與長幀統計 |
| `calibmode.js` | 判定標準（標準/寬鬆/房主的/各自） |
| `calibstore.js` | 校正結果存本機與過期判斷 |
| `ui.js` | DOM 存取、面板切換與所有演出的觸發 |
| `firebase.js` | Firebase 初始化（失敗時降級為單機） |
| `auth.js` | Google 登入與暱稱 |
| `matches.js` | 對戰紀錄與勝敗統計 |
| `room.js` | 房間、presence、斷線寬限、死房間清理 |
| `roomcode.js` | 四碼房號產生與誤輸入正規化 |
| `clock.js` | 伺服器時鐘同步與對齊計時器 |
| `share.js` | 分享房號（native share / 剪貼簿 / LINE） |
| `versus.js` | 對戰流程（大廳→等待→倒數→對戰→結算） |
| `main.js` | 主迴圈、校正流程、省電策略、導覽 |

無框架、無打包工具，原生 ES modules，GitHub Pages 直接吃靜態檔案。

## 注意

`js/detect.js` 的偵測演算法是實機調校過的，數值不要隨意改動。規格見 [建置規格書](docs/PUSHROOM_BUILD_SPEC.md) 第 3 節。

## 免責

運動有風險。有身體狀況請先諮詢醫師，運動中感到不適請立即停止。

## 授權

[MIT](LICENSE)
