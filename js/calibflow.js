/* 校正流程 — 三步驟引導、取樣、評分、套用

   規格第 3.2 節：三個步驟（找到人 → 撐直手臂 → 下到最低點），
   每步先給 SETTLE_MS 擺姿勢、再取樣 HOLD_MS，最後挑分數最高的訊號。

   演算法本身住在 detect.js（不可修改）。這裡只負責流程與畫面。

   這個模組不決定「校正完要去哪裡」—— 可能回計時、回測試模式、回等待室，
   那是呼叫端的事。完成時把選中的訊號交回去，由呼叫端決定下一步。 */

import { log } from './log.js';
import { sfx } from './audio.js';
import {
  SIGNALS, bodyFound, SETTLE_MS, HOLD_MS, PASS, scoreCalibration, S,
} from './detect.js';
import {
  $, show, setRing, setRingStroke, showRing, renderCalibReport, setScan,
} from './ui.js';

/** 找不到人多久之後開始給退路（毫秒） */
const HINT_MS = 8000;
const GIVEUP_MS = 20000;
/** 判定「確實看到人了」需要連續多久 */
const SEEN_MS = 700;

let calib = {step:0, t0:0, samples:{}, seenAt:0, holding:false, enteredAt:0};

/** 校正完成（且通過或使用者強制採用）時的回呼 */
let onApply = null;
/** 需要知道目前是前鏡頭還後鏡頭，用來寫「換成 X 鏡頭」的按鈕文字 */
let getFront = ()=> true;

/**
 * @param {(best:{key:string,up:number,down:number,score:number})=>void} apply
 * @param {()=>boolean} front 目前是否為前鏡頭
 */
export function installCalibFlow(apply, front){
  onApply = apply;
  getFront = front;
}

/** 使用者按了「換鏡頭」之後呼叫，重置提示計時 */
export function resetCalibSearch(){
  calib.enteredAt = performance.now();
  calib.seenAt = 0;
}

export function beginCalibration(){
  S.phase = 'calib';
  calib = {step:0, t0:0, samples:{}, seenAt:0, holding:false,
           enteredAt: performance.now()};   // 用來算「找不到人」多久了
  $('flipCam').hidden = true;
  showRing(false);
  $('forceUse').style.display = 'none';
  $('cancelSetup').textContent = '取消';
  $('stepLabel').textContent = 'STEP 1 / 3';
  $('say').textContent = '找你';
  $('subSay').textContent = '上半身進入畫面';
  show('setup');
}

function calibPrompt(step){
  showRing(true);
  calib.holding = false;
  setRingStroke('rgba(255,255,255,.28)');
  setRing(0);
  if(step===1){ $('stepLabel').textContent='STEP 2 / 3'; $('say').textContent='撐直手臂'; }
  if(step===2){ $('stepLabel').textContent='STEP 3 / 3'; $('say').textContent='下到最低點'; }
  $('subSay').textContent = '擺好姿勢';
  sfx.ready();
}

function collect(lm){
  const bucket = calib.samples[calib.step] ||= {};
  for(const k in SIGNALS){
    const v = SIGNALS[k].get(lm);
    if(v!=null) (bucket[k] ||= []).push(v);
  }
}

function finishCalibration(){
  const {report, best} = scoreCalibration(calib.samples);
  log('校正結果 '+report.map(r=>r.k+'='+(r.score==null?'無資料':r.score.toFixed(1))).join('  '));

  if(best && best.score>=PASS){ onApply?.(best); return; }

  showRing(false);
  $('say').textContent = '校正未通過';
  renderCalibReport(report, best, SIGNALS, PASS);
  $('forceUse').style.display = best? 'block' : 'none';
  $('forceUse').onclick = ()=>{ log('使用者強制採用 '+best.key); onApply?.(best); };
  $('cancelSetup').textContent = '重新校正';
  S.phase = 'idle';
  sfx.warn();
}

/**
 * 校正相位的每幀處理。由 main.js 的 onFrame 在 S.phase==='calib' 時呼叫。
 */
export function calibFrame(lm, ts){
  if(calib.step===0){
    if(bodyFound(lm)){
      if(!calib.seenAt) calib.seenAt = ts;
      if(ts-calib.seenAt>SEEN_MS){
        calib.step=1; calib.t0=ts;
        $('flipCam').hidden = true;
        calibPrompt(1);
      }
    } else {
      calib.seenAt = 0;
      /* 鏡頭拍不到人時，原本會永遠停在「找你」——
         沒有超時、沒有提示、沒有出路，這是新使用者最容易放棄的地方。
         分兩段給退路：先提示怎麼擺，再導向測試模式看骨架。 */
      const waited = ts - calib.enteredAt;
      if(waited > GIVEUP_MS){
        $('subSay').textContent = '還是找不到你。到測試模式看看骨架有沒有抓到';
      }else if(waited > HINT_MS){
        $('subSay').textContent = '手機要能拍到你的頭和肩膀';
        $('flipCam').textContent = getFront() ? '換成後鏡頭' : '換成前鏡頭';
        $('flipCam').hidden = false;
      }
    }
    return;
  }

  const el = ts-calib.t0;
  if(el < SETTLE_MS){          // 擺姿勢，不取樣
    setRing(el/SETTLE_MS);
    return;
  }
  if(!calib.holding){          // 開始取樣
    calib.holding = true; sfx.tick(); setRing(0);
    setRingStroke('var(--cool)');
    $('subSay').textContent = '撐住';
    /* 掃描線快掃 —— 讓「緩衝期」與「取樣期」在視覺上明確分開。
       趴著看的時候光靠環的顏色差別分不出來。 */
    setScan('fast');
  }
  const p = Math.min(1, (el-SETTLE_MS)/HOLD_MS);
  setRing(p);
  if(lm) collect(lm);
  if(p>=1){
    setScan('off');
    if(calib.step===1){ calib.step=2; calib.t0=ts; calibPrompt(2); }
    else { sfx.ready(); finishCalibration(); }
  }
}
