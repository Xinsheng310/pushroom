/* 偵測演算法 — 訊號擷取、校正、計數狀態機

   ⚠ 這裡的每個數值都是實機調校過的，是規格第 3 節的實作。
   不要重寫、不要「優化」，改動前必須先問人類。 */

import { L, vis } from './pose.js';
import { sfx } from './audio.js';

/* 寬高比校正係數，由主迴圈每幀更新 */
let AR = 1;
export const setAspect = ar => { AR = ar || 1; };

const dist = (lm,a,b) => Math.hypot((lm[a].x-lm[b].x)*AR, lm[a].y-lm[b].y);

function angle(lm,a,b,c){
  const ux=(lm[a].x-lm[b].x)*AR, uy=lm[a].y-lm[b].y;
  const vx=(lm[c].x-lm[b].x)*AR, vy=lm[c].y-lm[b].y;
  const d=(ux*vx+uy*vy)/(Math.hypot(ux,uy)*Math.hypot(vx,vy)+1e-9);
  return Math.acos(Math.max(-1,Math.min(1,d)))*180/Math.PI;
}

/* 四個候選訊號，校正時挑「上下差距最大、抖動最小」的那個來計數。
   任一 landmark 的 visibility < 0.5 時回傳 null。 */
export const SIGNALS = {
  elbow:{ label:'手肘角度', get(lm){
    const ok=i=>vis(lm,i)>.5; let s=0,n=0;
    if(ok(L.LSHO)&&ok(L.LELB)&&ok(L.LWRI)){ s+=angle(lm,L.LSHO,L.LELB,L.LWRI); n++; }
    if(ok(L.RSHO)&&ok(L.RELB)&&ok(L.RWRI)){ s+=angle(lm,L.RSHO,L.RELB,L.RWRI); n++; }
    return n? s/n : null; } },
  eyes:{ label:'臉部距離', get(lm){
    return (vis(lm,L.LEYE)>.5&&vis(lm,L.REYE)>.5)? dist(lm,L.LEYE,L.REYE)*100 : null; } },
  shoulders:{ label:'肩寬', get(lm){
    return (vis(lm,L.LSHO)>.5&&vis(lm,L.RSHO)>.5)? dist(lm,L.LSHO,L.RSHO)*100 : null; } },
  height:{ label:'肩膀高度', get(lm){
    return (vis(lm,L.LSHO)>.5&&vis(lm,L.RSHO)>.5)? (lm[L.LSHO].y+lm[L.RSHO].y)/2*100 : null; } },
};

export const bodyFound = lm => lm && (vis(lm,L.LSHO)>.5||vis(lm,L.RSHO)>.5||vis(lm,L.NOSE)>.6);

/* ============ 校正時間常數 ============
   每一步都是「先給緩衝期擺姿勢，再取樣」。緩衝期絕對不能取樣 —
   取到移動中的樣本會讓標準差爆表，這是原本最嚴重的 bug。 */
export const SETTLE_MS = 2200, HOLD_MS = 1800;
export const PASS = 2.0;

/* 中位數 + MAD，比平均/標準差耐得住偶發的關節點跳動 */
export function robust(a){
  if(!a || a.length<10) return null;
  const s=[...a].sort((x,y)=>x-y);
  const med=s[(s.length>>1)];
  const dev=s.map(v=>Math.abs(v-med)).sort((x,y)=>x-y);
  return {m:med, sd:dev[(dev.length>>1)]*1.4826};
}

/**
 * 對每個訊號分別算上下兩組的中位數與 MAD，分離度 = |中位數差| / (MAD和 + 1e-3)。
 * @param {{1:Object,2:Object}} samples 兩步的取樣桶
 * @returns {{report:Array, best:Object|null}} report 含每個訊號的分數（null = 資料不足）
 */
export function scoreCalibration(samples){
  const report=[];
  let best=null;
  for(const k in SIGNALS){
    const u=robust(samples[1]?.[k]), d=robust(samples[2]?.[k]);
    if(!u||!d){ report.push({k,score:null}); continue; }
    const score = Math.abs(u.m-d.m) / (u.sd+d.sd+1e-3);
    report.push({k,score,u:u.m,d:d.m});
    if(!best || score>best.score) best={key:k, up:u.m, down:d.m, score};
  }
  return {report, best};
}

/* ============ 計數狀態機 ============ */
export const TH = { down:.72, up:.32 };
const MIN_REP_MS = 380, MIN_HOLD_MS = 140;

/** 執行時狀態。phase: idle | calib | countdown | run | done | lab */
export const S = {
  phase:'idle',
  key:null, up:0, down:0,   // 選中的訊號 + 上下基準
  ema:null, depth:0,
  repState:'up', lastEdge:0, reps:0, times:[], startAt:0, endAt:0,
};

export function resetCounter(){
  S.reps=0; S.times=[]; S.repState='up'; S.lastEdge=0; S.ema=null; S.depth=0;
}

/**
 * 共用的深度計算 + 狀態機。run 與測試模式共用同一份，行為必然一致。
 * @returns {'rep'|'down'|''|null} null 代表看不到身體
 */
export function track(lm, ts){
  const raw = lm && S.key ? SIGNALS[S.key].get(lm) : null;
  if(raw==null) return null;
  S.ema = S.ema==null? raw : S.ema*0.62 + raw*0.38;
  let d=(S.ema-S.up)/((S.down-S.up)||1e-6);
  S.depth = d = Math.max(0,Math.min(1.25,d));

  if(S.repState==='up' && d>TH.down && ts-S.lastEdge>MIN_HOLD_MS){
    S.repState='down'; S.lastEdge=ts; sfx.bottom(); return 'down';
  }
  if(S.repState==='down' && d<TH.up && ts-S.lastEdge>MIN_REP_MS){
    S.repState='up'; S.lastEdge=ts;
    S.reps++; S.times.push(ts-S.startAt);
    sfx.rep(S.reps); return 'rep';
  }
  return '';
}
