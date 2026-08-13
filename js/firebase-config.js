/* Firebase 專案設定

   這份設定可以公開（規格第 8 節：「Firebase 設定物件可公開，那不是密鑰」）。
   真正的防線是 firestore.rules 與 database.rules.json。

   專案：pushroom-5c735（Spark 免費方案）

   來源：Firebase 控制台 → 專案設定 → 一般 → 你的應用程式 → 網頁應用 */

export const firebaseConfig = {
  apiKey:            "AIzaSyAWmffbMitSpqko3U0fZQFHevlKHDvz45o",
  authDomain:        "pushroom-5c735.firebaseapp.com",
  projectId:         "pushroom-5c735",
  storageBucket:     "pushroom-5c735.firebasestorage.app",
  messagingSenderId: "472594373179",
  appId:             "1:472594373179:web:6ea35f90c9594e08d5da1e",
  databaseURL:       "https://pushroom-5c735-default-rtdb.asia-southeast1.firebasedatabase.app",
};

/** 設定是否已填完整。未填完時 App 以「單機模式」運作，只是沒有登入與對戰。 */
export const configReady = !Object.values(firebaseConfig).includes("PENDING");
