/* 對戰流程 — 把房間狀態機接到計數器上

   規格第 6.3 節的流程：
     建房（選時長）→ 等待 → 訪客加入 → 房主看到訪客後手動按開始
     → 雙方同步倒數 3 秒 → 對戰 → 結算寫入 Firestore

   規格第 7 節：對戰中唯一該強化的是對手的即時數字。
   落後幾下、追上了沒，這個緊張感勝過任何特效。 */

import { log, showErr } from './log.js';
import { $, show, showCountdown, clearCountdown, flash, rollNumber, replay } from './ui.js';
import { sfx, audioOn } from './audio.js';
import {
  createRoom, joinRoom, leaveRoom, onRoomChange, startMatch, setState, setReady,
  setCalibMode, setCalibrating, pushReps, writeResult, opponentGrace, getCode, isHost, inRoom,
  installVisibilityHandler, reapIfDead,
} from './room.js';
import { MODES, DEFAULT_MODE, modeLabel, modeHint, thresholdsFor } from './calibmode.js';
import { normalizeCode, isValidCode, codeFromUrl } from './roomcode.js';
import { alignedTimer, msUntil } from './clock.js';
import { shareCode, lineUrl, canNativeShare } from './share.js';
import { getUser, getProfile, refreshProfile } from './auth.js';
import { recordMatch, applyMatchStats } from './matches.js';

const COUNTDOWN_SEC = 3;

/* 由 main.js 注入 —— 對戰需要驅動校正與計數，那些函式住在 main.js */
let hooks = {
  beginCalibration: null,   // (onDone) => void
  beginVsRun: null,         // (timer, durationSec, onRep, onEnd, manual) => void
  abortRun: null,           // () => void
  hasCalibration: null,     // () => boolean
  applyThresholds: null,    // (th|null) => void
  getMyThresholds: null,    // () => {down,up}  房主自己調的門檻
  warmUpInference: null,    // () => void  倒數期間先把推論打開暖機
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
/** 是否已經為「對手出現」演出過（避免每次 render 都重播） */
let sawOpponent = false;
/** 使用者手動開合過摺疊 —— 之後就不再自動幫他決定 */
let foldPinned = false;
/** 校正逾時保險 */
let calibFlagTimer = null;

/* ============ 等待室的四個階段 ============

   等待室其實是一台狀態機，任何一刻只有一件該做的事。
   把「現在是哪個階段」抽成純函式，是為了能直接測 ——
   四個階段 × 對手在不在 × 準備了沒，用手點很難點全。 */

export const PHASES = ['ph-share','ph-ready','ph-guest-set','ph-guest-wait'];

/** 每個階段的提示文字。只講當下該做的那一件事。 */
export const PHASE_HINT = {
  'ph-share':      '把房號念給朋友，或按分享傳給他',
  'ph-ready':      '對手到了。確認校正後就能開始',
  'ph-guest-set':  '先校正，然後按準備',
  'ph-guest-wait': '已準備，等房主開始',
};

/**
 * 決定等待室目前的階段。
 * @param {{isHost:boolean, hasOpponent:boolean, meReady:boolean}} s
 * @returns {'ph-share'|'ph-ready'|'ph-guest-set'|'ph-guest-wait'}
 */
export function waitPhase(s){
  if(s.isHost) return s.hasOpponent ? 'ph-ready' : 'ph-share';
  return s.meReady ? 'ph-guest-wait' : 'ph-guest-set';
}

/**
 * 房主現在能不能按開始。
 * @param {{opponent:object|null, opponentCalibrating:boolean}} s
 */
export function canHostStart(s){
  const op = s.opponent;
  return !!op && !!op.online && !!op.ready && !s.opponentCalibrating;
}

/** 開始鈕該顯示什麼字（也解釋了為什麼不能按） */
export function startLabel(s){
  const op = s.opponent;
  if(!op) return '等對手加入';
  if(!op.online) return '對手連線中…';
  if(s.opponentCalibrating) return '等對方校正完';
  if(!op.ready) return '等對手按準備';
  return '開始';
}

/**
 * 展開／收合賽前設定。
 * @param {boolean} open
 * @param {boolean} [manual] 使用者自己按的。按過之後就不再自動幫他開合 ——
 *                           階段一變就把他打開的東西收起來，會像介面在跟他作對。
 */
function setFold(open, manual=false){
  if(foldPinned && !manual) return;
  if(manual) foldPinned = true;
  $('waitFoldBody').dataset.open = String(open);
  $('waitFoldBtn').setAttribute('aria-expanded', String(open));
}

/**
 * 標記自己正在校正，讓對手看得到。
 * 除了 room.js 的 onDisconnect 之外再加一道 12 秒逾時 ——
 * 那道防的是斷線，這道防的是「沒斷線但流程卡住」（例如相機開不起來）。
 */
function markCalibrating(on){
  clearTimeout(calibFlagTimer); calibFlagTimer = null;
  if(!inRoom()) return;
  setCalibrating(on).catch(()=>{});
  if(on){
    calibFlagTimer = setTimeout(()=>{ setCalibrating(false).catch(()=>{}); }, 12000);
  }
}

export function initLobbyUI(){
  $('vsDurations').addEventListener('click', e=>{
    const b = e.target.closest('.chip'); if(!b) return;
    [...$('vsDurations').children].forEach(c=>c.setAttribute('aria-checked', c===b));
    lobbyDuration = +b.dataset.sec;
    /* 無限賽制要說明怎麼結束，否則使用者不知道 */
    $('vsDurHint').hidden = lobbyDuration !== 0;
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
    catch(e){ showErr('改不了判定標準，網路可能不穩。再按一次試試。'); }
  });

  /* 賽前設定摺疊。使用者手動開合後就尊重他的選擇，
     不要再被階段切換自動蓋掉 —— 那會讓人覺得介面在跟自己作對。 */
  $('waitFoldBtn').addEventListener('click', ()=>{
    audioOn();
    setFold($('waitFoldBtn').getAttribute('aria-expanded') !== 'true', true);
  });

  /* 等待室內自行校正 —— 雙方都能按，各自校正自己的基準。
     校正約 8.7 秒，期間畫面會切到 #setup，對手完全看不到我在幹嘛，
     所以要先把 calibrating 寫上去讓對方知道。 */
  $('wCalibBtn').addEventListener('click', ()=>{
    audioOn();
    markCalibrating(true);
    hooks.beginCalibration?.(()=> markCalibrating(false));
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
      showErr('網路好像斷了，再按一次試試。');
    }finally{
      $('readyBtn').disabled = false;
    }
  });

  $('waitLeave').addEventListener('click', async ()=>{
    myReady = false; foldPinned = false;
    clearTimeout(calibFlagTimer); calibFlagTimer = null;
    await leaveRoom(); show('home');
  });

  /* 這兩個都要先離開舊房間 —— 那場已經結算完，留著會讓下次回到前景時
     又被接回一個結束的房間。房主離開會順手刪掉整個節點。 */
  $('vsAgain').addEventListener('click', async ()=>{
    myReady = false; lastState = null; foldPinned = false;
    await leaveRoom();
    openLobby();
  });
  $('vsHome').addEventListener('click', async ()=>{
    myReady = false; lastState = null; foldPinned = false;
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
    log('開始失敗：'+(e.message||e));
    showErr('開不了賽，網路可能不穩。再按一次試試。');
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
  /* 對手第一次出現是社交產品的魔法時刻 —— 給聲音與閃光。
     此時相機推論已關閉（等待室不在 INFER_PHASES），可以盡情演出。 */
  if(op && !sawOpponent){
    sawOpponent = true;
    sfx.joined();
    flash(.14, 'var(--cool)');
  }else if(!op){
    sawOpponent = false;      // 對手離開後再回來要能再觸發一次
  }
  $('wOpName').textContent = op?.name || '等待中…';
  vs.opName = op?.name || '對手';

  /* 我自己的準備狀態以 RTDB 為準（換裝置或重連後也正確） */
  myReady = !!v.me?.ready;
  $('wMeState').textContent = v.isHost ? '你（房主）' : (myReady ? '你 · 已準備' : '你');

  if(!op){
    $('wOpState').textContent = v.isHost ? '尚未加入' : '房主不在？';
    $('waitHint').textContent = v.isHost
      ? '把房號給朋友'
      : '按下「我準備好了」';
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
    ? '可自動計數'
    : '未校正 — 需手動計數';
  $('wCalibBtn').textContent = calibrated ? '重新校正' : '校正';
  /* 摺疊起來時要靠摘要知道目前設定，否則收起來等於藏資訊 */
  $('waitFoldSum').textContent =
    modeLabel(currentMode) + ' · ' + (calibrated ? '已校正' : '尚未校正');

  /* --- 對手正在校正 ---
     校正約 8.7 秒，對方畫面已切走、毫無動靜。
     沒有這一列的話，等待方只會覺得「他是不是掛了」。 */
  const peerCalib = !!v.opponentCalibrating;
  $('calibPeer').hidden = !peerCalib;
  if(peerCalib){
    $('peerState').textContent = (op?.name || '對方') + ' 正在校正…';
    /* 給一個大概的終點 —— 有終點的等待跟沒終點的等待是兩回事 */
    $('peerHint').textContent = '大約十秒，等他擺完兩個姿勢';
  }

  /* 未校正而且已經可以開賽時，校正列是唯一還擋著的東西 */
  $('wCalibBar').classList.toggle('urgent', !calibrated && !!op);

  if(v.isHost){
    /* 只有房主能開始（規格第 6.3 節：這同時擋掉亂猜房號的人）。
       對手必須按下準備才能開始 —— 避免手機還在口袋裡就被開賽。 */
    $('readyBtn').hidden = true;
    $('goMatch').hidden = false;
    /* 對方正在校正時也不能開 —— 他的畫面在校正流程裡，
       此時開賽會把人從校正中途拽走，那是實打實的計數錯誤。 */
    const canStart = canHostStart({opponent:op, opponentCalibrating:peerCalib});
    /* 從不能按變成能按時給一次解鎖提示 —— 房主可能正在看手機以外的地方 */
    if(canStart && $('goMatch').disabled) replay($('goMatch'), 'unlocked');
    $('goMatch').disabled = !canStart;
    $('goMatch').textContent = startLabel({opponent:op, opponentCalibrating:peerCalib});
  }else{
    /* 訪客：顯示準備按鈕，不顯示開始鈕 */
    $('goMatch').hidden = true;
    $('readyBtn').hidden = false;
    $('readyBtn').textContent = myReady ? '取消準備' : '我準備好了';
    $('waitNote').textContent = myReady ? '等房主開始' : '';
  }

  /* --- 階段：決定「現在該做的那一件事」是哪一個 ---
     由單一 class 驅動 CSS，而不是逐一控制九個區塊的 hidden。 */
  const phase = waitPhase({isHost:v.isHost, hasOpponent:!!op, meReady:myReady});
  const wait = $('wait');
  for(const p of PHASES) wait.classList.toggle(p, p===phase);
  $('waitHint').textContent = PHASE_HINT[phase];
  /* 沒事可做的階段把設定收起來，有事要確認的階段展開 */
  setFold(phase==='ph-ready' || phase==='ph-guest-set');
  /* 離開房間在「正在等」的階段退到背景，不跟主要動作搶 */
  $('waitLeave').classList.toggle('recede', phase!=='ph-guest-wait');

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
  if(v.result && currentPanel()==='vsresult') paintResult();
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

  /* 倒數期間就把推論打開暖機 —— 從暫停切回推論的第一幀會慢 2–3 倍，
     若等到 GO 才恢復，第一下很可能漏算。 */
  hooks.warmUpInference?.();

  vs.active = true;
  vs.ended = false;
  vs.myReps = 0;
  vs.opReps = v.opponent?.reps || 0;
  vs.timer = alignedTimer(startAt);
  /* 記下寫 Firestore 需要的資料。必須現在抓 ——
     對手可能在結算前離線，那時 v.opponent 就沒了。
     startAt 用「按下開始」的原始時戳（不含倒數），雙方算出同一個 matchId。 */
  vs.opUid = v.opponent?.uid || null;
  vs.code = v.code;
  vs.startAtServer = v.startAt;
  $('vsSyncWarn').hidden = true;      // 上一場的警告不要留到這場

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
    ? '未校正 — 比賽中點畫面計數'
    : '回到起始姿勢';

  /* 用校正後的時間跑倒數，雙方畫面同步 */
  let shownN = -1;
  const tick = ()=>{
    const left = msUntil(startAt);
    if(left <= 0){
      showCountdown('GO');
      flash(.28);
      sfx.go();
      /* GO 顯示完才切畫面並清掉巨大字樣式（否則校正提示會變成巨大字） */
      beginVsMatch();
      setTimeout(clearCountdown, 400);
      return;
    }
    const n = Math.ceil(left/1000);
    /* 同一個數字不重播動畫 —— tick 的間隔算出來可能小於 1 秒 */
    if(n !== shownN){ shownN = n; showCountdown(n); sfx.tick(); }
    setTimeout(tick, Math.min(1000, left - (n-1)*1000 || 1000));
  };
  tick();
}

function beginVsMatch(){
  $('vsLive').hidden = false;
  $('vsLiveName').textContent = vs.opName;
  shownOpReps = -1;          // 讓開場第一次更新也會 pulse
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

let shownOpReps = -1;
function updateVsLive(){
  const el = $('vsLiveReps');
  /* 只有數字真的變了才 pulse —— 這個函式每幀都會被叫到，
     每幀重播動畫等於常駐動畫，違反「計數中不允許常駐動畫」。 */
  if(vs.opReps !== shownOpReps){
    /* 對手加分時給一聲低音撥弦。使用者趴著看不到畫面，
       聽覺是唯一能讓他知道「被追了」的頻道（規格第 7 節）。
       開場的初始化不發聲，否則一進場就叭一下。 */
    if(shownOpReps >= 0 && vs.opReps > shownOpReps) sfx.oppRep();
    shownOpReps = vs.opReps;
    el.textContent = vs.opReps;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
  const d = vs.myReps - vs.opReps;
  const gap = $('vsLiveGap');
  gap.classList.toggle('lead', d>0);
  gap.classList.toggle('behind', d<0);
  gap.textContent = d>0 ? `領先 ${d} 下` : d<0 ? `落後 ${-d} 下` : '平手';
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

  /* 長期紀錄寫進 Firestore。放在 UI 之後不阻擋畫面，
     但要在 leaveRoom 之前 —— 需要房號與雙方身分。 */
  persistMatch(myReps).catch(e=> log('紀錄失敗：'+(e.message||e).toString().slice(0,70)));

  showVsResult();
}

/**
 * 把這場寫進 Firestore（matches + 自己的 stats）。
 *
 * 雙方都會呼叫，靠 matchId 去重（誰先到算誰的）。
 * stats 各自更新自己的 —— 規則只允許本人寫自己的 stats。
 */
async function persistMatch(myReps){
  const me = meIdentity();
  if(!me || !vs.opUid) return;          // 沒登入或抓不到對手身分就跳過

  const iAmHost = isHost();
  const meSide = { uid:me.uid, name:me.name, reps:myReps };
  const opSide = { uid:vs.opUid, name:vs.opName, reps:vs.opReps };
  /* a/b 依 host/guest 固定，讓雙方寫出的內容一致 */
  const a = iAmHost ? meSide : opSide;
  const b = iAmHost ? opSide : meSide;

  const rec = await recordMatch({
    code: vs.code || getCode(),
    startAt: vs.startAtServer,
    durationSec: vs.durationSec,
    a, b,
  });

  const outcome = myReps > vs.opReps ? 'win' : myReps < vs.opReps ? 'loss' : 'draw';
  const next = await applyMatchStats(me.uid, myReps, outcome);
  if(next) log(`戰績更新：${next.wins}勝${next.losses}敗${next.draws}平`);

  /* 紀錄真的沒寫成功時要讓使用者知道 —— 戰績是這個 App 的核心價值，
     悄悄遺失比顯示一行小字糟糕得多。不用擋畫面，結算照常顯示。 */
  const lost = rec === 'failed' || !next;
  $('vsSyncWarn').hidden = !lost;
  /* 讓首頁的統計立刻反映新數字 */
  refreshProfile().catch(()=>{});
}

function onDone(){ if(vs.active) showVsResult(); }

function showVsResult(){
  vs.active = false;
  $('vsLive').hidden = true;
  paintResult();
  show('vsresult');
  sfx.end();
}

function paintResult(){
  const my = vs.myReps, op = vs.opReps;
  const won = my>op, lost = my<op;

  $('vsMeName').textContent = '你';
  $('vsOpName').textContent = vs.opName;
  $('vsVerdictCap').textContent = `${my} : ${op}`;

  /* 判定用形態區分而非顏色（見 css 的說明）。
     三種狀態互斥，先清乾淨再加，避免連續兩場殘留上一場的 class。 */
  const el = $('vsVerdict');
  el.textContent = won ? '贏了' : lost ? '輸了' : '平手';
  el.classList.remove('won','lost','tied');
  void el.offsetWidth;
  el.classList.add(won ? 'won' : lost ? 'lost' : 'tied');

  /* 比分滾動。雙方同時跑，勝方的音階往上、敗方不配音（安靜比噪音有份量）。 */
  rollNumber('vsMeReps', my, 620, won ? (n=>{ if(n%2===0) sfx.rep(n||1); }) : undefined);
  rollNumber('vsOpReps', op, 620);

  if(won){
    /* 全螢幕反相一次 —— 相機已關閉，這是最便宜的大場面 */
    replay($('stage'), 'invert');
    sfx.win();
  }else if(lost){
    sfx.lose();
  }else{
    sfx.draw();
  }
}

function endVersus(){
  vs.active = false;
  $('vsLive').hidden = true;
  hooks.abortRun?.();
}
