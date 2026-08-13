/* 校正結果的本機儲存

   校正要擺兩個姿勢、等 8 秒，每次開 App 都重做很煩。
   存起來下次自動帶入。

   為什麼存本機而不是帳號：
   基準（up/down）綁定這台裝置的鏡頭距離、角度與使用者身材。
   存到帳號、換手機套用舊基準反而會出錯 —— 那不是「同步」而是「污染」。
   門檻（down/up 比例）雖然與裝置無關，但它跟基準是一組設定，
   分開存會讓「我上次調好的」變成兩個地方各有一半，反而更難理解。

   過期判斷：基準會因為手機擺放位置改變而失效。
   使用者不會記得「我上次是放在哪」，所以超過一天就提示重新校正 ——
   但不刪除，因為「不準」比「完全不能用」好，讓使用者自己決定。 */

import { log } from './log.js';

const KEY = 'reproom.calib.v1';
/** 超過這個時間就建議重新校正（毫秒） */
export const STALE_MS = 24*60*60*1000;

/**
 * @typedef {Object} Calib
 * @property {string} key      訊號代號（elbow / eyes / shoulders / height）
 * @property {number} up       頂點基準
 * @property {number} down     最低點基準
 * @property {number} score    校正時的分離度分數
 * @property {number} thDown   下壓門檻
 * @property {number} thUp     回頂門檻
 * @property {boolean} front   當時用的是前鏡頭（換鏡頭基準就不能用了）
 * @property {number} savedAt  存檔時間戳
 */

/** 讀取存檔。格式不對或不存在回傳 null。 */
export function loadCalib(){
  let raw;
  try{ raw = localStorage.getItem(KEY); }catch(e){ return null; }
  if(!raw) return null;
  try{
    const c = JSON.parse(raw);
    /* 逐欄驗證 —— localStorage 可能被使用者或其他程式改壞，
       壞掉的基準會讓計數整場錯亂，寧可當作沒存過。 */
    if(typeof c!=='object' || c===null) return null;
    if(typeof c.key!=='string' || !c.key) return null;
    for(const f of ['up','down','thDown','thUp']){
      if(typeof c[f]!=='number' || !Number.isFinite(c[f])) return null;
    }
    /* 上下基準相同會讓深度公式除以零 */
    if(c.up===c.down) return null;
    if(!(c.thDown>c.thUp)) return null;
    return c;
  }catch(e){
    return null;
  }
}

/** 存檔。失敗不拋錯（隱私模式下 localStorage 可能不可寫）。 */
export function saveCalib({key, up, down, score, thDown, thUp, front}){
  const c = {
    key, up, down,
    score: Number.isFinite(score) ? score : 0,
    thDown, thUp,
    front: !!front,
    savedAt: Date.now(),
  };
  try{
    localStorage.setItem(KEY, JSON.stringify(c));
    log('校正已儲存');
    return true;
  }catch(e){
    log('校正存不起來：'+(e.message||e).toString().slice(0,60));
    return false;
  }
}

export function clearCalib(){
  try{ localStorage.removeItem(KEY); log('校正紀錄已清除'); }catch(e){}
}

/** 存檔是否已過期（建議重新校正，但仍可用） */
export function isStale(c, now=Date.now()){
  if(!c?.savedAt) return true;
  return (now - c.savedAt) > STALE_MS;
}

/** 存檔是否適用於目前的鏡頭設定。換鏡頭後基準完全不同。 */
export const matchesCamera = (c, front)=> !!c && c.front === !!front;

/** 給 UI 顯示的說明文字 */
export function describeAge(c, now=Date.now()){
  if(!c?.savedAt) return '';
  const min = Math.floor((now - c.savedAt)/60000);
  if(min < 1) return '剛剛校正';
  if(min < 60) return min+' 分鐘前校正';
  const hr = Math.floor(min/60);
  if(hr < 24) return hr+' 小時前校正';
  return Math.floor(hr/24)+' 天前校正';
}
