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
  createRoom, joinRoom, leaveRoom, onRoomChange, startMatch, setState, setReady,
  setCalibMode, pushReps, writeResult, opponentGrace, getCode, getRole, isHost, inRoom,
  installVisibilityHandler, reapIfDead, HOST,
} from './room.js';
import { MODES, DEFAULT_MODE, modeLabel, modeHint, thresholdsFor } from './calibmode.js';
import { normalizeCode, isValidCode, codeFromUrl } from './roomcode.js';
import { alignedTimer, msUntil } from './clock.js';
import { shareCode, lineUrl, canNativeShare } from './share.js';
import { getUser, getProfile } from './auth.js';

const COUNTDOWN_SEC = 3;

/* 由 main.js 注入 —— 對戰需要驅動校正與計數，那些函式住在 main.js */
let hooks = {
  beginCalibration: null,   // (onDone) => void
  beginVsRun: null,         // (timer, durationSec, onRep, onEnd, manual) => void
  abortRun: null,           // () => void
  hasCalibration: null,     // () => boolean
  applyThresholds: null,    // (th|null) => void
  getMyThresholds: null,    // () => {down,up}  房主自己調的門檻
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
let lobbyMode = DEFAULT_MODE;
/** 本場的判定標準，由房主寫入 RTDB，雙方讀同一個值 */
let currentMode = DEFAULT_MODE;
/** 訪客的準備狀態（本機記錄，實際值以 RTDB 為準） */
let myReady = false;

export function initLobbyUI(){
  $('vsDurations').addEventListener('click', e=>{
    const b = e.target.closest('.chip'); if(!b) return;
    [...$('vsDurations').children].forEach(c=>c.setAttribute('aria-checked', c===b));
    lobbyDuration = +b.dataset.sec;
  });

  $('vsModes').addEventListener('click', e=>{
    const b = e.target.closest('.chip'); if(!b) return;
    [...$('vsModes').children].forEach(c=>c.setAttribute('aria-checked', c===b));
    lobbyMode = b.dataset.mode;
    $('modeHint').textContent = modeHint(lobbyMode);
  });

  /* 房主在等待室改模式 → 回大廳選（房間已建立，改完直接寫回 RTDB） */
  $('wModeChange').addEventListener('click', async ()=>{
    audioOn();
    const order = Object.keys(MODES);
    const next = order[(order.indexOf(currentMode)+1) % order.length];
    const th = next==='hostth' ? hooks.getMyThresholds?.() : null;
    try{ await setCalibMode(next, th); }
    catch(e){ showErr('改不了模式：'+(e.message||e)); }
  });

  /* 等待室內自行校正 —— 雙方都能按，各自校正自己的基準 */
  $('wCalibBtn').addEventListener('click', ()=>{
    audioOn();
    hooks.beginCalibration?.(()=>{});
  });

  $('createRoom').addEventListener('click', async ()=>{
    audioOn();
    const me = meIdentity(); if(!me) return;
    $('createRoom').disabled = true;
    $('createRoom').textContent = '開房中…';
    try{
      /* 選「房主的標準」時要把自己的門檻一起帶上去 */
      const th = lobbyMode==='hostth' ? hooks.getMyThresholds?.() : null;
      const code = await createRoom(me, lobbyDuration, lobbyMode, th);
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

  /* 訪客的準備按鈕。訪客原本只能乾等，房主也不知道對方好了沒 ——
     按下後房主那邊的狀態會變「已準備」，開始鈕也才會亮。 */
  $('readyBtn').addEventListener('click', async ()=>{
    audioOn();
    const next = !myReady;
    $('readyBtn').disabled = true;
    try{
      await setReady(next);
      myReady = next;
    }catch(e){
      showErr('狀態更新失敗：'+(e.message||e));
    }finally{
      $('readyBtn').disabled = false;
    }
  });

  $('waitLeave').addEventListener('click', async ()=>{
    myReady = false;
    await leaveRoom(); show('home');
  });

  /* 這兩個都要先離開舊房間 —— 那場已經結算完，留著會讓下次回到前景時
     又被接回一個結束的房間。房主離開會順手刪掉整個節點。 */
  $('vsAgain').addEventListener('click', async ()=>{
    myReady = false; lastState = null;
    await leaveRoom();
    openLobby();
  });
  $('vsHome').addEventListener('click', async ()=>{
    myReady = false; lastState = null;
    await leaveRoom(); show('home');
  });

  if(!canNativeShare()) $('shareBtn').textContent = '複製房號';

  /* 回到前景時若房間已失效（打完了、對手走了），把人帶回首頁並說明原因，
     而不是讓他停在一個早就結束的房間畫面上。 */
  installVisibilityHandler((reason)=>{
    endVersus();
    lastState = null;
    show('home');
    showErr(reason);
  });
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
  /* 連結指向的房間可能早就打完了（朋友分享的連結過了一小時）。
     先清一輪，joinRoom 也會再擋一次。 */
  if(await reapIfDead(code)){
    showErr('這個房間已經結束了');
    return false;
  }
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
  $('goMatch').textContent = '開始中…';
  try{
    /* 直接開始 —— 不把校正擋在前面。
       原本的寫法是「先校正完才寫 startAt」，結果房主校正失敗或取消時
       startAt 永遠不會寫入，對手就一直卡在等待室、什麼提示都沒有。
       校正是「我這台能不能自動計數」的問題，不該綁架對手的體驗。
       沒校正的人可以用手動計數（空白鍵／點畫面）。 */
    await startMatch(COUNTDOWN_SEC);
  }catch(e){
    showErr(e.message || String(e));
    $('goMatch').disabled = false;
    $('goMatch').textContent = '開始';
  }
}

/* ============ 房間狀態變化 ============ */
let lastState = null;
function render(v){
  if(!v){
    /* 房間消失（房主離開） */
    lastView = null;
    if(vs.active){ endVersus(); showErr('房主離開了，房間關閉'); }
    if(inRoom()===false && ['wait','vsresult'].includes(currentPanel())) show('home');
    return;
  }

  lastView = v;

  /* --- 等待室 --- */
  $('waitRole').textContent = v.isHost ? '房主' : '訪客';
  $('codeBig').textContent = v.code;
  $('wMeName').textContent = v.me?.name || '你';
  vs.durationSec = v.durationSec;

  const op = v.opponent;
  $('wOpName').textContent = op?.name || '等待中…';
  vs.opName = op?.name || '對手';

  /* 我自己的準備狀態以 RTDB 為準（換裝置或重連後也正確） */
  myReady = !!v.me?.ready;
  $('wMeState').textContent = v.isHost ? '你（房主）' : (myReady ? '你 · 已準備' : '你');

  if(!op){
    $('wOpState').textContent = v.isHost ? '尚未加入' : '房主不在？';
    $('waitHint').textContent = v.isHost
      ? '把房號給朋友，他輸入後就會出現在下面。'
      : '已加入，按下「我準備好了」告訴房主。';
  }else{
    const g = opponentGrace();
    $('wOpState').textContent = !op.online
      ? (g.expired ? '已離開' : '連線不穩，等待中…')
      : (op.ready ? '已準備' : '還沒準備');
  }

  /* --- 本場判定標準（雙方一致） --- */
  currentMode = v.calibMode || DEFAULT_MODE;
  $('wModeName').textContent = modeLabel(currentMode) + (v.isHost ? '' : '（房主設定）');
  /* 顯示實際門檻數值 —— 「房主的標準」光看名字不知道嚴不嚴 */
  const shownTh = thresholdsFor(currentMode, v.hostTh);
  $('wModeHint').textContent = shownTh
    ? `${modeHint(currentMode)}（下壓 ${shownTh.down.toFixed(2)}）`
    : modeHint(currentMode);
  $('wModeChange').hidden = !v.isHost;

  /* --- 我自己的校正狀態 --- */
  const calibrated = !!hooks.hasCalibration?.();
  $('wCalibState').textContent = calibrated ? '已校正' : '尚未校正';
  $('wCalibState').classList.toggle('ok', calibrated);
  $('wCalibHint').textContent = calibrated
    ? '可以自動計數了'
    : '沒校正也能玩，但要手動按計數';
  $('wCalibBtn').textContent = calibrated ? '重新校正' : '校正';

  if(v.isHost){
    /* 只有房主能開始（規格第 6.3 節：這同時擋掉亂猜房號的人）。
       對手必須按下準備才能開始 —— 避免手機還在口袋裡就被開賽。 */
    $('readyBtn').hidden = true;
    $('goMatch').hidden = false;
    const canStart = !!op && op.online && !!op.ready;
    $('goMatch').disabled = !canStart;
    $('goMatch').textContent = !op ? '等對手加入'
      : !op.online ? '對手連線中…'
      : !op.ready ? '等對手按準備'
      : '開始';
  }else{
    /* 訪客：顯示準備按鈕，不顯示開始鈕 */
    $('goMatch').hidden = true;
    $('readyBtn').hidden = false;
    $('readyBtn').textContent = myReady ? '取消準備' : '我準備好了';
    $('waitNote').textContent = myReady ? '等房主按開始…' : '';
  }

  /* --- 狀態轉換 --- */
  if(v.state !== lastState){
    lastState = v.state;
    if(v.state==='counting' && v.startAt) onCounting(v);
    if(v.state==='done') onDone(v);
  }
  /* result 出現也視為結束。比 state 可靠：任一方都能寫 result，
     但只有房主能改 state —— 房主先離線時 state 會永遠卡在 counting。 */
  if(v.result && vs.active) onDone(v);

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

/** 校正完成後由 main.js 呼叫，讓等待室的「已校正」狀態立刻更新。
    render 只在 RTDB 有變化時才跑，校正是本機事件不會觸發它。 */
export function refreshWaitRoom(){
  if(lastView) render(lastView);
}
let lastView = null;

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

  /* 套用本場的判定門檻。基準（up/down）各自校正 —— 那是裝置相依的數值，
     共用會完全錯亂；門檻是比例值，統一才公平。詳見 calibmode.js 的說明。
     自訂模式回傳 null，代表沿用各自在測試模式調的門檻。 */
  const th = thresholdsFor(v.calibMode || DEFAULT_MODE, v.hostTh);
  hooks.applyThresholds?.(th);
  log('本場判定：'+modeLabel(v.calibMode||DEFAULT_MODE)
      + (th ? ` (下壓 ${th.down} / 回頂 ${th.up})` : '（各自自訂）'));

  /* 沒校正過就無法自動計數。倒數期間來不及做校正（要擺兩個姿勢），
     所以直接告訴他可以手動計數 —— 總比整場不能玩好。 */
  vs.manual = !hooks.hasCalibration?.();
  if(vs.manual) log('尚未校正，本場用手動計數');

  show('setup');
  $('stepLabel').textContent = '';
  $('subSay').textContent = vs.manual
    ? '這台沒校正過，比賽中按空白鍵或點畫面計數'
    : '回到起始姿勢';

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
  hooks.beginVsRun(vs.timer, vs.durationSec, onMyRep, onMatchEnd, vs.manual);
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
