/* Firebase 專案設定

   這份設定可以公開（規格第 8 節：「Firebase 設定物件可公開，那不是密鑰」）。
   真正的防線是 firestore.rules 與 database.rules.json。

   專案：pushroom-5c735（Spark 免費方案）

   ⚠ apiKey / messagingSenderId / appId 三項必須從 Firebase 控制台取得：
     專案設定 → 一般 → 你的應用程式 → 網頁應用 → firebaseConfig
   填好後把下方 PENDING 的值換掉。 */

export const firebaseConfig = {
  apiKey:            "PENDING",
  authDomain:        "pushroom-5c735.firebaseapp.com",
  projectId:         "pushroom-5c735",
  storageBucket:     "pushroom-5c735.firebasestorage.app",
  messagingSenderId: "PENDING",
  appId:             "PENDING",
  databaseURL:       "https://pushroom-5c735-default-rtdb.asia-southeast1.firebasedatabase.app",
};

/** 設定是否已填完整。未填完時 App 以「單機模式」運作，只是沒有登入與對戰。 */
export const configReady = !Object.values(firebaseConfig).includes("PENDING");
