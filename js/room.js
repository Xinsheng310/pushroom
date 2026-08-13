/* 房間 — 建房、加入、presence、斷線寬限

   資料模型見 REPROOM_BUILD_SPEC.md 第 4.1 節，流程見第 6 節。

   幾個關鍵設計（都是規格第 6.4、6.5 節的要求）：

   1. 斷線不可立即解散房間，要有約 30 秒寬限期。
      實際情境：手機躺在地上、有來電或通知讓頁面進背景、iOS 凍結背景分頁。
      寬限期內對方畫面顯示「對手連線不穩」，人回來就接回去。

   2. 房主按下開始時寫入絕對伺服器時間戳，雙方各自校正時鐘後對齊倒數。
      絕不能各自用本機計時器互相信任。

   3. 房主離開 → 整個房間結束。訪客離開 → 只是空出位子，房主可繼續等。
      房主建房後訪客未到 → 房間只有一人是正常狀態，不算「沒有人」。 */

import { log } from './log.js';
import { isReady, getRtdb, getSdk } from './firebase.js';
import { makeCode, isValidCode } from './roomcode.js';
import { startClockSync, serverNow } from './clock.js';

/** 斷線寬限期（規格第 6.4 節「約 30 秒」） */
export const GRACE_MS = 30000;
/** 建房時房號碰撞的重試次數 */
const MAX_CODE_TRIES = 8;

/** 我在這個房間的角色 */
export const HOST = 'host', GUEST = 'guest';

const state = {
  code: null,
  role: null,
  unsub: null,          // 房間資料的訂閱
  presenceRef: null,    // 我的節點，用於 onDisconnect
  snapshot: null,        // 最新的房間資料
  joinedAt: 0,
};

const listeners = new Set();

export const getCode = ()=> state.code;
export const getRole = ()=> state.role;
export const getSnapshot = ()=> state.snapshot;
export const inRoom = ()=> !!state.code;
export const isHost = ()=> state.role===HOST;
/** 對手的角色代號 */
export const otherRole = ()=> state.role===HOST ? GUEST : HOST;

/** 訂閱房間變化。回傳取消訂閱函式。 */
export function onRoomChange(fn){
  listeners.add(fn);
  if(state.snapshot) fn(view());
  return ()=> listeners.delete(fn);
}
function emit(){
  const v = view();
  listeners.forEach(fn=>{
    try{ fn(v); }catch(e){ log('room listener 錯誤：'+e.message); }
  });
}

/* ============ 對外的房間視角 ============
   把原始資料整理成「我」與「對手」，UI 不需要自己判斷角色。 */
function view(){
  const d = state.snapshot;
  if(!d) return null;
  const meRaw = d[state.role] || null;
  const opRaw = d[otherRole()] || null;
  return {
    code: state.code,
    role: state.role,
    isHost: state.role===HOST,
    state: d.state || 'waiting',
    startAt: d.startAt || 0,
    countdownSec: d.countdownSec ?? 3,
    durationSec: d.config?.durationSec ?? 60,
    result: d.result || null,
    me: meRaw,
    opponent: opRaw,
    /* 對手是否在線。離線但還在寬限期內時 opponentStale 為 true，
       UI 應顯示「對手連線不穩，等待中…」而不是把人踢掉。 */
    opponentPresent: !!opRaw,
    opponentOnline: !!opRaw?.online,
    opponentStale: !!opRaw && !opRaw.online,
  };
}

/* ============ 建房 ============ */
/**
 * 建立房間。會檢查房號碰撞，重複則重新產生。
 * @param {{uid:string,name:string}} me
 * @param {number} durationSec
 * @returns {Promise<string>} 房號
 */
export async function createRoom(me, durationSec){
  requireReady();
  const { db: D } = getSdk();
  const rtdb = getRtdb();

  for(let i=0;i<MAX_CODE_TRIES;i++){
    const code = makeCode();
    const roomRef = D.ref(rtdb, 'rooms/'+code);

    /* 碰撞檢查。規則允許讀已登入者，所以這裡讀得到既有房間。 */
    const existing = await D.get(roomRef);
    if(existing.exists()) { log('房號 '+code+' 已被使用，重新產生'); continue; }

    /* config 與 host 分開寫：規則對每個節點分別授權，
       一次寫整個房間會被規則擋掉（房間層刻意不給 .write）。 */
    await D.set(D.ref(rtdb,`rooms/${code}/config`), {
      durationSec: Math.max(0, Math.floor(durationSec)),
      createdAt: D.serverTimestamp(),
    });
    await D.set(D.ref(rtdb,`rooms/${code}/host`), sideData(me));
    await D.set(D.ref(rtdb,`rooms/${code}/state`), 'waiting');

    await attach(code, HOST);
    log('建立房間 '+code+'（'+durationSec+'秒）');
    return code;
  }
  throw new Error('房號一直碰撞，請再試一次');
}

/* ============ 加入 ============ */
/**
 * 以訪客身分加入房間。
 * @param {{uid:string,name:string}} me
 * @param {string} code 已正規化的四碼房號
 */
export async function joinRoom(me, code){
  requireReady();
  if(!isValidCode(code)) throw new Error('房號格式不對');
  const { db: D } = getSdk();
  const rtdb = getRtdb();

  /* 先啟動時鐘同步再讀房間 —— 下面判斷寬限期要用校正後的時間，
     未同步時 serverNow() 等於本機時鐘，手機時間設錯就會誤判。 */
  startClockSync();

  const snap = await D.get(D.ref(rtdb,'rooms/'+code));
  if(!snap.exists()) throw new Error('找不到這個房間，房號可能打錯或房間已關閉');

  const d = snap.val();

  /* 我原本就在這個房間（重新連線的情況）→ 直接接回去 */
  if(d.host?.uid === me.uid){ await attach(code, HOST); await markOnline(); return; }
  if(d.guest?.uid === me.uid){ await attach(code, GUEST); await markOnline(); return; }

  /* 位子被別人佔著。注意這裡要看「有沒有人」而不是「在不在線」——
     對手可能只是暫時斷線還在寬限期內，位子仍然是他的。 */
  if(d.guest && d.guest.uid !== me.uid){
    if(!seatExpired(d.guest)) throw new Error('這個房間已經有兩個人了');
    log('前一位訪客已超過寬限期，接手位子');
  }

  await D.set(D.ref(rtdb,`rooms/${code}/guest`), sideData(me));
  await attach(code, GUEST);
  log('加入房間 '+code);
}

/* ============ presence ============ */
/**
 * 綁定房間並設定 onDisconnect。
 * onDisconnect 是 RTDB 才有的功能（規格第 2 節選它的理由）：
 * 連線中斷時由伺服器端代為寫入，即使手機直接斷電也會生效。
 */
async function attach(code, role){
  const { db: D } = getSdk();
  const rtdb = getRtdb();

  detach();                     // 換房間前先清掉舊的訂閱
  state.code = code;
  state.role = role;
  state.joinedAt = Date.now();

  startClockSync();

  const mineRef = D.ref(rtdb, `rooms/${code}/${role}`);
  state.presenceRef = mineRef;

  /* 斷線時把 online 設為 false 並記下時間，讓對手能算寬限期。
     不刪除整個節點 —— 位子還是我的，人回來要接得回去。 */
  const onlineRef = D.ref(rtdb, `rooms/${code}/${role}/online`);
  const leftRef   = D.ref(rtdb, `rooms/${code}/${role}/leftAt`);
  try{
    await D.onDisconnect(onlineRef).set(false);
    await D.onDisconnect(leftRef).set(D.serverTimestamp());
  }catch(e){
    log('onDisconnect 設定失敗：'+(e.message||e).toString().slice(0,80));
  }

  /* 訂閱整個房間 */
  state.unsub = D.onValue(D.ref(rtdb,'rooms/'+code), snap=>{
    state.snapshot = snap.val();
    if(!state.snapshot){
      /* 房間被刪掉了（房主離開） */
      log('房間已關閉');
      const wasCode = state.code;
      detach();
      state.code = null; state.role = null;
      listeners.forEach(fn=>{ try{ fn(null); }catch(e){} });
      return;
    }
    emit();
  }, err=> log('房間訂閱錯誤：'+(err.message||err).toString().slice(0,80)));
}

function detach(){
  if(state.unsub){ state.unsub(); state.unsub = null; }
  if(state.presenceRef){
    try{ getSdk().db.onDisconnect(state.presenceRef).cancel(); }catch(e){}
    state.presenceRef = null;
  }
  state.snapshot = null;
}

async function markOnline(){
  if(!state.code) return;
  const { db: D } = getSdk();
  await D.update(D.ref(getRtdb(), `rooms/${state.code}/${state.role}`), {
    online: true, leftAt: null,
  });
}

/* ============ 更新自己的狀態 ============ */
/** 更新自己的次數。規則保證別人改不了我的 reps。 */
export async function pushReps(reps){
  if(!state.code || !isReady()) return;
  const n = Math.max(0, Math.floor(reps));
  const { db: D } = getSdk();
  try{
    await D.set(D.ref(getRtdb(), `rooms/${state.code}/${state.role}/reps`), n);
  }catch(e){
    log('reps 上傳失敗：'+(e.message||e).toString().slice(0,70));
  }
}

export async function setReady(ready){
  if(!state.code) return;
  const { db: D } = getSdk();
  await D.set(D.ref(getRtdb(), `rooms/${state.code}/${state.role}/ready`), !!ready);
}

/* ============ 房主：開始比賽 ============ */
/**
 * 房主按下開始。寫入伺服器時間戳，雙方對齊倒數（規格第 6.5 節）。
 * @param {number} countdownSec 倒數秒數
 */
export async function startMatch(countdownSec = 3){
  requireReady();
  if(state.role !== HOST) throw new Error('只有房主能開始');
  const { db: D } = getSdk();
  const rtdb = getRtdb();

  /* 規則強制 startAt == now（伺服器時間戳），所以只能寫 serverTimestamp。
     倒數長度另外存，兩邊各自加。 */
  await D.set(D.ref(rtdb,`rooms/${state.code}/countdownSec`), Math.floor(countdownSec));
  await D.set(D.ref(rtdb,`rooms/${state.code}/startAt`), D.serverTimestamp());
  await D.set(D.ref(rtdb,`rooms/${state.code}/state`), 'counting');
  log('房主開始比賽');
}

/** 房主推進狀態 */
export async function setState(next){
  if(state.role !== HOST || !state.code) return;
  const { db: D } = getSdk();
  await D.set(D.ref(getRtdb(),`rooms/${state.code}/state`), next);
}

/* ============ 結算 ============ */
/**
 * 寫入結算。任一參與者都能寫，規則保證只能寫一次（先到先算），
 * 這樣房主在結算瞬間斷線時訪客還能補上。
 */
export async function writeResult(hostReps, guestReps){
  if(!state.code || !isReady()) return null;
  const h = Math.max(0,Math.floor(hostReps)), g = Math.max(0,Math.floor(guestReps));
  const winner = h>g ? 'host' : g>h ? 'guest' : 'draw';
  const { db: D } = getSdk();
  try{
    await D.set(D.ref(getRtdb(),`rooms/${state.code}/result`),
      { hostReps:h, guestReps:g, winner });
    log('結算寫入 '+h+':'+g+' → '+winner);
  }catch(e){
    /* 對方先寫了就會走到這裡，不是錯誤 */
    log('結算已由對方寫入');
  }
  return winner;
}

/* ============ 離開 ============ */
/**
 * 離開房間。
 * 房主離開 → 刪掉整個房間（規格第 6.4 節：房主離開，整個房間結束）。
 * 訪客離開 → 只清掉自己的節點，房主可以繼續等新的人。
 */
export async function leaveRoom(){
  if(!state.code || !isReady()){ detach(); state.code=null; state.role=null; return; }
  const { db: D } = getSdk();
  const rtdb = getRtdb(), code = state.code, role = state.role;
  detach();
  try{
    if(role===HOST) await D.remove(D.ref(rtdb,'rooms/'+code));
    else            await D.remove(D.ref(rtdb,`rooms/${code}/guest`));
    log('離開房間 '+code);
  }catch(e){
    log('離開房間失敗：'+(e.message||e).toString().slice(0,70));
  }
  state.code = null; state.role = null;
}

/* ============ 寬限期判斷 ============ */
/**
 * 對手是否已超過寬限期未回來。
 * 給 UI 決定顯示「連線不穩，等待中…」還是「對手已離開」。
 * @returns {{stale:boolean, expired:boolean, msLeft:number}}
 */
export function opponentGrace(){
  const d = state.snapshot;
  const op = d?.[otherRole()];
  if(!op) return { stale:false, expired:false, msLeft:0 };
  if(op.online) return { stale:false, expired:false, msLeft:GRACE_MS };
  /* leftAt 還沒寫進來時給滿額寬限，與 seatExpired() 的保守作法一致 */
  const left = op.leftAt || serverNow();
  const msLeft = Math.max(0, GRACE_MS - (serverNow() - left));
  return { stale:true, expired: seatExpired(op), msLeft };
}

/* ============ 頁面進背景 / 回前景 ============
   iOS 會凍結背景分頁，回來時 RTDB 連線可能已斷。
   規格第 6.4 節說的正是這個情境，所以回前景時要主動標記自己在線。 */
export function installVisibilityHandler(){
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='visible' && state.code){
      markOnline().catch(()=>{});
    }
  });
}

/* ============ 小工具 ============ */
/**
 * 這個位子是否已經空出來（斷線且超過寬限期）。
 *
 * leftAt 缺失時一律視為「還沒過期」——寧可讓新人等一下，
 * 也不要把只是暫時斷線的人踢掉。onDisconnect 偶爾會來不及寫入
 * （例如網路瞬斷後伺服器還沒偵測到），那時 leftAt 就是 undefined。
 */
function seatExpired(side){
  if(!side) return true;            // 沒人 → 空位
  if(side.online) return false;     // 在線 → 位子是他的
  if(!side.leftAt) return false;    // 斷線但沒時間戳 → 保守視為仍佔用
  return serverNow() - side.leftAt > GRACE_MS;
}

function sideData(me){
  return {
    uid: me.uid,
    name: me.name,
    online: true,
    reps: 0,
    ready: false,
  };
}
function requireReady(){
  if(!isReady()) throw new Error('Firebase 未就緒，無法使用房間功能');
}
