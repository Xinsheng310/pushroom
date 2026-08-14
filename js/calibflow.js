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
  setRingBreath,
} from './ui.js';

/** 找不到人多久之後開始給退路（毫秒） */
const HINT_MS = 8000;
const GIVEUP_MS = 20000;
/** 判定「確實看到人了」需要連續多久 */
const SEEN_MS = 700;

/* ============ 就位閘門 ============

   真實使用者回饋：他拿著手機按下開始，鏡頭拍到他的臉，
   700ms 後就開始跑那 4 秒的固定計時 —— 而他這時還在走去地上、擺手機。
   結果兩個步驟取樣到的都是「站著移動中」的畫面，基準完全錯，
   開始計時後一下都算不到。

   根因是 step 0 的條件語意錯了：`bodyFound` 的意思是「鏡頭裡有個人」，
   不是「他就位了」。手持手機時前者永遠成立。

   改成等「他不動了」才開始取樣。手持時肩寬一直在變，過不了這關；
   放下手機趴好之後才會靜下來。 */

/** 要連續靜止多久才算就位 */
const STILL_MS = 1500;
/** 滾動視窗長度 —— 只看最近這段時間的變化 */
const STILL_WIN = 900;
/** 視窗內的相對變化容許值。用相對而非絕對：
    手機放遠時肩寬的絕對值小，固定閾值會讓遠距離使用者永遠「靜止」。 */
const STILL_TOL = 0.06;
/** 等太久就放行。沒有出路的閘門比沒有閘門更糟 ——
    有些人天生會抖，或某個訊號一直讀不到，不能讓他卡死在這裡。 */
const STILL_GIVEUP_MS = 12000;
/** 「你動了」的提示音節流，避免連環叫 */
const NUDGE_GAP_MS = 1200;

/* 環形緩衝：固定容量，不用 shift() —— 那會每幀產生 GC 壓力。
   900ms 視窗在 30fps 下約 27 筆，64 格綽綽有餘。 */
const STILL_CAP = 64;
const stillT = new Float32Array(STILL_CAP);
const stillV = new Float32Array(STILL_CAP);
let stillN = 0, stillHead = 0;

function stillReset(){ stillN = 0; stillHead = 0; }

/**
 * 判斷最近 STILL_WIN 毫秒內人有沒有在動。
 *
 * 訊號選擇：肩寬對「距離變化」最敏感（走過去、趴下都會劇烈變動），
 * 趴定後極穩。讀不到就退而用肩膀高度（站 vs 趴差距最大）。
 * 不用臉部距離（趴著臉可能側著看不到）也不用手肘角度
 * （角度與距離的值域混在一起，難定同一個閾值）。
 *
 * @returns {{still:boolean, ratio:number}} ratio 是視窗內的相對變化量
 */
function stillness(lm, ts){
  const v = SIGNALS.shoulders.get(lm) ?? SIGNALS.height.get(lm);
  if(v == null){ stillReset(); return { still:false, ratio:1 }; }

  stillT[stillHead] = ts; stillV[stillHead] = v;
  stillHead = (stillHead + 1) % STILL_CAP;
  if(stillN < STILL_CAP) stillN++;

  let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
  for(let i=0;i<stillN;i++){
    const idx = (stillHead - 1 - i + STILL_CAP) % STILL_CAP;
    if(ts - stillT[idx] > STILL_WIN) break;      // 只看視窗內
    const x = stillV[idx];
    if(x < mn) mn = x;
    if(x > mx) mx = x;
    sum += x; n++;
  }
  /* 樣本太少還不能下判斷（剛進畫面） */
  if(n < 6) return { still:false, ratio:1 };
  const ratio = (mx - mn) / (sum/n + 1e-6);
  return { still: ratio < STILL_TOL, ratio };
}

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
           enteredAt: performance.now(),    // 用來算「找不到人」多久了
           readyAt:0,                       // 進入就位階段的時刻
           stillFrom:0,                     // 從什麼時候開始靜止
           lastNudge:0};                    // 上次「你動了」提示音
  stillReset();
  setRingBreath(false);
  $('say').classList.remove('big');
  $('flipCam').hidden = true;
  showRing(false);
  $('forceUse').style.display = 'none';
  $('cancelSetup').textContent = '取消';
  $('stepLabel').textContent = 'STEP 1 / 3';
  $('say').textContent = '找你';
  $('subSay').textContent = '上半身進入畫面';
  show('setup');
}

/* 就位階段的畫面。這是全流程唯一需要「趴在地上、離手機 40 公分」
   還讀得到的字，所以用最大字級。副標仍是給站著的人看的。 */
function enterReady(){
  showRing(true);
  setRingStroke('rgba(255,255,255,.28)');
  setRing(0);
  setRingBreath(true);
  $('say').classList.add('big');
  $('say').textContent = '不要動';
  $('subSay').textContent = '手機放好、趴好，撐住就會開始';
  sfx.ready();
}

/** 就位完成 → 進第一個取樣步驟 */
function leaveReady(ts){
  setRingBreath(false);
  $('say').classList.remove('big');
  calib.step = 1;
  calib.t0 = ts;
  calibPrompt(1);
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

/**
 * 把校正結果翻譯成「他該改什麼」。
 *
 * 原本失敗只說「校正未通過」+ 一張分數表 —— 那是除錯介面，
 * 使用者趴在地上既看不到也看不懂，更不知道下次要改什麼。
 * 第一行必須是動作指示，不是狀態描述。
 *
 * @param {Array} report scoreCalibration 的結果
 * @param {object|null} best
 * @returns {{say:string, hint:string}}
 */
export function diagnose(report, best){
  const usable = report.filter(r => r.score != null);

  /* 四個訊號全都讀不到 —— 鏡頭根本沒拍到該拍的部位 */
  if(!usable.length){
    return { say:'鏡頭沒拍到你',
             hint:'手機要能拍到肩膀。往後挪一點，或換另一個鏡頭' };
  }

  /* 兩次姿勢的數值幾乎一樣 = 他根本沒做出兩個不同的動作。
     這正是「還沒趴好就開始取樣」會produce的結果。 */
  const spread = best ? Math.abs(best.up - best.down) : 0;
  const rel = best ? spread / (Math.abs(best.up) + 1e-6) : 0;
  if(rel < 0.08){
    return { say:'兩次姿勢一樣',
             hint:'校正時可能還沒趴好。先趴好、手機放定，再重新校正' };
  }

  /* 上下差得出來但分數不夠 → 是抖動吃掉了差距 */
  return { say:'撐住的時候在晃',
           hint:'聽到嗶聲後那兩秒把肩膀鎖死，不要動' };
}

function finishCalibration(){
  const {report, best} = scoreCalibration(calib.samples);
  log('校正結果 '+report.map(r=>r.k+'='+(r.score==null?'無資料':r.score.toFixed(1))).join('  '));

  if(best && best.score>=PASS){ onApply?.(best); return; }

  showRing(false);
  setRingBreath(false);
  $('say').classList.remove('big');
  const d = diagnose(report, best);
  $('say').textContent = d.say;
  renderCalibReport(report, best, SIGNALS, PASS, d.hint);
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
        /* 看到人了，但還不能開始取樣 —— 他可能還拿著手機。
           進入就位階段，等他放好手機、趴定、不動。 */
        calib.step = 0.5;
        calib.readyAt = ts;
        stillReset();
        $('flipCam').hidden = true;
        enterReady();
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

  /* ---- 就位：等他不動 ---- */
  if(calib.step===0.5){
    /* 人走出畫面（去放手機）就退回找人，並清掉累積的靜止判斷。
       這順便解決了原始的 bug：手持手機時就算僥倖過了關，
       放下手機的瞬間 bodyFound 中斷會把它打回去。 */
    if(!bodyFound(lm)){
      calib.step = 0; calib.seenAt = 0;
      stillReset();
      showRing(false);
      $('say').classList.remove('big');
      $('say').textContent = '找你';
      $('subSay').textContent = '上半身進入畫面';
      return;
    }

    const { still } = stillness(lm, ts);
    if(still){
      if(!calib.stillFrom) calib.stillFrom = ts;
      setRing(Math.min(1, (ts-calib.stillFrom)/STILL_MS));
      if(ts-calib.stillFrom >= STILL_MS){ leaveReady(ts); return; }
    }else{
      /* 一動就歸零。這個「歸零」是整個設計的靈魂 ——
         它把抽象的「你動了」翻成看得見的結果，不用一個字說明。 */
      if(calib.stillFrom){
        calib.stillFrom = 0;
        setRing(0);
        if(ts - calib.lastNudge > NUDGE_GAP_MS){
          calib.lastNudge = ts;
          sfx.warn();
        }
      }
    }

    /* 等太久就放行 —— 有些人天生會抖，不能讓他卡在這裡 */
    if(ts-calib.readyAt > STILL_GIVEUP_MS){
      $('subSay').textContent = '開始了，撐直手臂';
      leaveReady(ts);
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
