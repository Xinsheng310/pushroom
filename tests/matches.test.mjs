/* 對戰紀錄測試（規格第 4.2、5 節）

   核心保證：雙方各自算出的 matchId 必須完全相同。
   規則是 create-only，同一 id 只能寫一次 —— 靠這個達成
   「誰先到算誰的、資料不重複」，讓房主結算瞬間斷線時訪客能補寫。
   若 matchId 不一致，同一場會變兩筆，戰績就會重複計算。

   matches.js 依賴 firebase.js（會 import CDN），Node 無法載入 getSdk 相關的部分，
   但 makeMatchId 與 outcomeFor 是純函式，可以直接測。 */

globalThis.document = { getElementById: ()=>null };
globalThis.window = {};

const { makeMatchId, outcomeFor } = await import('../js/matches.js');

let pass=0, fail=0;
const check=(name,ok,detail='')=>{
  if(ok){ pass++; console.log('  ✓ '+name); }
  else  { fail++; console.log('  ✗ '+name+(detail?'  ← '+detail:'')); }
};

const A = 'pi7O4sbeX3d1xnMYxjXrMKikpEs2';
const B = '6jl0gzDWhqVnqyREXqQIS7tg0lY2';
const CODE = 'K7M2', TS = 1786615384236;

/* ================= matchId 一致性 ================= */
console.log('\n=== matchId：雙方必須算出同一個 ===');
const idHost  = makeMatchId(A, B, CODE, TS);   // 房主視角：a=我, b=對手
const idGuest = makeMatchId(B, A, CODE, TS);   // 訪客視角：參數順序相反
check('★ 房主與訪客算出完全相同的 id', idHost===idGuest, `${idHost} vs ${idGuest}`);
check('id 不含空白或斜線（Firestore doc id 限制）',
      !/[\s/]/.test(idHost), idHost);
check('id 長度合理（<1500 bytes）', idHost.length < 200, String(idHost.length));

console.log('\n=== 不同場次必須有不同 id ===');
check('不同房號 → 不同 id', makeMatchId(A,B,'AAAA',TS)!==makeMatchId(A,B,'BBBB',TS));
check('不同時間 → 不同 id', makeMatchId(A,B,CODE,TS)!==makeMatchId(A,B,CODE,TS+1));
check('不同對手 → 不同 id', makeMatchId(A,B,CODE,TS)!==makeMatchId(A,'other',CODE,TS));
check('★ 同一組人再打一場（時間不同）→ 不同 id，不會被去重掉',
      makeMatchId(A,B,CODE,TS)!==makeMatchId(A,B,CODE,TS+60000));

console.log('\n=== 穩定性 ===');
check('同參數重複呼叫結果一致', makeMatchId(A,B,CODE,TS)===makeMatchId(A,B,CODE,TS));
/* uid 只取前 10 碼，要確認不會讓不同的人撞到同一個 id。
   Firebase uid 是 28 碼隨機字串，前 10 碼碰撞機率極低，
   但仍要確認「前 10 碼相同、後面不同」的兩個 uid 會被視為同一人 —— 這是已知取捨。 */
const sameHead = A.slice(0,10)+'ZZZZZZZZZZZZZZZZZZ';
check('前 10 碼相同的 uid 會產生同 id（已知取捨，實際碰撞機率極低）',
      makeMatchId(A,B,CODE,TS)===makeMatchId(sameHead,B,CODE,TS));

/* ================= 勝負判定 ================= */
console.log('\n=== 從我的視角判斷勝負 ===');
const mk = (winner)=>({ a:{uid:A}, b:{uid:B}, winner });
check('我是 a 且 winner=a → 勝', outcomeFor(A, mk('a'))==='win');
check('我是 a 且 winner=b → 敗', outcomeFor(A, mk('b'))==='loss');
check('我是 b 且 winner=b → 勝', outcomeFor(B, mk('b'))==='win');
check('我是 b 且 winner=a → 敗', outcomeFor(B, mk('a'))==='loss');
check('平手 → draw（不論我是誰）',
      outcomeFor(A, mk('draw'))==='draw' && outcomeFor(B, mk('draw'))==='draw');
check('match 為 null → draw（不當成勝或敗）', outcomeFor(A, null)==='draw');

/* 對雙方而言結果必須互補，不能兩人都贏 */
console.log('\n=== 結果互補性 ===');
for(const w of ['a','b']){
  const m = mk(w);
  const oa = outcomeFor(A,m), ob = outcomeFor(B,m);
  check(`winner=${w}：一勝一敗，不會兩人都贏`,
        (oa==='win'&&ob==='loss')||(oa==='loss'&&ob==='win'), `${oa}/${ob}`);
}

/* ================= 統計累加邏輯 ================= */
console.log('\n=== 統計累加（與 applyMatchStats 同邏輯）===');
const accum = (cur, reps, outcome)=>({
  totalReps:   (cur.totalReps||0) + Math.max(0,Math.floor(reps)),
  bestSession: Math.max(cur.bestSession||0, Math.max(0,Math.floor(reps))),
  wins:   (cur.wins||0)   + (outcome==='win'  ?1:0),
  losses: (cur.losses||0) + (outcome==='loss' ?1:0),
  draws:  (cur.draws||0)  + (outcome==='draw' ?1:0),
  matches:(cur.matches||0)+ 1,
});
let s = { totalReps:0,bestSession:0,wins:0,losses:0,draws:0,matches:0 };
s = accum(s, 20, 'win');
check('第一場勝：20 下', s.totalReps===20 && s.wins===1 && s.matches===1);
s = accum(s, 15, 'loss');
check('第二場敗：累計 35、最佳仍 20', s.totalReps===35 && s.bestSession===20 && s.losses===1);
s = accum(s, 31, 'draw');
check('第三場平：最佳更新為 31', s.bestSession===31 && s.draws===1 && s.matches===3);
check('勝敗平總和等於場數', s.wins+s.losses+s.draws===s.matches);
s = accum(s, -5, 'win');
check('負數次數不會扣分（夾在 0）', s.totalReps===66, String(s.totalReps));
s = accum(s, 2.7, 'win');
check('小數次數取整（不會產生小數統計）', Number.isInteger(s.totalReps), String(s.totalReps));

console.log(`\n${fail===0?'全部通過':'有 '+fail+' 項失敗'}（${pass} 通過 / ${fail} 失敗）`);
process.exit(fail===0?0:1);
