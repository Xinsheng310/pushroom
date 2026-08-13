/* 主流程 — 設定、主迴圈、校正流程、倒數、結算、測試模式、導覽 */

import { log, showErr, installGlobalHandlers } from './log.js';
import { audioOn, audioState, sfx } from './audio.js';
import { openCamera, loadModel, getStream, getLandmarker, getModelStatus, drawSkeleton } from './pose.js';
import {
  SIGNALS, bodyFound, setAspect, SETTLE_MS, HOLD_MS, PASS,
  scoreCalibration, TH, S, track, resetCounter,
} from './detect.js';
import {
  $, panels, show, isLabOpen, fmt, setRing, setRingStroke, showRing,
  renderCalibReport, addTick, clearTicks, pulse, drawChart,
  renderChecks, renderSignalRows, updateSignalRow,
} from './ui.js';
import { initFirebase, isReady } from './firebase.js';
import {
  watchAuth, onAuthChange, signIn, signOut, setDisplayName,
  validName, usingDefaultName, addSession, getProfile, NAME_MAX,
} from './auth.js';

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
  cfg[key] = !cfg[key]; el.setAttribute('aria-checked', cfg[key]); after && after();
});
bindSwitch($('swCam'), 'front', ()=> openCamera(cfg, video, skel));
bindSwitch($('swSkel'), 'skeleton', ()=>{
  if(!cfg.skeleton) sctx.clearRect(0,0,skel.width,skel.height);
});

/* ============ 模型 ============ */
loadModel(ok=>{
  $('start').disabled = !ok;
  $('start').textContent = ok? '開始' : '模型載入失敗';
});

/* ============ 主迴圈 ============ */
let lastTs = -1;
function loop(){
  requestAnimationFrame(loop);
  const landmarker = getLandmarker();
  if(!landmarker || video.readyState<2) return;
  const ts = performance.now();
  if(ts===lastTs) return; lastTs = ts;

  let res; try{ res = landmarker.detectForVideo(video, ts); }catch(e){ return; }
  const lm = res?.landmarks?.[0];
  setAspect(video.videoWidth/video.videoHeight);

  if(cfg.skeleton) drawSkeleton(sctx, skel, video, lm);
  else if(skel.width) sctx.clearRect(0,0,skel.width,skel.height);

  onFrame(lm ?? null, ts);
}

/* ============ 校正 ============ */
let calib = {step:0, t0:0, samples:{}, seenAt:0, holding:false};
let calibReturn = 'run';

function beginCalibration(){
  S.phase = 'calib';
  calib = {step:0, t0:0, samples:{}, seenAt:0, holding:false};
  showRing(false);
  $('forceUse').style.display = 'none';
  $('cancelSetup').textContent = '取消';
  $('stepLabel').textContent = 'STEP 1 / 3';
  $('say').textContent = '正在找你…';
  $('subSay').textContent = '讓上半身進入畫面';
  show('setup');
}

function calibPrompt(step){
  showRing(true);
  calib.holding = false;
  setRingStroke('rgba(255,255,255,.28)');
  setRing(0);
  if(step===1){ $('stepLabel').textContent='STEP 2 / 3'; $('say').textContent='撐直手臂'; }
  if(step===2){ $('stepLabel').textContent='STEP 3 / 3'; $('say').textContent='下到最低點'; }
  $('subSay').textContent = '擺好姿勢…';
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
  $('say').textContent = '校正沒過';
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
  if(calibReturn==='lab'){
    S.phase = 'lab';
    resetCounter(); S.startAt = performance.now();
    $('labCount').textContent = '0';
    show('lab');
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
    if(n<0){ clearInterval(cdTimer); beginRun(); return; }
    $('say').textContent = n>0 ? String(n) : 'GO';
    n>0 ? sfx.tick() : sfx.go();
    n--;
  };
  tick(); cdTimer = setInterval(tick, 1000);
}

function beginRun(){
  S.phase = 'run';
  resetCounter();
  S.startAt = performance.now();
  S.endAt = cfg.seconds? S.startAt+cfg.seconds*1000 : 0;
  $('count').textContent = '0';
  clearTicks();
  $('clock').classList.remove('warn');
  $('markDown').style.bottom = (TH.down*100)+'%';
  show('run');
  requestWakeLock();
}

/* ============ 每幀 ============ */
let warned10 = false;
function onFrame(lm, ts){
  fpsTick(ts);
  if(isLabOpen()) labUpdate(lm, ts);

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
      $('subSay').textContent = '撐住不要動';
    }
    const p = Math.min(1, (el-SETTLE_MS)/HOLD_MS);
    setRing(p);
    if(lm) collect(lm);
    if(p>=1){
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
  if(r===null){ $('status').textContent='看不到你 — 調整位置'; return; }
  $('gaugeFill').style.height = Math.min(100, S.depth*100)+'%';
  if(r==='down') $('status').textContent = '撐起來';
  if(r==='rep'){
    $('count').textContent = S.reps; pulse(); addTick(S.times);
    $('status').textContent = '下一下';
  }
}

/* ============ 結算 ============ */
function finish(){
  S.phase = 'done'; releaseWakeLock(); sfx.end();
  const dur = cfg.seconds? cfg.seconds*1000 : (S.times.at(-1)||0);
  $('rTotal').textContent = S.reps;
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
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible' && S.phase==='run') requestWakeLock();
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
  if(ts-(labUpdate.t||0)>800){ labUpdate.t = ts; renderChecks(buildChecks()); }
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

const bindTh = (id,lbl,key) => $(id).addEventListener('input', e=>{
  TH[key] = +e.target.value;
  $(lbl).textContent = TH[key].toFixed(2);
  if(key==='down') $('markDown').style.bottom = (TH.down*100)+'%';
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
const CONSENT_KEY = 'reproom.consent.v1';
const consented = ()=>{ try{ return localStorage.getItem(CONSENT_KEY)==='1'; }catch(e){ return false; } };
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
  /* Firebase 沒就緒（設定未填 / CDN 掛）就整塊隱藏，維持純單機體驗 */
  $('account').hidden = !isReady();
  const signedIn = !!user;
  $('acctOut').hidden = signedIn;
  $('acctIn').hidden  = !signedIn;
  if(signedIn && prof){
    $('acctName').textContent = prof.displayName;
    const s = prof.stats || {};
    $('acctStats').textContent =
      `累計 ${s.totalReps ?? 0} 下 · 最佳 ${s.bestSession ?? 0} 下 · ${s.wins ?? 0}勝${s.losses ?? 0}敗`;
  }
}
onAuthChange(renderAccount);

$('signIn').addEventListener('click', async ()=>{
  audioOn();
  $('signIn').disabled = true;
  $('signIn').textContent = '登入中…';
  try{
    await signIn();
    /* 首次登入還在用預設暱稱 → 直接請他改，不要讓「匿名選手」上場 */
    if(usingDefaultName()) openNamePanel();
  }catch(e){
    showErr('登入失敗：'+(e.message||e));
    log('登入失敗：'+(e.message||e).toString().slice(0,110));
  }finally{
    $('signIn').disabled = false;
    $('signIn').textContent = '用 Google 登入';
  }
});

$('signOut').addEventListener('click', async ()=>{
  audioOn();
  try{ await signOut(); }catch(e){ showErr('登出失敗：'+(e.message||e)); }
});

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
    beginCalibration();
  });
});
$('cancelSetup').addEventListener('click',()=>{
  if(S.phase==='idle'){ beginCalibration(); return; }   // 「重新校正」
  S.phase = 'idle'; clearInterval(cdTimer);
  show(calibReturn==='lab'?'lab':'home');
});
$('abort').addEventListener('click',()=>{ if(S.phase==='run') finish(); });
$('again').addEventListener('click',()=>{ warned10=false; startCountdown(); show('setup'); });
$('home2').addEventListener('click',()=>{ S.phase='idle'; show('home'); });

setInterval(()=>{
  if(isLabOpen() && !getLandmarker()) renderChecks(buildChecks());
}, 1000);

/* ============ 啟動 ============ */
log('UA '+navigator.userAgent.slice(0,90));
log('secureContext='+window.isSecureContext+'  origin='+location.origin);

/* Firebase 是附加功能，不阻擋計數器啟動。
   載不起來就維持單機模式（帳號那塊會自己隱藏）。 */
initFirebase().then(ok=>{
  if(ok) watchAuth();
  renderAccount(null, null);
});

openCamera(cfg, video, skel);
loop();
