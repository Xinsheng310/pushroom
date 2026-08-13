# REP ROOM

用手機鏡頭偵測伏地挺身次數的網頁 App。可以建房間、分享四碼房號給朋友，兩人即時對戰比誰在限時內做得多，並記錄戰績。

**完全免費、開源、無商業模式。** 不做金流、不做廣告、不做訂閱。

影像完全在裝置本機處理，不會上傳到任何伺服器。

## 現況

單機計數版可用：姿勢偵測、兩段式校正、音效回饋、計時結算、測試模式。
房間對戰與登入尚未實作（見 [建置規格書](docs/REPROOM_BUILD_SPEC.md) 第 11 節實作順序）。

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

### 安全規則（行為驗證）

真的去試著攻擊規則。需要先安裝 Java 與 firebase-tools：

```bash
npm install -g firebase-tools
npm install --no-save @firebase/rules-unit-testing firebase
firebase emulators:exec --only firestore,database "node tests/rules.emulator.test.mjs"
```

驗證項目包含：他人不可寫我的 reps、不可偽造比賽參與者、不可自己跟自己打刷勝場、
winner 必須與次數相符、`startAt` 必須是伺服器時間戳、已寫入的戰績不可篡改。

## 專案結構

```
index.html          畫面結構
css/app.css         樣式
js/log.js           畫面內日誌（手機沒有 console）
js/audio.js         Web Audio 合成音效
js/pose.js          相機 + MediaPipe 模型 + 骨架繪製
js/detect.js        偵測演算法（訊號、校正、計數狀態機）
js/ui.js            DOM 存取與渲染
js/main.js          主流程
firestore.rules     Firestore 安全規則
database.rules.json Realtime Database 安全規則
firebase.json       規則檔位置與 emulator 設定
tests/              迴歸測試
docs/               規格書與原始單檔版
```

無框架、無打包工具，原生 ES modules，GitHub Pages 直接吃靜態檔案。

## 注意

`js/detect.js` 的偵測演算法是實機調校過的，數值不要隨意改動。規格見 [建置規格書](docs/REPROOM_BUILD_SPEC.md) 第 3 節。

## 免責

運動有風險。有身體狀況請先諮詢醫師，運動中感到不適請立即停止。

## 授權

[MIT](LICENSE)
