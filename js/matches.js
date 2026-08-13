/* 對戰紀錄與勝敗統計（Firestore）

   資料模型見 PUSHROOM_BUILD_SPEC.md 第 4.2 節。

   matchId 的設計：兩人 uid 排序後組合 + 房號 + 開賽時間戳。
   排序是為了讓雙方算出「完全相同」的 id —— 規格第 5 節的規則是
   create-only，同一個 id 只能建立一次，所以誰先寫誰算，資料不會重複。
   這樣房主在結算瞬間斷線時，訪客還能把紀錄補上（規格第 6.4 節說斷線是常態）。

   stats 為什麼由客戶端自己累加：規格第 5 節「stats 只能由本人寫入」，
   且第 13 節明確不加伺服器端驗證（「朋友之間玩，社交壓力就是約束」）。 */

import { log } from './log.js';
import { isReady, getDb, getSdk } from './firebase.js';

/**
 * 產生雙方一致的 matchId。
 * @param {string} uidA
 * @param {string} uidB
 * @param {string} code 房號
 * @param {number} startAt 開賽的伺服器時間戳
 */
export function makeMatchId(uidA, uidB, code, startAt){
  /* 排序讓雙方得到同一個字串，不論誰是 host。
     uid 取前 10 碼就夠區分且不會讓 id 過長。 */
  const [x, y] = [uidA, uidB].sort();
  return `${x.slice(0,10)}_${y.slice(0,10)}_${code}_${startAt}`;
}

/**
 * 寫入一場比賽紀錄。同一場只會成功一次（規則 create-only）。
 *
 * @param {Object} m
 * @param {string} m.code 房號
 * @param {number} m.startAt 開賽伺服器時間戳
 * @param {number} m.durationSec
 * @param {{uid:string,name:string,reps:number}} m.a
 * @param {{uid:string,name:string,reps:number}} m.b
 * @returns {Promise<'created'|'exists'|'skipped'>}
 */
export async function recordMatch({code, startAt, durationSec, a, b}){
  if(!isReady()) return 'skipped';
  if(!a?.uid || !b?.uid || a.uid===b.uid) return 'skipped';

  const { store: S } = getSdk();
  const id = makeMatchId(a.uid, b.uid, code, startAt);

  const winner = a.reps > b.reps ? 'a' : b.reps > a.reps ? 'b' : 'draw';
  const doc = {
    /* players 供 array-contains 查詢（規格第 4.2 節），
       順序必須與 a/b 一致 —— 規則會比對這件事 */
    players: [a.uid, b.uid],
    a: { uid:a.uid, name:a.name, reps:a.reps },
    b: { uid:b.uid, name:b.name, reps:b.reps },
    durationSec: Math.max(1, Math.floor(durationSec)),
    winner,
    playedAt: S.serverTimestamp(),
  };

  try{
    /* setDoc 而非 addDoc —— 我們要固定的 id 才能讓雙方寫同一筆。
       規則不允許 update，所以第二個寫入的人會失敗，那是預期行為。 */
    await S.setDoc(S.doc(getDb(),'matches',id), doc);
    log('比賽紀錄已寫入');
    return 'created';
  }catch(e){
    /* 對方先寫了。不是錯誤。 */
    log('比賽紀錄已由對方寫入');
    return 'exists';
  }
}

/**
 * 更新自己的勝敗統計。
 *
 * 用 Firestore transaction 讀後再寫，避免「單機練習剛好同時寫入」造成的
 * 數字覆蓋。規則限定只有本人能改自己的 stats。
 *
 * @param {string} uid
 * @param {number} myReps
 * @param {'win'|'loss'|'draw'} outcome
 * @returns {Promise<Object|null>} 更新後的 stats
 */
export async function applyMatchStats(uid, myReps, outcome){
  if(!isReady() || !uid) return null;
  const { store: S } = getSdk();
  const ref = S.doc(getDb(),'users',uid);

  try{
    return await S.runTransaction(getDb(), async tx=>{
      const snap = await tx.get(ref);
      if(!snap.exists()) return null;
      const cur = snap.data().stats || {};
      const next = {
        totalReps:   (cur.totalReps   || 0) + Math.max(0, Math.floor(myReps)),
        bestSession: Math.max(cur.bestSession || 0, Math.max(0, Math.floor(myReps))),
        wins:        (cur.wins   || 0) + (outcome==='win'  ? 1 : 0),
        losses:      (cur.losses || 0) + (outcome==='loss' ? 1 : 0),
        draws:       (cur.draws  || 0) + (outcome==='draw' ? 1 : 0),
        matches:     (cur.matches|| 0) + 1,
      };
      tx.update(ref, { stats: next });
      return next;
    });
  }catch(e){
    log('戰績更新失敗：'+(e.message||e).toString().slice(0,80));
    return null;
  }
}

/** 我的比賽紀錄，最近的在前。 */
export async function listMyMatches(uid, limit=20){
  if(!isReady() || !uid) return [];
  const { store: S } = getSdk();
  try{
    const q = S.query(
      S.collection(getDb(),'matches'),
      S.where('players','array-contains',uid),
      S.orderBy('playedAt','desc'),
      S.limit(limit),
    );
    const snap = await S.getDocs(q);
    return snap.docs.map(d=>({ id:d.id, ...d.data() }));
  }catch(e){
    /* 缺索引時 Firestore 會回錯，訊息裡含建立索引的連結 */
    log('讀取比賽紀錄失敗：'+(e.message||e).toString().slice(0,110));
    return [];
  }
}

/** 從我的視角判斷勝負 */
export function outcomeFor(uid, match){
  if(!match) return 'draw';
  if(match.winner==='draw') return 'draw';
  const iAmA = match.a?.uid === uid;
  const iWon = (match.winner==='a' && iAmA) || (match.winner==='b' && !iAmA);
  return iWon ? 'win' : 'loss';
}
