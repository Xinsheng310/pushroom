/* 對戰流程 — 把房間狀態機接到計數器上

   規格第 6.3 節的流程：
     建房（選時長）→ 等待 → 訪客加入 → 房主看到訪客後手動按開始
     → 雙方同步倒數 3 秒 → 對戰 → 結算寫入 Firestore

   規格第 7 節：對戰中唯一該強化的是對手的即時數字。
   落後幾下、追上了沒，這個緊張感勝過任何特效。 */

import { log, showErr } from './log.js';
import { $, show, fmt } from './ui.js';
import { sfx, audioOn } from './audio.js';
import {
  createRoom, joinRoom, leaveRoom, onRoomChange, startMatch, setState,
  pushReps, writeResult, opponentGrace, getCode, getRole, isHost, inRoom,
  installVisibilityHandler, HOST,
} from './room.js';
import { normalizeCode, isValidCode, codeFromUrl } from './roomcode.js';
import { alignedTimer, msUntil } from './clock.js';
import { shareCode, lineUrl, canNativeShare } from './share.js';
import { getUser, getProfile } from './auth.js';

const COUNTDOWN_SEC = 3;

/* 由 main.js 注入 —— 對戰需要驅動校正與計數，那些函式住在 main.js */
let hooks = {
  beginCalibration: null,   // (onDone) => void
  beginVsRun: null,         // (timer, durationSec, onRep, onEnd) => void
  abortRun: null,           // () => void
  hasCalibration: null,     // () => boolean
};
export function installVersusHooks(h){ hooks = { ...hooks, ...h }; }

const vs = {
  active: false,
  durationSec: 60,
  timer: null,
  myReps: 0,
  opReps: 0,
  opName: '對手',
  ended: false,
  lastPush: 0,
  graceTimer: null,
};

export const isVersusActive = ()=> vs.active;

/* ============ 我是誰 ============ */
function meIdentity(){
  const u = getUser(), p = getProfile();
  if(!u) return null;
  return { uid: u.uid, name: p?.displayName || '匿名選手' };
}

/* ============ 大廳 ============ */
export function openLobby(){
  const me = meIdentity();
  if(!me){ showErr('要先登入才能對戰'); return; }
  $('lobbyErr').hidden = true;
  $('codeInput').value = '';
  show('lobby');
}

let lobbyDuration = 60;
export function initLobbyUI(){
  $('vsDurations').addEventListener('click', e=>{
    const b = e.target.closest('.chip'); if(!b) return;
    [...$('vsDurations').children].forEach(c=>c.setAttribute('aria-checked', c===b));
    lobbyDuration = +b.dataset.sec;
  });

  $('createRoom').addEventListener('click', async ()=>{
    audioOn();
    const me = meIdentity(); if(!me) return;
    $('createRoom').disabled = true;
    $('createRoom').textContent = '開房中…';
    try{
      const code = await createRoom(me, lobbyDuration);
      vs.durationSec = lobbyDuration;
      show('wait');
      log('房號 '+code);
    }catch(e){
      lobbyError(e.message || String(e));
    }finally{
      $('createRoom').disabled = false;
      $('createRoom').textContent = '開一間';
    }
  });

  $('joinRoom').addEventListener('click', ()=> doJoin($('codeInput').value));
  $('codeInput').addEventListener('keydown', e=>{ if(e.key==='Enter') doJoin($('codeInput').value); });
  /* 邊打邊正規化，使用者立刻看到「打錯的字被修正成什麼」 */
  $('codeInput').addEventListener('input', e=>{
    const norm = normalizeCode(e.target.value);
    if(norm !== e.target.value) e.target.value = norm;
    $('lobbyErr').hidden = true;
  });

  $('lobbyBack').addEventListener('click', ()=> show('home'));

  /* 等待室 */
  $('shareBtn').addEventListener('click', async ()=>{
    audioOn();
    const code = getCode(); if(!code) return;
    const r = await shareCode(code);
    const msg = { shared:'已開啟分享選單', copied:'已複製房號與連結，貼給朋友即可',
                  cancelled:'', failed:'複製失敗，請手動把房號念給朋友' }[r];
    if(msg){ $('shareMsg').textContent = msg; $('shareMsg').hidden = false; }
  });
  $('lineBtn').addEventListener('click', ()=>{
    const code = getCode(); if(!code) return;
    /* 開新視窗，不要取代目前頁面 —— 房主離開頁面房間就結束了 */
    window.open(lineUrl(code), '_blank', 'noopener');
  });

  $('goMatch').addEventListener('click', ()=>{ audioOn(); hostStart(); });
  $('waitLeave').addEventListener('click', async ()=>{
    await leaveRoom(); show('home');
  });

  $('vsAgain').addEventListener('click', ()=>{ show('lobby'); });
  $('vsHome').addEventListener('click', async ()=>{ await leaveRoom(); show('home'); });

  if(!canNativeShare()) $('shareBtn').textContent = '複製房號';

  installVisibilityHandler();
  onRoomChange(render);
}

function lobbyError(msg){
  $('lobbyErr').textContent = msg;
  $('lobbyErr').hidden = false;
}

async function doJoin(raw){
  audioOn();
  const me = meIdentity(); if(!me) return;
  const code = normalizeCode(raw);
  if(!isValidCode(code)){ lobbyError('房號要四個字'); return; }
  $('joinRoom').disabled = true;
  try{
    await joinRoom(me, code);
    show('wait');
  }catch(e){
    lobbyError(e.message || String(e));
  }finally{
    $('joinRoom').disabled = false;
  }
}

/** 從網址的 ?room=XXXX 自動加入 */
export async function autoJoinFromUrl(){
  const code = codeFromUrl();
  if(!code) return false;
  const me = meIdentity();
  if(!me){
    /* 還沒登入 —— 記下來，登入後再自動加入 */
    pendingJoin = code;
    log('網址帶房號 '+code+'，等登入後加入');
    return false;
  }
  try{
    await joinRoom(me, code);
    show('wait');
    return true;
  }catch(e){
    showErr(e.message || String(e));
    return false;
  }
}
let pendingJoin = null;
/** 登入完成後補上先前記下的房號 */
export async function flushPendingJoin(){
  if(!pendingJoin) return;
  const code = pendingJoin; pendingJoin = null;
  const me = meIdentity(); if(!me) return;
  try{ await joinRoom(me, code); show('wait'); }
  catch(e){ showErr(e.message || String(e)); }
}

/* ============ 房主按開始 ============ */
async function hostStart(){
  if(!isHost()) return;
  $('goMatch').disabled = true;
  try{
    /* 校正在倒數之前做完 —— 校正需要擺姿勢，不能跟倒數搶時間 */
    if(!hooks.hasCalibration?.()){
      $('waitNote').textContent = '先做一次校正…';
      await new Promise(res=> hooks.beginCalibration(res));
    }
    await startMatch(COUNTDOWN_SEC);
  }catch(e){
    showErr(e.message || String(e));
    $('goMatch').disabled = false;
  }
}

/* ============ 房間狀態變化 ============ */
let lastState = null;
function render(v){
  if(!v){
    /* 房間消失（房主離開） */
    if(vs.active){ endVersus(); showErr('房主離開了，房間關閉'); }
    if(inRoom()===false && ['wait','vsresult'].includes(currentPanel())) show('home');
    return;
  }

  /* --- 等待室 --- */
  $('waitRole').textContent = v.isHost ? '房主' : '訪客';
  $('codeBig').textContent = v.code;
  $('wMeName').textContent = v.me?.name || '你';
  vs.durationSec = v.durationSec;

  const op = v.opponent;
  $('wOpName').textContent = op?.name || '等待中…';
  vs.opName = op?.name || '對手';

  if(!op){
    $('wOpState').textContent = v.isHost ? '尚未加入' : '房主不在？';
    $('waitHint').textContent = v.isHost
      ? '把房號給朋友，他輸入後就會出現在下面。'
      : '已加入，等房主按開始。';
  }else{
    const g = opponentGrace();
    $('wOpState').textContent = op.online ? '已就位'
      : g.expired ? '已離開' : '連線不穩，等待中…';
  }

  /* 只有房主能開始，且要等對手在線（規格第 6.3 節：這同時擋掉亂猜房號的人） */
  if(v.isHost){
    const ready = !!op && op.online;
    $('goMatch').disabled = !ready;
    $('goMatch').textContent = ready ? '開始' : '等對手加入';
  }else{
    $('goMatch').disabled = true;
    $('goMatch').textContent = '等房主開始';
  }

  /* --- 狀態轉換 --- */
  if(v.state !== lastState){
    lastState = v.state;
    if(v.state==='counting' && v.startAt) onCounting(v);
    if(v.state==='done') onDone(v);
  }

  /* --- 對戰中：更新對手比分 --- */
  if(vs.active && op){
    vs.opReps = op.reps || 0;
    updateVsLive();
    const g = opponentGrace();
    $('vsLive').classList.toggle('stale', g.stale);
  }

  /* 結算畫面 */
  if(v.result && currentPanel()==='vsresult') paintResult(v);
}

const currentPanel = ()=>
  [...document.querySelectorAll('.panel')].find(p=>p.classList.contains('on'))?.id;

/* ============ 同步倒數 → 對戰 ============ */
async function onCounting(v){
  /* startAt 是「按下開始」的伺服器時刻，加上倒數長度才是真正起跑時間。
     countdownSec 由房主寫入，雙方讀同一個值 → 起跑點必然一致。 */
  const startAt = v.startAt + (v.countdownSec ?? COUNTDOWN_SEC)*1000;

  vs.active = true;
  vs.ended = false;
  vs.myReps = 0;
  vs.opReps = v.opponent?.reps || 0;
  vs.timer = alignedTimer(startAt);

  /* 訪客可能還沒校正 —— 倒數期間來不及，先讓他進場，
     偵測不到就顯示提示（總比整場不能玩好）。 */
  if(!hooks.hasCalibration?.()){
    log('尚未校正，對戰中將無法計數');
  }

  show('setup');
  $('stepLabel').textContent = '';
  $('subSay').textContent = '回到起始姿勢';

  /* 用校正後的時間跑倒數，雙方畫面同步 */
  const tick = ()=>{
    const left = msUntil(startAt);
    if(left <= 0){
      $('say').textContent = 'GO';
      sfx.go();
      beginVsMatch();
      return;
    }
    const n = Math.ceil(left/1000);
    $('say').textContent = String(n);
    sfx.tick();
    setTimeout(tick, Math.min(1000, left - (n-1)*1000 || 1000));
  };
  tick();
}

function beginVsMatch(){
  $('vsLive').hidden = false;
  $('vsLiveName').textContent = vs.opName;
  updateVsLive();
  hooks.beginVsRun(vs.timer, vs.durationSec, onMyRep, onMatchEnd);
}

/** 我做完一下 */
function onMyRep(reps){
  vs.myReps = reps;
  /* 節流：不要每下都寫，但也不能太慢 —— 對手要有「被追上」的即時感。
     250ms 是「看起來即時」與「不要打爆 RTDB」的折衷。 */
  const now = performance.now();
  if(now - vs.lastPush > 250){
    vs.lastPush = now;
    pushReps(reps);
  }else{
    clearTimeout(onMyRep.t);
    onMyRep.t = setTimeout(()=>{ vs.lastPush = performance.now(); pushReps(vs.myReps); }, 260);
  }
  updateVsLive();
}

function updateVsLive(){
  $('vsLiveReps').textContent = vs.opReps;
  const d = vs.myReps - vs.opReps;
  const el = $('vsLiveGap');
  el.classList.toggle('lead', d>0);
  el.classList.toggle('behind', d<0);
  el.textContent = d>0 ? `領先 ${d} 下` : d<0 ? `落後 ${-d} 下` : '平手';
}

/** 時間到 */
async function onMatchEnd(myReps){
  if(vs.ended) return;
  vs.ended = true;
  vs.myReps = myReps;
  await pushReps(myReps);           // 確保最後一次數字送出去

  const hostReps  = isHost() ? myReps : vs.opReps;
  const guestReps = isHost() ? vs.opReps : myReps;

  if(isHost()){
    await writeResult(hostReps, guestReps);
    await setState('done');
  }else{
    /* 訪客也寫一次 —— 房主在結算瞬間斷線時紀錄才不會遺失。
       規則保證同一 result 只能寫一次，先到先算。 */
    await writeResult(hostReps, guestReps);
  }
  showVsResult();
}

function onDone(){ if(vs.active) showVsResult(); }

function showVsResult(){
  vs.active = false;
  $('vsLive').hidden = true;
  paintResult(null);
  show('vsresult');
  sfx.end();
}

function paintResult(v){
  const my = vs.myReps, op = vs.opReps;
  $('vsMeReps').textContent = my;
  $('vsOpReps').textContent = op;
  $('vsMeName').textContent = '你';
  $('vsOpName').textContent = vs.opName;
  const verdict = my>op ? '贏了' : my<op ? '輸了' : '平手';
  $('vsVerdict').textContent = verdict;
  $('vsVerdictCap').textContent = my>op ? `${my} : ${op}` : my<op ? `${my} : ${op}` : '平手';
}

function endVersus(){
  vs.active = false;
  $('vsLive').hidden = true;
  hooks.abortRun?.();
}
