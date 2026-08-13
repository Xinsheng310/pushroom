/* Google 登入 + 使用者資料

   規格第 4.2 節：users/{uid} 不儲存 email。
   顯示名稱由使用者自訂，不要直接沿用 Google 帳號的真實姓名。

   所以首次登入時「不」把 Google 的 displayName 寫進去 ——
   而是給一個中性的預設暱稱，讓使用者自己改。
   把真實姓名當預設值等於預設洩漏真名給對手。 */

import { log } from './log.js';
import { isReady, getAuth, getDb, getSdk } from './firebase.js';

export const NAME_MAX = 20;
const DEFAULT_NAME = '匿名選手';

let currentUser = null;     // Firebase user 物件
let profile = null;         // users/{uid} 的內容
const listeners = new Set();

export const getUser = () => currentUser;
export const getProfile = () => profile;
export const isSignedIn = () => !!currentUser;

/** 訂閱登入狀態變化。回傳取消訂閱函式。 */
export function onAuthChange(fn){
  listeners.add(fn);
  fn(currentUser, profile);
  return ()=> listeners.delete(fn);
}
const emit = ()=> listeners.forEach(fn=>{
  try{ fn(currentUser, profile); }catch(e){ log('auth listener 錯誤：'+e.message); }
});

/** 暱稱驗證，與安全規則的條件一致（1–20 字） */
export function validName(name){
  const n = (name||'').trim();
  return n.length >= 1 && n.length <= NAME_MAX;
}

const emptyStats = ()=>({
  totalReps:0, bestSession:0, wins:0, losses:0, draws:0, matches:0,
});

/* ============ 監聽登入狀態 ============ */
export function watchAuth(){
  if(!isReady()) return;
  const { auth: A } = getSdk();

  /* 轉址登入回來後要收結果，否則使用者會覺得「按了沒反應」。
     沒有進行過轉址時這裡回傳 null，不影響一般情況。 */
  A.getRedirectResult(getAuth()).catch(e=>{
    if(e.code!=='auth/no-auth-event') log('轉址登入結果：'+(e.message||e).toString().slice(0,90));
  });

  A.onAuthStateChanged(getAuth(), async user=>{
    currentUser = user;
    profile = null;
    if(user){
      log('已登入 uid='+user.uid.slice(0,8)+'…');
      try{ profile = await loadOrCreateProfile(user); }
      catch(e){ log('讀取個人資料失敗：'+(e.message||e).toString().slice(0,90)); }
    }else{
      log('未登入');
    }
    emit();
  });
}

/* ============ 登入 / 登出 ============ */
export async function signIn(){
  if(!isReady()) throw new Error('Firebase 未就緒');
  const { auth: A } = getSdk();
  const provider = new A.GoogleAuthProvider();
  /* 每次都讓使用者選帳號，避免多帳號的人被自動登入到不想用的那個 */
  provider.setCustomParameters({ prompt:'select_account' });
  try{
    await A.signInWithPopup(getAuth(), provider);
  }catch(e){
    /* 彈窗被擋（iOS 常見）就改用轉址 */
    if(e.code==='auth/popup-blocked' || e.code==='auth/operation-not-supported-in-this-environment'){
      log('彈窗被擋，改用轉址登入');
      await A.signInWithRedirect(getAuth(), provider);
      return;
    }
    if(e.code==='auth/popup-closed-by-user' || e.code==='auth/cancelled-popup-request'){
      log('使用者取消登入');
      return;
    }
    if(e.code==='auth/unauthorized-domain'){
      throw new Error('這個網域沒有被 Firebase 授權。到 Authentication → Settings → 授權網域加入 '+location.hostname);
    }
    throw e;
  }
}

export async function signOut(){
  if(!isReady()) return;
  const { auth: A } = getSdk();
  await A.signOut(getAuth());
}

/* ============ users/{uid} ============ */
async function loadOrCreateProfile(user){
  const { store: S } = getSdk();
  const refDoc = S.doc(getDb(), 'users', user.uid);
  const snap = await S.getDoc(refDoc);

  if(snap.exists()) return snap.data();

  /* 首次登入。
     刻意不用 user.displayName（Google 真實姓名）當預設暱稱 —— 規格第 4.2 節。
     photoURL 也不沿用：那是 Google 帳號頭像，同樣算個人資料。 */
  const fresh = {
    displayName: DEFAULT_NAME,
    photoURL: '',
    createdAt: S.serverTimestamp(),
    stats: emptyStats(),
  };
  await S.setDoc(refDoc, fresh);
  log('建立個人資料，預設暱稱：'+DEFAULT_NAME);
  return fresh;
}

/** 更新暱稱。回傳更新後的 profile。 */
export async function setDisplayName(name){
  if(!isReady() || !currentUser) throw new Error('尚未登入');
  const n = (name||'').trim();
  if(!validName(n)) throw new Error('暱稱要 1 到 '+NAME_MAX+' 個字');

  const { store: S } = getSdk();
  await S.updateDoc(S.doc(getDb(),'users',currentUser.uid), { displayName:n });
  profile = { ...profile, displayName:n };
  log('暱稱更新為 '+n);
  emit();
  return profile;
}

/** 使用者是否還在用預設暱稱（用來提示他去改） */
export const usingDefaultName = ()=> profile?.displayName === DEFAULT_NAME;

/* ============ 戰績累加 ============ */
/**
 * 單機練習結束後累加個人統計。
 * 規格第 5 節：stats 只能由本人寫入，所以這是客戶端自己算自己的。
 * @param {number} reps 本次次數
 */
export async function addSession(reps){
  if(!isReady() || !currentUser || !profile) return;
  if(!Number.isInteger(reps) || reps < 0) return;
  const { store: S } = getSdk();
  const next = {
    ...profile.stats,
    totalReps: profile.stats.totalReps + reps,
    bestSession: Math.max(profile.stats.bestSession, reps),
  };
  try{
    await S.updateDoc(S.doc(getDb(),'users',currentUser.uid), { stats: next });
    profile = { ...profile, stats: next };
    emit();
  }catch(e){
    log('戰績寫入失敗：'+(e.message||e).toString().slice(0,90));
  }
}
