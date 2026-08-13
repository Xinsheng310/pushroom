/* 時鐘同步

   規格第 6.5 節：絕對不可用客戶端計時器互相信任。
   讀取 RTDB 的 .info/serverTimeOffset 校正本機時鐘，
   房主按下開始時寫入一個絕對的伺服器時間戳，雙方各自校正後對齊倒數。

   為什麼這件事必須做對：兩支手機的系統時鐘可能差好幾秒（甚至幾分鐘，
   時區設錯或沒對時的手機很常見）。如果各自用 Date.now() 倒數，
   一方會比另一方早開始，先開始的那個人就多做了幾下。

   注意 performance.now() 與 Date.now() 的分工：
     - Date.now()        牆上時間，可與伺服器對齊，但可能被系統校時往前/往後跳
     - performance.now() 單調遞增，不會跳，適合算「已經過了多久」
   倒數的「起點」用校正後的牆上時間對齊，起跑之後的計時用 performance.now()。 */

import { log } from './log.js';
import { isReady, getRtdb, getSdk } from './firebase.js';

let offset = 0;          // 伺服器時間 - 本機時間（毫秒）
let synced = false;
let unsub = null;

export const isSynced = () => synced;
export const getOffset = () => offset;

/** 校正後的「現在」——約等於伺服器的 Date.now() */
export const serverNow = () => Date.now() + offset;

/**
 * 開始監聽時間偏移。RTDB 會持續更新這個值（例如網路狀況變化後重新估算）。
 * 可重複呼叫，不會重複訂閱。
 */
export function startClockSync(){
  if(!isReady() || unsub) return;
  const { db: D } = getSdk();
  const ref = D.ref(getRtdb(), '.info/serverTimeOffset');
  unsub = D.onValue(ref, snap=>{
    const v = snap.val();
    if(typeof v === 'number'){
      const first = !synced;
      offset = v;
      synced = true;
      if(first || Math.abs(v) > 2000) log('時鐘偏移 '+Math.round(v)+'ms');
    }
  }, err=> log('時鐘同步失敗：'+(err.message||err).toString().slice(0,80)));
}

export function stopClockSync(){
  if(unsub){ unsub(); unsub = null; }
  synced = false; offset = 0;
}

/**
 * 把「伺服器的絕對時刻」換算成「從現在起還有幾毫秒」。
 * @param {number} serverTs 伺服器時間戳（RTDB 的 startAt）
 * @returns {number} 毫秒，已過期則為負數
 */
export const msUntil = serverTs => serverTs - serverNow();

/**
 * 建立一個以伺服器時刻為起點的計時器。
 *
 * 起點用校正後的牆上時間對齊（雙方一致），
 * 起跑後改用 performance.now() 累計（不受系統校時影響）。
 *
 * @param {number} startAtServer 伺服器時間戳，倒數結束＝比賽開始的那一刻
 * @returns {{elapsed:()=>number, remainingTo:(durMs:number)=>number, started:()=>boolean}}
 */
export function alignedTimer(startAtServer){
  /* 用「現在距離起點多久」決定基準的 performance.now()。
     若起點已過（例如加入房間時比賽已開始），基準會落在過去。 */
  const perfAtStart = performance.now() + msUntil(startAtServer);
  return {
    started: ()=> performance.now() >= perfAtStart,
    elapsed: ()=> performance.now() - perfAtStart,
    remainingTo: durMs => perfAtStart + durMs - performance.now(),
  };
}
