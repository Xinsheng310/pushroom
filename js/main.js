/* 主流程 — 設定、主迴圈、校正流程、倒數、結算、測試模式、導覽 */

import { log, showErr, installGlobalHandlers } from './log.js';
import { audioOn, audioState, sfx, humStart, humSet, humStop } from './audio.js';
import {
  openCamera, loadModel, getStream, getLandmarker, getModelStatus, drawSkeleton,
} from './pose.js';
import { SIGNALS, setAspect, TH, S, track, resetCounter } from './detect.js';
import {
  $, show, isLabOpen, fmt, showRing, addTick, clearTicks, pulse, drawChart,
  renderChecks, renderSignalRows, updateSignalRow,
  showCountdown, clearCountdown, flash, rollNumber, replay, setGaugeMarks,
} from './ui.js';
import { initFirebase } from './firebase.js';
import {
  watchAuth, onAuthChange, signIn, usingDefaultName, addSession, getUser,
} from './auth.js';
import {
  initLobbyUI, openLobby, installVersusHooks,
  autoJoinFromUrl, flushPendingJoin, refreshWaitRoom, getRoomView,
} from './versus.js';
import {
  loadCalib, saveCalib, clearCalib, isStale, matchesCamera, describeAge,
} from './calibstore.js';
import { perfInfer, perfFrame, perfGap, perfReset, perfLine } from './perf.js';
import { requestWakeLock, releaseWakeLock, wakeLockHeld, installPowerHandlers } from './power.js';
import { beginCalibration, calibFrame, installCalibFlow, resetCalibSearch } from './calibflow.js';
import { requireConsent, openNamePanel, renderAccount } from './panels.js';
import { installDiag, setDiag, diagOn } from './diag.js';

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
/* 流程本身在 calibflow.js。這裡只留「校正完之後要去哪裡」——
   那取決於是誰叫起校正的（計時 / 測試模式 / 對戰等待室）。 */
let calibReturn = 'run';
/* 對戰校正完成後要回呼給 versus.js（宣告在這裡，避免 TDZ） */
let vsCalibDone = null;
/* 使用者自己在測試模式調的門檻。對戰會暫時套用統一門檻，結束後還原，
   否則單機練習會莫名沿用上一場對戰的標準。 */
const myTh = { ...TH };

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
  if(S.phase==='calib'){ calibFrame(lm, ts); return; }

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

installPowerHandlers(cfg, video, skel, ()=> needsInference() || isLabOpen());
installCalibFlow(applyCalib, ()=> cfg.front);

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
    ['螢幕恆亮', wakeLockHeld(), wakeLockHeld()? '已鎖定' : (navigator.wakeLock? '執行時才啟用':'此瀏覽器不支援')],
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
/* 校正找不到人時的出路：換一顆鏡頭再試。
   同時重置計時，讓提示從頭開始而不是立刻又跳「還是找不到你」。 */
$('flipCam').addEventListener('click', async ()=>{
  cfg.front = !cfg.front;
  $('swCam').setAttribute('aria-checked', cfg.front);
  updateCamSummary();
  $('flipCam').hidden = true;
  $('flipCam').textContent = cfg.front ? '換成後鏡頭' : '換成前鏡頭';
  $('subSay').textContent = '上半身進入畫面';
  resetCalibSearch();
  await openCamera(cfg, video, skel);
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
/* 這次長按有沒有真的完成。放開時要靠它分辨「已經結束了」與「放太早」——
   兩種情況都會走到 abortHoldEnd，但只有後者該給提示。 */
let abortFired = false;
const abortBtn = $('abort');

function abortHoldStart(e){
  if(S.phase!=='run' && S.phase!=='vsrun') return;
  e.preventDefault();
  abortFired = false;
  abortBtn.classList.add('holding');
  clearTimeout(abortTimer);
  abortTimer = setTimeout(()=>{
    abortFired = true;
    abortBtn.classList.remove('holding');
    if(S.phase==='run') finish();
    else if(S.phase==='vsrun'){ vsRun.onEnd?.(S.reps); stopVsClock(); S.phase='done'; }
  }, ABORT_HOLD_MS);
}
function abortHoldEnd(){
  const wasHolding = !!abortTimer;
  clearTimeout(abortTimer); abortTimer = null;
  abortBtn.classList.remove('holding');
  /* 按了卻放太早 —— 原本是靜默取消，第一次用的人會以為按鈕壞了。
     就地說明它需要長按。 */
  if(wasHolding && !abortFired) showAbortHint();
}

/* 提示靠動畫自己收尾（keyframes 最後停在 opacity:0）。
   但 replay() 在 prefers-reduced-motion 下不做事 —— 那時動畫不會跑，
   訊息就會永遠留在畫面上。所以那條路徑要自己收。 */
let abortHintTimer = null;
function showAbortHint(){
  const el = $('abortHint');
  clearTimeout(abortHintTimer);
  el.hidden = false;
  el.classList.remove('aborthint');
  void el.offsetWidth;
  el.classList.add('aborthint');
  abortHintTimer = setTimeout(()=>{ el.hidden = true; }, 1700);
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
/* 診斷窗要看的本機狀態。只讀，不影響任何流程。 */
installDiag(
  getRoomView,
  ()=> ({
    phase: S.phase,
    reps: S.reps,
    manual: vsRun.manual,
    /* 訊號與基準是校正的產物（裝置相依）；
       門檻是本場套用的比例值（對戰時可能被統一成標準/寬鬆）。
       兩者要分開顯示 —— 混在一起會讓人以為校正被改掉了。 */
    calibKey: S.key,
    base: S.key ? S.down?.toFixed(1) + '↓ ' + S.up?.toFixed(1) + '↑' : null,
    th: TH.down?.toFixed(2) + '/' + TH.up?.toFixed(2),
    myTh: myTh.down.toFixed(2) + '/' + myTh.up.toFixed(2),
  })
);

/* 測試模式的診斷開關。
   installDiag 會從 localStorage 還原上次的選擇，所以開關要跟著同步 ——
   否則重整後診斷窗開著、開關卻顯示關閉，按下去等於把它關掉，
   使用者會以為開關壞了。 */
$('swDiag').setAttribute('aria-checked', String(diagOn()));
$('swDiag').addEventListener('click', ()=>{
  const next = !diagOn();
  $('swDiag').setAttribute('aria-checked', String(next));
  setDiag(next);
});
$('diagClose').addEventListener('click', ()=>{
  setDiag(false);
  $('swDiag').setAttribute('aria-checked', 'false');
});

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
        /* Firebase 的錯誤代碼對使用者沒有意義。
           真正的原因寫進紀錄，畫面上只講他能做的事。 */
        log('登入失敗：'+(e.message||e));
        showErr('登入沒成功，可能是被瀏覽器擋掉了彈出視窗。再試一次。');
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
