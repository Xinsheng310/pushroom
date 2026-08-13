/* Firebase 初始化

   用 CDN ES modules，不引入打包工具（規格第 2、10 節）。

   設計原則：Firebase 載入失敗時 App 必須仍能單機計數。
   計數器是核心功能，不該因為 CDN 掛掉或設定沒填就整個壞掉，
   所以這裡所有匯出在失敗時都是 null，呼叫端自己判斷。 */

import { log } from './log.js';
import { firebaseConfig, configReady } from './firebase-config.js';

const V = '10.14.1';
const BASE = `https://www.gstatic.com/firebasejs/${V}`;

let app = null, auth = null, db = null, rtdb = null;
let sdk = null;          // { authFns, storeFns, dbFns }
let ready = false;

/** Firebase 是否可用。false 時 App 以單機模式運作。 */
export const isReady = () => ready;
export const getAuth = () => auth;
export const getDb = () => db;
export const getRtdb = () => rtdb;
/** SDK 函式集合（modular SDK 的函式都要從模組取，不是掛在物件上） */
export const getSdk = () => sdk;

export async function initFirebase(){
  if(!configReady){
    log('Firebase 設定未填完，以單機模式運作');
    return false;
  }
  try{
    const [appMod, authMod, storeMod, dbMod] = await Promise.all([
      import(`${BASE}/firebase-app.js`),
      import(`${BASE}/firebase-auth.js`),
      import(`${BASE}/firebase-firestore.js`),
      import(`${BASE}/firebase-database.js`),
    ]);

    app  = appMod.initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    db   = storeMod.getFirestore(app);
    rtdb = dbMod.getDatabase(app);

    sdk = { auth: authMod, store: storeMod, db: dbMod };

    /* 登入狀態存在本機，重開 App 不用重新登入 */
    await authMod.setPersistence(auth, authMod.browserLocalPersistence);

    ready = true;
    log('Firebase 就緒 · ' + firebaseConfig.projectId);
    return true;
  }catch(e){
    log('Firebase 載入失敗（單機模式）：' + (e.message||e).toString().slice(0,110));
    return false;
  }
}
