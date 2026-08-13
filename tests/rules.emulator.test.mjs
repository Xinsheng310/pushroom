/* 安全規則的行為驗證（需要 Firebase emulator + Java）

   靜態檢查（tests/rules.test.mjs）只確認規則檔的條件字串存在，
   這支才真的去「試著攻擊」規則，驗證該擋的有擋、該過的有過。

   執行方式：
     npm install --no-save @firebase/rules-unit-testing firebase
     firebase emulators:exec --only firestore,database "node tests/rules.emulator.test.mjs"

   需要先安裝 Java（emulator 的執行環境）與 firebase-tools：
     npm install -g firebase-tools

   規格第 5 節的每條約束在下面都有對應的 test。 */

/* 相依套件沒裝就明確說明並跳過，而不是丟一個看不懂的 import 錯誤 */
let rut;
try{
  rut = await import('@firebase/rules-unit-testing');
}catch(e){
  console.log('略過：需要 emulator 環境。安裝方式：');
  console.log('  npm install -g firebase-tools');
  console.log('  npm install --no-save @firebase/rules-unit-testing firebase');
  console.log('  firebase emulators:exec --only firestore,database "node tests/rules.emulator.test.mjs"');
  console.log('（emulator 需要 Java）');
  process.exit(0);
}
const { initializeTestEnvironment, assertFails, assertSucceeds } = rut;
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const { doc, setDoc, getDoc, updateDoc, deleteDoc, Timestamp } = await import('firebase/firestore');
const { ref, set, get } = await import('firebase/database');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const ALICE = 'uid_alice', BOB = 'uid_bob', EVE = 'uid_eve';

const env = await initializeTestEnvironment({
  projectId: 'reproom-rules-test',
  firestore: { rules: readFileSync(join(root,'firestore.rules'),'utf8') },
  database:  { rules: readFileSync(join(root,'database.rules.json'),'utf8') },
});

let pass = 0, fail = 0;
async function it(name, fn){
  try { await fn(); pass++; console.log('  ✓ '+name); }
  catch(e){ fail++; console.log('  ✗ '+name+'\n      '+(e.message||e).split('\n')[0]); }
}

const mkUser = (over={}) => ({
  displayName:'測試員', photoURL:'', createdAt: Timestamp.now(),
  stats:{ totalReps:0, bestSession:0, wins:0, losses:0, draws:0, matches:0 },
  ...over,
});

const mkMatch = (aUid, bUid, aReps, bReps, over={}) => ({
  players:[aUid,bUid],
  a:{ uid:aUid, name:'A', reps:aReps },
  b:{ uid:bUid, name:'B', reps:bReps },
  durationSec:60,
  winner: aReps>bReps ? 'a' : bReps>aReps ? 'b' : 'draw',
  playedAt: Timestamp.now(),
  ...over,
});

/* ================= Firestore: users ================= */
console.log('\n=== Firestore users ===');
{
  const alice = env.authenticatedContext(ALICE).firestore();
  const eve   = env.authenticatedContext(EVE).firestore();
  const anon  = env.unauthenticatedContext().firestore();

  await it('本人可建立自己的 user', ()=>
    assertSucceeds(setDoc(doc(alice,'users',ALICE), mkUser())));

  await it('未登入者不可建立', ()=>
    assertFails(setDoc(doc(anon,'users','uid_x'), mkUser())));

  await it('不可建立別人的 user', ()=>
    assertFails(setDoc(doc(eve,'users',ALICE), mkUser())));

  await it('不可寫入 email 欄位', ()=>
    assertFails(setDoc(doc(alice,'users',ALICE), mkUser({email:'a@b.c'}))));

  await it('暱稱不可超過 20 字', ()=>
    assertFails(setDoc(doc(alice,'users',ALICE), mkUser({displayName:'x'.repeat(21)}))));

  await it('暱稱不可為空', ()=>
    assertFails(setDoc(doc(alice,'users',ALICE), mkUser({displayName:''}))));

  await it('stats 不可為負數', ()=>
    assertFails(setDoc(doc(alice,'users',ALICE),
      mkUser({stats:{totalReps:-1,bestSession:0,wins:0,losses:0,draws:0,matches:0}}))));

  await it('stats 不可是小數', ()=>
    assertFails(setDoc(doc(alice,'users',ALICE),
      mkUser({stats:{totalReps:1.5,bestSession:0,wins:0,losses:0,draws:0,matches:0}}))));

  await it('別人不可改我的 stats（規格第 5 節）', ()=>
    assertFails(updateDoc(doc(eve,'users',ALICE),
      {stats:{totalReps:9999,bestSession:0,wins:0,losses:0,draws:0,matches:0}})));

  await it('已登入者可讀他人資料（對戰需看對手暱稱）', ()=>
    assertSucceeds(getDoc(doc(eve,'users',ALICE))));

  await it('未登入者不可讀', ()=>
    assertFails(getDoc(doc(anon,'users',ALICE))));

  await it('不可刪除 user', ()=>
    assertFails(deleteDoc(doc(alice,'users',ALICE))));
}

/* ================= Firestore: matches ================= */
console.log('\n=== Firestore matches ===');
{
  const alice = env.authenticatedContext(ALICE).firestore();
  const bob   = env.authenticatedContext(BOB).firestore();
  const eve   = env.authenticatedContext(EVE).firestore();

  await it('參與者可建立比賽紀錄', ()=>
    assertSucceeds(setDoc(doc(alice,'matches','m1'), mkMatch(ALICE,BOB,20,15))));

  await it('訪客也可建立（房主斷線時代寫）', ()=>
    assertSucceeds(setDoc(doc(bob,'matches','m2'), mkMatch(ALICE,BOB,10,12))));

  await it('非參與者不可建立', ()=>
    assertFails(setDoc(doc(eve,'matches','m3'), mkMatch(ALICE,BOB,20,15))));

  await it('不可把自己塞進 players 偽造參與（players 與 a/b 不符）', ()=>
    assertFails(setDoc(doc(eve,'matches','m4'),
      mkMatch(ALICE,BOB,20,15,{players:[EVE,ALICE]}))));

  await it('不可自己跟自己打（刷勝場）', ()=>
    assertFails(setDoc(doc(alice,'matches','m5'), mkMatch(ALICE,ALICE,20,10))));

  await it('winner 與次數不符要被擋（贏家次數較少）', ()=>
    assertFails(setDoc(doc(alice,'matches','m6'),
      mkMatch(ALICE,BOB,10,20,{winner:'a'}))));

  await it('平手但標記有勝者要被擋', ()=>
    assertFails(setDoc(doc(alice,'matches','m7'),
      mkMatch(ALICE,BOB,10,10,{winner:'a'}))));

  await it('reps 不可為負', ()=>
    assertFails(setDoc(doc(alice,'matches','m8'), mkMatch(ALICE,BOB,-5,10))));

  await it('已建立的比賽不可修改', ()=>
    assertFails(updateDoc(doc(alice,'matches','m1'), {'a.reps':999})));

  await it('已建立的比賽不可刪除', ()=>
    assertFails(deleteDoc(doc(alice,'matches','m1'))));

  await it('同一 matchId 不可重複建立（房主與訪客都寫時，後者失敗）', ()=>
    assertFails(setDoc(doc(bob,'matches','m1'), mkMatch(ALICE,BOB,20,15))));

  await it('參與者可讀自己的比賽', ()=>
    assertSucceeds(getDoc(doc(bob,'matches','m1'))));

  await it('非參與者不可讀別人的比賽', ()=>
    assertFails(getDoc(doc(eve,'matches','m1'))));
}

/* ================= RTDB: rooms ================= */
console.log('\n=== RTDB rooms ===');
{
  const alice = env.authenticatedContext(ALICE).database();
  const bob   = env.authenticatedContext(BOB).database();
  const eve   = env.authenticatedContext(EVE).database();
  const anon  = env.unauthenticatedContext().database();

  const side = (uid,name,reps=0) => ({uid,name,online:true,reps,ready:false});

  await it('房主可佔用 host 位', ()=>
    assertSucceeds(set(ref(alice,'rooms/AB23/host'), side(ALICE,'Alice'))));

  await it('訪客可佔用 guest 位', ()=>
    assertSucceeds(set(ref(bob,'rooms/AB23/guest'), side(BOB,'Bob'))));

  await it('不可用別人的 uid 佔位', ()=>
    assertFails(set(ref(eve,'rooms/AB23/guest2'), side(ALICE,'假的'))));

  await it('★ 任何人不得寫入他人的 reps（規格第 5 節）', ()=>
    assertFails(set(ref(eve,'rooms/AB23/host/reps'), 999)));

  await it('★ 對手不得改我的 reps', ()=>
    assertFails(set(ref(bob,'rooms/AB23/host/reps'), 0)));

  await it('本人可更新自己的 reps', ()=>
    assertSucceeds(set(ref(alice,'rooms/AB23/host/reps'), 12)));

  await it('reps 不可為負', ()=>
    assertFails(set(ref(alice,'rooms/AB23/host/reps'), -1)));

  await it('reps 不可是小數', ()=>
    assertFails(set(ref(alice,'rooms/AB23/host/reps'), 1.5)));

  await it('reps 不可是字串', ()=>
    assertFails(set(ref(alice,'rooms/AB23/host/reps'), '999')));

  await it('房號含排除字元（0 O 1 I L）要被擋', ()=>
    assertFails(set(ref(alice,'rooms/AB0I/host'), side(ALICE,'Alice'))));

  await it('房號長度不對要被擋', ()=>
    assertFails(set(ref(alice,'rooms/AB2/host'), side(ALICE,'Alice'))));

  await it('★ 只有房主能推進 state', ()=>
    assertFails(set(ref(bob,'rooms/AB23/state'), 'live')));

  await it('房主可推進 state', ()=>
    assertSucceeds(set(ref(alice,'rooms/AB23/state'), 'counting')));

  await it('state 不接受未知值', ()=>
    assertFails(set(ref(alice,'rooms/AB23/state'), 'hacked')));

  await it('★ startAt 必須是伺服器時間戳，不可塞假時間（規格第 6.5 節）', ()=>
    assertFails(set(ref(alice,'rooms/AB23/startAt'), Date.now()+999999)));

  await it('訪客不可寫 startAt', ()=>
    assertFails(set(ref(bob,'rooms/AB23/startAt'), {'.sv':'timestamp'})));

  await it('房主可寫 startAt（伺服器時間戳）', ()=>
    assertSucceeds(set(ref(alice,'rooms/AB23/startAt'), {'.sv':'timestamp'})));

  await it('未登入者不可讀房間', ()=>
    assertFails(get(ref(anon,'rooms/AB23'))));

  await it('已登入者可讀房間', ()=>
    assertSucceeds(get(ref(alice,'rooms/AB23'))));

  await it('未知子節點要被擋', ()=>
    assertFails(set(ref(alice,'rooms/AB23/backdoor'), 'x')));

  await it('無法一次覆寫整個房間（房間層無 .write）', ()=>
    assertFails(set(ref(eve,'rooms/AB23'), {host:side(EVE,'Eve')})));

  await it('result 可由參與者寫入', ()=>
    assertSucceeds(set(ref(alice,'rooms/AB23/result'),
      {hostReps:12,guestReps:8,winner:'host'})));

  await it('result 寫入後不可再改', ()=>
    assertFails(set(ref(alice,'rooms/AB23/result'),
      {hostReps:99,guestReps:0,winner:'host'})));

  await it('非參與者不可寫 result', ()=>
    assertFails(set(ref(eve,'rooms/CD45/result'),
      {hostReps:1,guestReps:0,winner:'host'})));
}

await env.cleanup();
console.log(`\n${fail===0 ? '全部通過' : '有 '+fail+' 項失敗'}（${pass} 通過 / ${fail} 失敗）`);
process.exit(fail===0?0:1);
