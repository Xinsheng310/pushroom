/* 主流程 — 設定、主迴圈、校正流程、倒數、結算、測試模式、導覽 */

import { log, showErr, installGlobalHandlers } from './log.js';
import { audioOn, audioState, sfx, humStart, humSet, humStop } from './audio.js';
import {
  openCamera, loadModel, getStream, getLandmarker, getModelStatus, drawSkeleton,
  setCameraPaused, releaseCamera, isCameraLive,
} from './pose.js';
import {
  SIGNALS, bodyFound, setAspect, SETTLE_MS, HOLD_MS, PASS,
  scoreCalibration, TH, S, track, resetCounter,
} from './detect.js';
import {
  $, panels, show, isLabOpen, fmt, setRing, setRingStroke, showRing,
  renderCalibReport, addTick, clearTicks, pulse, drawChart,
  renderChecks, renderSignalRows, updateSignalRow, renderMatchList,
  showCountdown, clearCountdown, flash, rollNumber, replay, setGaugeMarks, setScan,
} from './ui.js';
import { initFirebase, isReady } from './firebase.js';
import {
  watchAuth, onAuthChange, signIn, signOut, setDisplayName,
  validName, usingDefaultName, addSession, getProfile, getUser, NAME_MAX,
} from './auth.js';
import { listMyMatches, outcomeFor } from './matches.js';
import {
  initLobbyUI, openLobby, installVersusHooks, isVersusActive,
  autoJoinFromUrl, flushPendingJoin, refreshWaitRoom,
} from './versus.js';
import {
  loadCalib, saveCalib, clearCalib, isStale, matchesCamera, describeAge,
} from './calibstore.js';
import { perfInfer, perfFrame, perfGap, perfReset, perfLine } from './perf.js';

installGlobalHandlers();

const video = $('cam'), skel = $('skeleton'), sctx = skel.getContext('2d');

/* ============ 設定 ============ */
const cfg = { seconds:60, front:true, skeleton:true };

$('durations').addEventListener('click', e=>{
  const b = e.target.closest('.chip'); if(!b) return;
  [...$('durations').children].forEach(c=>c.setAttribute('aria-checked', c===b));
  cfg.seconds = +b.dataset.sec;
});
const bindSwitch = (el,key,after) => el.addEventListener('click',()=>{
  cfg[key] = !cfg[key]; el.setAttribute('aria-checked', cfg[key]);
  updateCamSummary();          // 摺疊列的摘要要跟著走
  after && after();
});
bindSwitch($('swCam'), 'front', ()=>{
  /* 只有相機已經開著才重開（換鏡頭）。
     若還沒開過就不要在這裡開 —— 使用者可能只是在首頁調設定，
     不該因為切個開關就啟動相機。 */
  if(getStream()) openCamera(cfg, video, skel);
  /* 換鏡頭後基準完全不同（畫面鏡像、拍攝距離都變了），
     舊校正不能用，清掉並提示重新校正。 */
  if(S.key){
    S.key = null; S.ema = null;
    $('metaSignal').textContent = '—';
    log('已換鏡頭，需重新校正');
  }
  updateCalibChip();
});
bindSwitch($('swSkel'), 'skeleton', ()=>{
  if(!cfg.skeleton) sctx.clearRect(0,0,skel.width,skel.height);
});

/* ============ 模型 ============ */
/* 狀態列取代「載入模型中…」的按鈕文字。
   讓一個 disabled 的灰按鈕去播報系統狀態，等於把橘色 CTA 當載入指示器，
   違反「橘 = 唯一注意力焦點」。改成上方的 mono 狀態列播報，
   按鈕文字始終是「開始」—— 橘色亮起本身就是開機完成的訊號。 */
function setSysState(state, text){
  const el = $('sysLine');
  el.classList.remove('loading','ready','failed');
  el.classList.add(state);
  $('sysText').textContent = text;
}
setSysState('loading', 'MODEL · LOADING');

loadModel(ok=>{
  $('start').disabled = !ok;
  setSysState(ok?'ready':'failed', ok? 'MODEL · READY' : 'MODEL · FAILED');
  /* 模型載完是靜默變色的，使用者可能正盯著別處。給一次解鎖提示。 */
  if(ok) replay($('start'), 'unlocked');
});

/* 鏡頭設定摺疊。摘要文字要跟著開關走，收起來時才知道目前是什麼設定。 */
function updateCamSummary(){
  $('camSetSum').textContent =
    (cfg.front ? '前鏡頭' : '後鏡頭') + ' · ' + (cfg.skeleton ? '骨架開' : '骨架關');
}
$('camSetBtn').addEventListener('click', ()=>{
  const open = $('camSetBtn').getAttribute('aria-expanded') === 'true';
  $('camSetBtn').setAttribute('aria-expanded', String(!open));
  $('camSetBody').hidden = open;
});

/* ============ 主迴圈 ============

   姿勢推論是整個 App 最耗電的部分（中階 Android 每次 12–22ms 的 GPU 滿載）。
   這裡有兩道閘門，缺一不可：

   1. 只在需要計數的相位推論。
      規格第 7 節：「非偵測時段相機推論應完全關閉，GPU 全給動畫」。
      首頁、大廳、等待室、結算都不需要知道你的姿勢。

   2. 同一個 video frame 只推論一次。
      相機給 30fps 但螢幕是 60Hz，rAF 會跑 60 次 —— 一半是重複影格。
      原本寫 `ts===lastTs` 想去重，但 performance.now() 每次都不同，
      那個判斷永遠不成立，等於一半的推論是純浪費。
      改用 video.currentTime 判斷是否為新影格。

   刻意不做的事：不 close() landmarker、不 stop() video track。
   重建 landmarker 要重編 GPU shader，冷啟 300–900ms；
   重開相機在 iOS 要重新授權且曝光收斂要 0.5–2 秒。
   兩者都會讓「倒數結束的第一下」漏算。保留實例、只停止呼叫它。 */

/** 需要姿勢推論的相位。
    倒數（countdown）也要推論 —— 不是為了計數，是為了「暖機」：
    從暫停切回推論時第一次 detectForVideo 會慢 2–3 倍（GPU texture 重新配置），
    若在 GO 的瞬間才恢復，第一下很可能漏算。倒數 3 秒剛好夠熱起來。 */
const INFER_PHASES = new Set(['calib','countdown','run','vsrun','lab']);

let lastFrameTime = -1;    // 上次推論的 video.currentTime
let skelCleared = false;

function needsInference(){
  return INFER_PHASES.has(S.phase) || isLabOpen();
}

function loop(){
  requestAnimationFrame(loop);
  const landmarker = getLandmarker();
  if(!landmarker || video.readyState<2) return;

  if(!needsInference()){
    /* 不推論。順手清掉骨架，否則畫面會留著最後一幀的殘影。 */
    if(!skelCleared && skel.width){
      sctx.clearRect(0,0,skel.width,skel.height);
      skelCleared = true;
      perfGap();          // 暫停期間不要被算成一個超長幀
    }
    return;
  }
  if(skelCleared){ skelCleared = false; perfGap(); }

  /* 同一影格不重複推論。currentTime 只在相機給新影格時前進。 */
  const ft = video.currentTime;
  if(ft === lastFrameTime) return;
  lastFrameTime = ft;

  const ts = performance.now();
  const t0 = ts;
  let res; try{ res = landmarker.detectForVideo(video, ts); }catch(e){ return; }
  perfInfer(performance.now() - t0);

  const lm = res?.landmarks?.[0];
  setAspect(video.videoWidth/video.videoHeight);

  if(cfg.skeleton) drawSkeleton(sctx, skel, video, lm, S.depth);
  else if(skel.width) sctx.clearRect(0,0,skel.width,skel.height);

  onFrame(lm ?? null, ts);
  perfFrame(ts);
}

/* ============ 校正 ============ */
let calib = {step:0, t0:0, samples:{}, seenAt:0, holding:false};
let calibReturn = 'run';
/* 對戰校正完成後要回呼給 versus.js（宣告在這裡，避免 TDZ） */
let vsCalibDone = null;
/* 使用者自己在測試模式調的門檻。對戰會暫時套用統一門檻，結束後還原，
   否則單機練習會莫名沿用上一場對戰的標準。 */
const myTh = { ...TH };

function beginCalibration(){
  S.phase = 'calib';
  calib = {step:0, t0:0, samples:{}, seenAt:0, holding:false};
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

  if(best && best.score>=PASS){ applyCalib(best); return; }

  showRing(false);
  $('say').textContent = '校正未通過';
  renderCalibReport(report, best, SIGNALS, PASS);
  $('forceUse').style.display = best? 'block' : 'none';
  $('forceUse').onclick = ()=>{ log('使用者強制採用 '+best.key); applyCalib(best); };
  $('cancelSetup').textContent = '重新校正';
  S.phase = 'idle';
  sfx.warn();
}

function applyCalib(best){
  S.key = best.key; S.up = best.up; S.down = best.down; S.ema = null;
  $('metaSignal').textContent = SIGNALS[best.key].label;
  $('forceUse').style.display = 'none';
  log('採用 '+SIGNALS[best.key].label+'  上='+best.up.toFixed(1)+' 下='+best.down.toFixed(1)+' 分數='+best.score.toFixed(1));
  /* 存起來下次自動帶入。門檻存「使用者自己的」而非當下的 TH ——
     對戰可能把 TH 暫時改成標準/寬鬆，那不該被記成他的偏好。 */
  saveCalib({
    key:best.key, up:best.up, down:best.down, score:best.score,
    thDown:myTh.down, thUp:myTh.up, front:cfg.front,
  });
  updateCalibChip();
  if(calibReturn==='lab'){
    S.phase = 'lab';
    resetCounter(); S.startAt = performance.now();
    $('labCount').textContent = '0';
    show('lab');
    return;
  }
  if(calibReturn==='versus'){
    /* 對戰：校正完回等待室。校正是本機事件，要主動叫等待室重畫，
       否則「已校正」狀態不會更新。 */
    S.phase = 'idle';
    show('wait');
    refreshWaitRoom();
    const done = vsCalibDone; vsCalibDone = null;
    done?.();
    return;
  }
  startCountdown();
}

/* ============ 倒數 → 開始 ============ */
let cdTimer = null;
function startCountdown(){
  S.phase = 'countdown';
  showRing(false);
  $('stepLabel').textContent = '';
  $('subSay').textContent = '回到起始姿勢';
  let n = 3;
  const tick = ()=>{
    if(n<0){ clearInterval(cdTimer); clearCountdown(); beginRun(); return; }
    showCountdown(n>0 ? n : 'GO');
    n>0 ? sfx.tick() : sfx.go();
    if(n===0) flash(.28);
    n--;
  };
  tick(); cdTimer = setInterval(tick, 1000);
}

function beginRun(){
  /* 還原自己的門檻 —— 上一場對戰可能把它改成標準/寬鬆 */
  TH.down = myTh.down; TH.up = myTh.up;
  S.phase = 'run';
  resetCounter();
  S.startAt = performance.now();
  S.endAt = cfg.seconds? S.startAt+cfg.seconds*1000 : 0;
  $('count').textContent = '0';
  clearTicks();
  $('clock').classList.remove('warn');
  setGaugeMarks(TH);
  show('run');
  requestWakeLock();
}

/* ============ 對戰模式 ============
   與單機 run 共用 track()，計數行為必然一致；
   差別只在計時來源（伺服器對齊的 timer）與每下要回報給對手。 */
const vsRun = { timer:null, durationSec:60, onRep:null, onEnd:null, warned:false };

function beginVsRun(timer, durationSec, onRep, onEnd, manual=false){
  vsRun.timer = timer;
  vsRun.durationSec = durationSec;
  vsRun.onRep = onRep;
  vsRun.onEnd = onEnd;
  vsRun.warned = false;
  vsRun.manual = manual;
  S.phase = 'vsrun';
  resetCounter();
  S.startAt = performance.now();
  $('count').textContent = '0';
  clearTicks();
  $('clock').classList.remove('warn');
  setGaugeMarks(TH);
  /* 手動計數的兩種介面，取捨如下：
       沒校正（例如用電腦當房主）→ 鋪滿中段的大點擊區，因為那是唯一的計數方式
       已校正 → 只給左下角一顆小 +1，當相機實際拍不到時的退路
     不給已校正的人鋪大點擊區，是因為做伏地挺身時手掌誤觸會加出假次數，
     而計數準確是這個 App 的全部意義。 */
  $('status').textContent = manual ? '空白鍵或點畫面計數' : '下到底 → 撐起來';
  $('tapCount').hidden = !manual;
  $('manualBtn').hidden = manual;
  show('run');
  requestWakeLock();
  humStart();
  startVsClock();
}

/* 對戰時鐘用獨立的 interval 驅動，不依賴相機影格。
   原本時鐘寫在 onFrame 裡，而 onFrame 只有在 video.readyState>=2 時才會被呼叫 ——
   相機拿不到影像（例如用電腦當房主）時整個倒數就完全不動，
   時間到也不會結算。時鐘是比賽的骨幹，不該綁在相機上。 */
let vsClockTimer = null;
function startVsClock(){
  stopVsClock();
  /* durationSec 0 = 無限賽制：改成正計時，由任一方長按中止結束。
     不能直接算 remainingTo(0)，那會立刻變負數而秒結束。 */
  const unlimited = !vsRun.durationSec;
  const tick = ()=>{
    if(S.phase!=='vsrun'){ stopVsClock(); return; }
    if(unlimited){
      $('clock').textContent = fmt(vsRun.timer.elapsed());
      return;
    }
    const left = vsRun.timer.remainingTo(vsRun.durationSec*1000);
    $('clock').textContent = fmt(Math.max(0,left));
    if(left<=10000){
      $('clock').classList.add('warn');
      if(!vsRun.warned){ vsRun.warned = true; sfx.warn(); }
    }
    if(left<=0){
      stopVsClock();
      S.phase = 'done'; releaseWakeLock();
      vsRun.onEnd?.(S.reps);
    }
  };
  tick();
  vsClockTimer = setInterval(tick, 100);
}
function stopVsClock(){
  if(vsClockTimer){ clearInterval(vsClockTimer); vsClockTimer = null; }
  $('tapCount').hidden = true;
  $('manualBtn').hidden = true;
  humStop();
}

function abortVsRun(){
  stopVsClock();
  if(S.phase==='vsrun'){ S.phase='idle'; releaseWakeLock(); }
}

/* ============ 每幀 ============ */
let warned10 = false;
function onFrame(lm, ts){
  fpsTick(ts);
  if(isLabOpen()) labUpdate(lm, ts);

  /* ---- 對戰中 ----
     時鐘與結算由 startVsClock() 的 interval 負責（不依賴相機影格），
     這裡只做「有影像時的自動計數」。 */
  if(S.phase==='vsrun'){
    const r = track(lm, ts);
    if(r===null){ $('status').textContent='看不到你'; return; }
    $('gaugeFill').style.transform = 'scaleY('+Math.min(1, S.depth)+')';
    humSet(S.depth);
    if(r==='down') $('status').textContent = '撐起來';
    if(r==='rep'){
      $('count').textContent = S.reps; pulse(); addTick(S.times);
      $('status').textContent = '';
      vsRun.onRep?.(S.reps);
    }
    return;
  }

  /* ---- 測試模式的自由計數 ---- */
  if(S.phase==='lab'){
    const r = track(lm, ts);
    $('labBar').style.width = Math.min(100, S.depth*100)+'%';
    $('labDepth').textContent = r===null? 'depth — （看不到你）' : 'depth '+S.depth.toFixed(2);
    $('labState').textContent = r===null? '找不到身體' : (S.repState==='down'?'下壓中':'頂點');
    if(r==='rep'){ $('labCount').textContent = S.reps; pulse(); log('計數 '+S.reps); }
    return;
  }

  /* ---- 校正流程 ---- */
  if(S.phase==='calib'){
    if(calib.step===0){
      if(bodyFound(lm)){
        if(!calib.seenAt) calib.seenAt = ts;
        if(ts-calib.seenAt>700){ calib.step=1; calib.t0=ts; calibPrompt(1); }
      } else calib.seenAt = 0;
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
    return;
  }

  /* ---- 計時中 ---- */
  if(S.phase!=='run') return;

  if(cfg.seconds){
    const left = Math.max(0, S.endAt-ts);
    $('clock').textContent = fmt(left);
    if(left<=10000){
      $('clock').classList.add('warn');
      if(!warned10){ warned10=true; sfx.warn(); }
    }
    if(left<=0){ finish(); return; }
  } else {
    $('clock').textContent = fmt(ts-S.startAt);
  }

  const r = track(lm, ts);
  if(r===null){ $('status').textContent='看不到你'; return; }
  $('gaugeFill').style.transform = 'scaleY('+Math.min(1, S.depth)+')';
  humSet(S.depth);
  if(r==='down') $('status').textContent = '撐起來';
  if(r==='rep'){
    $('count').textContent = S.reps; pulse(); addTick(S.times);
    $('status').textContent = '';
  }
}

/* ============ 結算 ============ */
function finish(){
  S.phase = 'done'; releaseWakeLock(); humStop(); sfx.end();
  const dur = cfg.seconds? cfg.seconds*1000 : (S.times.at(-1)||0);
  /* 總數從 0 滾上去，配漸快的音階 —— 單機模式唯一的獎賞時刻 */
  rollNumber('rTotal', S.reps, 720, n=>{ if(n % 2 === 0) sfx.rep(n||1); });
  $('rTime').textContent = fmt(dur);
  $('rPace').textContent = S.reps? (dur/1000/S.reps).toFixed(2) : '—';
  let fast = '—';
  if(S.times.length>1){
    let m = Infinity;
    for(let i=1;i<S.times.length;i++) m = Math.min(m, S.times[i]-S.times[i-1]);
    fast = (m/1000).toFixed(2)+'s';
  }
  $('rFast').textContent = fast;
  drawChart(S.times, dur);
  show('result');
  /* 已登入就累加個人戰績。失敗不影響結算畫面（auth.js 內部已吞掉錯誤）。 */
  addSession(S.reps);
}

/* ============ 螢幕恆亮 ============ */
let wl = null;
async function requestWakeLock(){ try{ wl = await navigator.wakeLock?.request('screen'); }catch(e){} }
function releaseWakeLock(){ try{ wl?.release(); }catch(e){} wl = null; }

/* ============ 省電：頁面進背景時的相機處理 ============

   問題：把網頁縮小但沒關掉時，姿勢推論雖然已經停了（見 INFER_PHASES），
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

const CAM_RELEASE_MS = 30000;
/* 這些相位代表「正在比賽或準備比賽」，一律不動相機 */
const CAM_KEEP_PHASES = new Set(['calib','countdown','run','vsrun']);
let camReleaseTimer = null;
let camWasReleased = false;

const matchInProgress = ()=> CAM_KEEP_PHASES.has(S.phase);

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
  if(S.phase==='run' || S.phase==='vsrun') requestWakeLock();

  if(camWasReleased){
    camWasReleased = false;
    /* 只有真的需要相機的畫面才重開，回首頁不用急著開 */
    if(needsInference() || isLabOpen()){
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

/* ============ 測試模式 ============ */
let fps=0, fpsN=0, fpsT=0;
function fpsTick(ts){ fpsN++; if(ts-fpsT>500){ fps=Math.round(fpsN*1000/(ts-fpsT)); fpsN=0; fpsT=ts; } }

function buildChecks(){
  const camTrack = getStream()?.getVideoTracks?.()[0];
  const landmarker = getLandmarker();
  const ast = audioState();
  return [
    ['安全來源 (https)', window.isSecureContext,
      window.isSecureContext? location.origin : '目前是 '+location.protocol+'  相機不會給權限'],
    ['相機 API', !!navigator.mediaDevices?.getUserMedia,
      navigator.mediaDevices?.getUserMedia? '可用':'瀏覽器不支援或非安全來源'],
    ['相機串流', !!camTrack && camTrack.readyState==='live',
      camTrack? (cfg.front?'前鏡頭':'後鏡頭')+'  '+video.videoWidth+'×'+video.videoHeight : '尚未取得'],
    ['姿勢模型', !!landmarker, getModelStatus()],
    ['音訊', ast==='running', ast || '尚未啟用（按任一按鈕即啟用）'],
    ['螢幕恆亮', !!wl, wl? '已鎖定' : (navigator.wakeLock? '執行時才啟用':'此瀏覽器不支援')],
  ];
}

function labUpdate(lm, ts){
  renderSignalRows(SIGNALS);
  for(const k in SIGNALS){
    updateSignalRow(k, lm? SIGNALS[k].get(lm) : null, S.key===k);
  }
  $('fpsNow').textContent = ' · '+fps+' fps';
  if(ts-(labUpdate.t||0)>800){
    labUpdate.t = ts;
    renderChecks(buildChecks());
    $('perfLine').textContent = perfLine();
  }
}

$('labBtn').addEventListener('click', async ()=>{
  audioOn();
  if(!getStream()) await openCamera(cfg, video, skel);
  renderChecks(buildChecks()); log('進入測試模式');
  if(S.key) S.phase = 'lab';
  show('lab');
});
$('labExit').addEventListener('click',()=>{ S.phase='idle'; show('home'); });
$('labCalib').addEventListener('click',()=>{ audioOn(); calibReturn='lab'; beginCalibration(); });
$('labReset').addEventListener('click',()=>{
  resetCounter(); $('labCount').textContent='0'; log('計數歸零');
});
$('perfResetBtn').addEventListener('click',()=>{
  perfReset(); $('perfLine').textContent = '尚未取樣'; log('效能統計歸零');
});

const bindTh = (id,lbl,key) => $(id).addEventListener('input', e=>{
  TH[key] = +e.target.value;
  myTh[key] = TH[key];          // 記住使用者的偏好，供對戰「自訂」模式使用
  $(lbl).textContent = TH[key].toFixed(2);
  setGaugeMarks(TH);
});
bindTh('thDown','vDown','down'); bindTh('thUp','vUp','up');

const placeMarks = ()=>{
  $('labDown').style.left = (TH.down*100)+'%';
  $('labUp').style.left = (TH.up*100)+'%';
};
$('thDown').addEventListener('input', placeMarks);
$('thUp').addEventListener('input', placeMarks);
placeMarks();

document.querySelectorAll('[data-sfx]').forEach(b=>b.addEventListener('click',()=>{
  audioOn();
  const k = b.dataset.sfx;
  k==='rep'? sfx.rep(1) : sfx[k]();
}));

/* ============ 首次使用提醒 ============
   規格第 8 節：顯示簡短運動免責提醒，並明確告知影像在本機處理。 */
const CONSENT_KEY = 'pushroom.consent.v1';
/* 改名前的 key。已經看過提醒的人不該因為改名而再看一次。 */
const CONSENT_LEGACY = 'reproom.consent.v1';
const consented = ()=>{
  try{
    if(localStorage.getItem(CONSENT_KEY)==='1') return true;
    if(localStorage.getItem(CONSENT_LEGACY)==='1'){
      localStorage.setItem(CONSENT_KEY,'1');
      localStorage.removeItem(CONSENT_LEGACY);
      return true;
    }
    return false;
  }catch(e){ return false; }
};
const setConsented = ()=>{ try{ localStorage.setItem(CONSENT_KEY,'1'); }catch(e){} };

/* 同意後要接著做的事（例如「按了開始但還沒同意」→ 同意完直接開始） */
let afterConsent = null;
function requireConsent(next){
  if(consented()){ next(); return; }
  afterConsent = next;
  show('consent');
}
$('consentOk').addEventListener('click', ()=>{
  audioOn(); setConsented();
  const next = afterConsent; afterConsent = null;
  next ? next() : show('home');
});

/* ============ 帳號 UI ============ */
function renderAccount(user, prof){
  const signedIn = !!user;
  /* 未登入時整塊隱藏 —— 登入的動機由「跟朋友對戰」那顆按鈕承擔，
     首頁不需要兩個各自解釋一次的登入提示。
     Firebase 沒就緒（設定未填 / CDN 掛）時同樣隱藏，維持純單機體驗。 */
  $('account').hidden = !(isReady() && signedIn);
  $('acctIn').hidden  = !signedIn;
  /* 對戰入口一律顯示，即使沒登入。
     原本未登入就 hidden，等於新使用者從頭到尾看不到「可以跟朋友對戰」——
     而那正是這個 App 跟其他計數器的唯一差別。
     改成：未登入時按下去先登入，成功後直接進大廳。
     動機在正確的時機出現（為了對戰而登入，不是為了登入而登入）。 */
  $('versusBtn').hidden = !isReady();
  $('versusHint').hidden = signedIn;
  if(signedIn && prof){
    $('acctName').textContent = prof.displayName;
    const s = prof.stats || {};
    $('acctStats').textContent =
      `累計 ${s.totalReps ?? 0} 下 · 最佳 ${s.bestSession ?? 0} 下 · ${s.wins ?? 0}勝${s.losses ?? 0}敗`;
  }
}
onAuthChange(renderAccount);

$('signOut').addEventListener('click', async ()=>{
  audioOn();
  try{ await signOut(); }catch(e){ showErr('登出失敗：'+(e.message||e)); }
});

/* ============ 戰績 ============ */
function relTime(ts){
  if(!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const min = Math.floor((Date.now() - d.getTime())/60000);
  if(min < 1) return '剛剛';
  if(min < 60) return min+' 分鐘前';
  const hr = Math.floor(min/60);
  if(hr < 24) return hr+' 小時前';
  const day = Math.floor(hr/24);
  if(day < 30) return day+' 天前';
  return `${d.getMonth()+1}/${d.getDate()}`;
}

$('historyBtn').addEventListener('click', async ()=>{
  audioOn();
  const u = getUser(), p = getProfile();
  if(!u) return;
  const s = p?.stats || {};
  $('hStatsLine').textContent = `${s.wins ?? 0}勝 ${s.losses ?? 0}敗 ${s.draws ?? 0}平`;
  $('hTotal').textContent = s.totalReps ?? 0;
  $('hBest').textContent = s.bestSession ?? 0;
  $('hMatches').textContent = s.matches ?? 0;
  renderMatchList([]);
  $('matchHint').textContent = '載入中…';
  show('history');

  const list = await listMyMatches(u.uid, 20);
  if(!list.length){
    $('matchHint').textContent = '還沒有對戰紀錄。跟朋友開一間房就有了。';
    return;
  }
  renderMatchList(list.map(m=>{
    const iAmA = m.a?.uid === u.uid;
    const me = iAmA ? m.a : m.b, op = iAmA ? m.b : m.a;
    return {
      verdict: outcomeFor(u.uid, m),
      opName: op?.name,
      myReps: me?.reps ?? 0,
      opReps: op?.reps ?? 0,
      when: relTime(m.playedAt),
      durationSec: m.durationSec,
    };
  }));
  $('matchHint').textContent = '';
});
$('historyClose').addEventListener('click', ()=> show('home'));

/* ============ 暱稱設定 ============ */
function openNamePanel(){
  const prof = getProfile();
  $('nameInput').value = usingDefaultName() ? '' : (prof?.displayName || '');
  $('nameErr').hidden = true;
  show('name');
  setTimeout(()=>$('nameInput').focus(), 60);
}
$('editName').addEventListener('click', ()=>{ audioOn(); openNamePanel(); });
$('nameCancel').addEventListener('click', ()=> show('home'));

async function saveName(){
  const v = $('nameInput').value;
  if(!validName(v)){
    $('nameErr').textContent = `暱稱要 1 到 ${NAME_MAX} 個字`;
    $('nameErr').hidden = false;
    return;
  }
  $('nameSave').disabled = true;
  try{
    await setDisplayName(v);
    show('home');
  }catch(e){
    $('nameErr').textContent = (e.message||e).toString();
    $('nameErr').hidden = false;
  }finally{
    $('nameSave').disabled = false;
  }
}
$('nameSave').addEventListener('click', ()=>{ audioOn(); saveName(); });
$('nameInput').addEventListener('keydown', e=>{ if(e.key==='Enter') saveName(); });

/* ============ 導覽 ============ */
$('start').addEventListener('click', ()=>{
  audioOn();
  requireConsent(async ()=>{
    if(!getStream()) await openCamera(cfg, video, skel);
    /* 相機開不起來就回首頁，不要把人留在同意頁動彈不得
       （錯誤原因由 openCamera 顯示在紅色橫幅） */
    if(!getStream()){ show('home'); return; }
    warned10 = false; calibReturn = 'run';
    $('cancelSetup').textContent = '取消';
    /* 已經有可用的校正就直接倒數 —— 首頁的 calibChip 明白寫著
       「按開始會直接計時，不用再校正」，若這裡仍跑一次完整校正
       （8.7 秒）就是介面在說謊，而且是回訪者每次都要付的代價。
       要重校的人按 calibChip 的「清除」即可。 */
    if(S.key){ startCountdown(); return; }
    beginCalibration();
  });
});
$('cancelSetup').addEventListener('click',()=>{
  if(S.phase==='idle' && calibReturn!=='versus'){ beginCalibration(); return; }  // 「重新校正」
  S.phase = 'idle'; clearInterval(cdTimer);
  if(calibReturn==='versus'){
    /* 取消對戰校正 → 回等待室，並丟掉未完成的回呼，
       否則房主會卡在「先做一次校正…」永遠等不到 */
    vsCalibDone = null;
    $('goMatch').disabled = false;
    $('waitNote').textContent = '';
    show('wait');
    return;
  }
  show(calibReturn==='lab'?'lab':'home');
});
/* 中止要長按 450ms。單按不會中止 —— 使用者趴著、手掌可能掃到螢幕，
   而它旁邊就是手動計數鈕。誤觸中止會毀掉整場，多花半秒換掉這個風險。 */
const ABORT_HOLD_MS = 450;
let abortTimer = null;
const abortBtn = $('abort');

function abortHoldStart(e){
  if(S.phase!=='run' && S.phase!=='vsrun') return;
  e.preventDefault();
  abortBtn.classList.add('holding');
  clearTimeout(abortTimer);
  abortTimer = setTimeout(()=>{
    abortBtn.classList.remove('holding');
    if(S.phase==='run') finish();
    else if(S.phase==='vsrun'){ vsRun.onEnd?.(S.reps); stopVsClock(); S.phase='done'; }
  }, ABORT_HOLD_MS);
}
function abortHoldEnd(){
  clearTimeout(abortTimer); abortTimer = null;
  abortBtn.classList.remove('holding');
}
abortBtn.addEventListener('pointerdown', abortHoldStart);
abortBtn.addEventListener('pointerup', abortHoldEnd);
abortBtn.addEventListener('pointercancel', abortHoldEnd);
abortBtn.addEventListener('pointerleave', abortHoldEnd);
/* 提示使用者要長按，否則他會以為按鈕壞了 */
abortBtn.title = '長按結束';
$('again').addEventListener('click',()=>{ warned10=false; startCountdown(); show('setup'); });
$('home2').addEventListener('click',()=>{ S.phase='idle'; show('home'); });

setInterval(()=>{
  if(isLabOpen() && !getLandmarker()) renderChecks(buildChecks());
}, 1000);

/* ============ 校正存檔 ============ */
/**
 * 啟動時把存檔帶回 S。基準是裝置相依的，所以換鏡頭的存檔不能用。
 * 過期（超過一天）仍然帶入 —— 不準也比完全不能用好，
 * 但會在首頁提示，讓使用者自己決定要不要重校。
 */
function restoreCalib(){
  const c = loadCalib();
  if(!c) return false;
  if(!matchesCamera(c, cfg.front)){
    log('存檔是'+(c.front?'前':'後')+'鏡頭的，與目前設定不符，需重新校正');
    updateCalibChip();
    return false;
  }
  S.key = c.key; S.up = c.up; S.down = c.down; S.ema = null;
  myTh.down = c.thDown; myTh.up = c.thUp;
  TH.down = c.thDown;   TH.up = c.thUp;
  $('vDown').textContent = TH.down.toFixed(2);
  $('vUp').textContent   = TH.up.toFixed(2);
  $('thDown').value = TH.down;
  $('thUp').value   = TH.up;
  setGaugeMarks(TH);
  $('metaSignal').textContent = SIGNALS[c.key]?.label || c.key;
  log('沿用存檔校正：'+(SIGNALS[c.key]?.label||c.key)+'  '+describeAge(c));
  updateCalibChip();
  return true;
}

/** 首頁顯示校正狀態，讓使用者知道「這次不用再校正」或「該重校了」 */
function updateCalibChip(){
  const c = loadCalib();
  const chip = $('calibChip');
  if(!c || !matchesCamera(c, cfg.front) || !S.key){
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const stale = isStale(c);
  $('calibChipText').textContent =
    (SIGNALS[c.key]?.label || c.key) + ' · ' + describeAge(c);
  $('calibChipText').classList.toggle('warn', stale);
  $('calibChipHint').textContent = stale
    ? '手機位置若改變過，建議重新校正'
    : '按開始會直接計時，不用再校正';
}

$('calibClear').addEventListener('click', ()=>{
  clearCalib();
  S.key = null; S.up = 0; S.down = 0; S.ema = null;
  $('metaSignal').textContent = '—';
  updateCalibChip();
  refreshWaitRoom();
});

/* ============ 對戰接線 ============ */
installVersusHooks({
  hasCalibration: ()=> !!S.key,
  /* 等待室內自行校正。完成後回等待室（done 供房主流程用）。 */
  beginCalibration: (done)=>{
    vsCalibDone = done;
    calibReturn = 'versus';
    beginCalibration();
  },
  /**
   * 套用本場門檻。null = 自訂模式，沿用本機設定。
   * 只改門檻不改基準 —— 基準是裝置相依的，各自校正。
   */
  applyThresholds: (th)=>{
    if(th){ TH.down = th.down; TH.up = th.up; }
    else   { TH.down = myTh.down; TH.up = myTh.up; }
    setGaugeMarks(TH);
  },
  /* 「我的」模式要把房主自己調的門檻帶進房間 */
  getMyThresholds: ()=> ({ down:myTh.down, up:myTh.up }),
  /* 倒數開始就恢復推論，讓 GPU 熱起來（見 INFER_PHASES 的說明） */
  warmUpInference: ()=>{ if(S.phase==='idle') S.phase = 'countdown'; },
  beginVsRun,
  abortRun: abortVsRun,
});

$('versusBtn').addEventListener('click', ()=>{
  audioOn();
  requireConsent(async ()=>{
    /* 未登入就先登入 —— 使用者是「為了跟朋友對戰」而登入，
       登入成功後直接進大廳，不要把他丟回首頁再叫他按一次。 */
    if(!getUser()){
      $('versusBtn').disabled = true;
      $('versusBtn').textContent = '登入中…';
      try{
        await signIn();
        if(!getUser()) return;            // 使用者取消
        if(usingDefaultName()){ openNamePanel(); return; }
      }catch(e){
        showErr('登入失敗：'+(e.message||e));
        return;
      }finally{
        $('versusBtn').disabled = false;
        $('versusBtn').textContent = '跟朋友對戰';
      }
    }
    if(!getStream()) await openCamera(cfg, video, skel);
    openLobby();
  });
});

/* 手動計數 —— 給沒有相機、或用電腦當房主測試的情況。
   對戰中按空白鍵 / 點畫面中央即 +1，走的是同一條回報路徑。 */
function manualRep(){
  if(S.phase!=='vsrun') return;
  S.reps++; S.times.push(performance.now()-S.startAt);
  sfx.rep(S.reps);
  $('count').textContent = S.reps;
  pulse(); addTick(S.times);
  vsRun.onRep?.(S.reps);
  log('手動計數 '+S.reps);
}
addEventListener('keydown', e=>{
  if(e.code==='Space' && S.phase==='vsrun'){ e.preventDefault(); manualRep(); }
});
/* 不能綁在 #count 上 —— 它有 pointer-events:none（純顯示層），
   點擊會直接穿透過去。改用專屬的透明點擊區。 */
$('tapCount').addEventListener('click', manualRep);
$('manualBtn').addEventListener('click', manualRep);

/* ============ 啟動 ============ */
log('UA '+navigator.userAgent.slice(0,90));
log('secureContext='+window.isSecureContext+'  origin='+location.origin);

/* Firebase 是附加功能，不阻擋計數器啟動。
   載不起來就維持單機模式（帳號那塊會自己隱藏）。 */
initFirebase().then(ok=>{
  if(ok){
    watchAuth();
    initLobbyUI();
    /* 朋友傳來的 ?room=XXXX：已登入就直接進房，
       未登入則記下來，登入完成後由下面的 onAuthChange 補上。 */
    autoJoinFromUrl();
  }
  renderAccount(null, null);
});

let joinedFromUrl = false;
onAuthChange(user=>{
  if(user && !joinedFromUrl){
    joinedFromUrl = true;
    flushPendingJoin();
  }
});

/* 帶入上次的校正 —— 校正要擺兩個姿勢等 8 秒，能省就省 */
restoreCalib();

/* Service Worker：只快取靜態資源，讓「加入主畫面」後開得快。
   註冊失敗不影響任何功能（例如非 https、或使用者停用）。
   注意 iOS 上 PWA 首次開啟需重新授權相機（規格第 9 節）。 */
if('serviceWorker' in navigator && window.isSecureContext){
  const registerSW = ()=>{
    navigator.serviceWorker.register('sw.js')
      .then(reg=>{
        log('Service Worker 已註冊');
        /* 有新版時提示，不要讓使用者卡在舊版程式 */
        reg.addEventListener('updatefound', ()=>{
          const nw = reg.installing;
          nw?.addEventListener('statechange', ()=>{
            if(nw.state==='installed' && navigator.serviceWorker.controller){
              log('偵測到新版，重新整理即生效');
            }
          });
        });
      })
      .catch(e=> log('Service Worker 註冊失敗：'+(e.message||e).toString().slice(0,60)));
  };
  /* ES module 是 defer 執行，很可能在 load 之後才跑到這裡 ——
     那時 load 事件早就發生過，掛 listener 永遠不會被呼叫。
     所以要先判斷目前狀態。 */
  if(document.readyState === 'complete') registerSW();
  else addEventListener('load', registerSW);
}

/* 刻意不在啟動時開相機。
   首頁、大廳、戰績都不需要看到你 —— 一啟動就開相機等於從打開 App 那一刻
   就開始耗電發熱，而使用者可能只是想看戰績。
   改成「按開始 / 進測試模式 / 對戰」時才開（那幾處都已有 if(!getStream()) 的按需開啟）。 */
loop();
