/* 省電 — 螢幕恆亮與「頁面進背景時的相機處理」

   問題：把網頁縮小但沒關掉時，姿勢推論雖然已經停了（見 main.js 的 INFER_PHASES），
   但「相機硬體」還在持續曝光供幀 —— 那是實實在在的耗電與發熱。

   策略分三層：
     1. 進背景 → 立刻停止供幀（track.enabled=false）。
        恢復是即時的，不需重新授權、不需等曝光收斂。
     2. 背景超過 30 秒 → 完整釋放相機（track.stop()）。
        代價是回來要重開，iOS 可能重新要求授權、曝光收斂 0.5–2 秒。
     3. 比賽進行中 → 兩層都豁免，什麼都不動。

   為什麼比賽中要完全豁免：手機躺在地上、使用者趴著做。
   若切個通知回來相機要重啟 2 秒，那幾下就漏算了 ——
   規格第 6.4 節說背景/來電/通知是常態，計數準確度優先於省電。 */

import { log } from './log.js';
import { openCamera, setCameraPaused, releaseCamera } from './pose.js';
import { humStop } from './audio.js';
import { S } from './detect.js';

/** 背景多久之後才真的釋放相機 */
const CAM_RELEASE_MS = 30000;
/** 這些相位代表「正在比賽或準備比賽」，一律不動相機 */
const CAM_KEEP_PHASES = new Set(['calib','countdown','run','vsrun']);
/** 這些相位需要螢幕保持亮著 */
const WAKE_PHASES = new Set(['run','vsrun']);

const matchInProgress = ()=> CAM_KEEP_PHASES.has(S.phase);

/* ============ 螢幕恆亮 ============ */
let wl = null;
export async function requestWakeLock(){
  try{ wl = await navigator.wakeLock?.request('screen'); }catch(e){}
}
export function releaseWakeLock(){
  try{ wl?.release(); }catch(e){}
  wl = null;
}
/** 測試模式的診斷表要顯示目前有沒有鎖住螢幕 */
export const wakeLockHeld = ()=> !!wl;

/* ============ 前景／背景 ============ */
let camReleaseTimer = null;
let camWasReleased = false;

/**
 * 安裝 visibilitychange 處理。
 * @param {{front:boolean}} cfg
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} skel
 * @param {()=>boolean} needsCamera 回到前景時是否該把相機重新開起來
 */
export function installPowerHandlers(cfg, video, skel, needsCamera){
  function onHidden(){
    if(matchInProgress()){
      log('進背景但比賽中，相機保持開啟');
      return;
    }
    /* 嗡鳴的 oscillator 不會自己停，切走前要收乾 */
    humStop();
    setCameraPaused(true);
    clearTimeout(camReleaseTimer);
    camReleaseTimer = setTimeout(()=>{
      /* 30 秒後才真的釋放。再確認一次相位 —— 這段時間內使用者
         可能已經回來並開始比賽（雖然那時 onVisible 已經清掉 timer）。 */
      if(matchInProgress()) return;
      if(releaseCamera()) camWasReleased = true;
    }, CAM_RELEASE_MS);
  }

  async function onVisible(){
    clearTimeout(camReleaseTimer); camReleaseTimer = null;
    if(WAKE_PHASES.has(S.phase)) requestWakeLock();

    if(camWasReleased){
      camWasReleased = false;
      /* 只有真的需要相機的畫面才重開，回首頁不用急著開 */
      if(needsCamera()){
        log('重新開啟相機…');
        await openCamera(cfg, video, skel);
      }
      return;
    }
    setCameraPaused(false);
  }

  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible') onVisible();
    else onHidden();
  });
}
