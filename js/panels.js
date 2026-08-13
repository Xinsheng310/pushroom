/* 週邊面板 — 免責同意、帳號、戰績、暱稱

   這四塊有個共通點：都不在計數的路徑上。
   它們各自是一個獨立的畫面，開啟、做完一件事、回首頁，
   彼此之間沒有共用狀態，跟主迴圈也沒有關係。
   放在 main.js 只會讓真正要緊的那條路（相機 → 推論 → 計數）更難讀。 */

import { showErr } from './log.js';
import { audioOn } from './audio.js';
import { $, show, renderMatchList } from './ui.js';
import { isReady } from './firebase.js';
import {
  onAuthChange, signOut, setDisplayName, validName, usingDefaultName,
  getProfile, getUser, NAME_MAX,
} from './auth.js';
import { listMyMatches, outcomeFor } from './matches.js';

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
export function requireConsent(next){
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
/* Firebase 沒就緒時 main.js 也要叫一次（傳 null），
   讓帳號區與對戰入口維持隱藏、退回純單機體驗。 */
export function renderAccount(user, prof){
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
  try{ await signOut(); }
  catch(e){ showErr('登出沒成功，重新整理頁面即可。'); }
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
  const w = s.wins ?? 0, l = s.losses ?? 0, d = s.draws ?? 0;
  $('hStatsLine').textContent = `${w}勝 ${l}敗 ${d}平`;
  /* 大字底下給一句人話。純數字不會告訴你「這算好還是不好」。 */
  const played = w + l + d;
  $('hRecordSub').textContent = !played
    ? '還沒有對戰紀錄'
    : (w > l ? '勝多敗少' : w < l ? '再練練' : '勢均力敵');
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
export function openNamePanel(){
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

