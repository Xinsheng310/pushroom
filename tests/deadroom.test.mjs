/* 死房間判斷測試（規格第 6.4 節）

   起因：使用者手機關掉畫面再打開，被接回一場早就打完的比賽。
   實際資料庫裡的狀態是：
     state:"counting"、result 已寫入、雙方 online:false 且離線超過 5 分鐘
   —— 房間沒被清掉，重連時也沒檢查有效性。

   room.js 依賴 firebase.js（會 import CDN），Node 無法載入，
   所以這裡以相同邏輯重新實作 roomIsDead 驗證。改動任一邊都要同步。 */

const GRACE_MS = 30000;

let pass=0, fail=0;
const check=(name,ok,detail='')=>{
  if(ok){ pass++; console.log('  ✓ '+name); }
  else  { fail++; console.log('  ✗ '+name+(detail?'  ← '+detail:'')); }
};

/* --- 與 room.js 同邏輯 --- */
let NOW = 1786615999000;
function seatExpired(side){
  if(!side) return true;
  if(side.online) return false;
  if(!side.leftAt) return false;
  return NOW - side.leftAt > GRACE_MS;
}
function roomIsDead(d){
  if(!d) return true;
  if(d.result) return true;
  if(d.state === 'done') return true;
  const h = d.host, g = d.guest;
  if(!h) return true;
  if(!seatExpired(h)) return false;
  return !g || seatExpired(g);
}

const online  = (uid='u1') => ({uid, online:true, reps:0, ready:false});
const offline = (uid='u1', ago=60000) => ({uid, online:false, reps:0, ready:false, leftAt:NOW-ago});

/* ================= 使用者實際遇到的情況 ================= */
console.log('\n=== 使用者回報的實際資料 ===');
const REAL = {
  calibMode:'standard',
  config:{createdAt:1786615331837, durationSec:60},
  countdownSec:3,
  guest:{leftAt:1786615683185, name:'帥帥', online:false, ready:true, reps:0, uid:'6jl0'},
  host:{leftAt:1786615472301, name:'匿名選手', online:false, ready:false, reps:0, uid:'pi7O'},
  result:{guestReps:0, hostReps:0, winner:'draw'},
  startAt:1786615384236,
  state:'counting',
};
check('★ 這間房被判定為已死（先前會被接回去）', roomIsDead(REAL)===true);
check('   即使 state 還卡在 counting 也算死（因為 result 已寫入）',
      roomIsDead({...REAL, state:'counting'})===true);

/* ================= 已結算 ================= */
console.log('\n=== 已結算的房間 ===');
check('有 result → 死', roomIsDead({host:online(), guest:online(),
      result:{hostReps:10,guestReps:8,winner:'host'}})===true);
check('★ 雙方都還在線但已結算 → 仍然算死（那場打完了）',
      roomIsDead({host:online('a'), guest:online('b'), state:'counting',
                  result:{hostReps:1,guestReps:0,winner:'host'}})===true);
check('state=done → 死', roomIsDead({host:online(), state:'done'})===true);

/* ================= 還活著的房間 ================= */
console.log('\n=== 還活著的房間 ===');
check('★ 房主在線、訪客未加入 → 活的（規格：只有一人是正常狀態）',
      roomIsDead({host:online(), state:'waiting'})===false);
check('雙方在線、等待中 → 活的',
      roomIsDead({host:online('a'), guest:online('b'), state:'waiting'})===false);
check('雙方在線、比賽中 → 活的',
      roomIsDead({host:online('a'), guest:online('b'), state:'counting'})===false);
check('房主剛斷線 10 秒（寬限期內）→ 活的',
      roomIsDead({host:offline('a',10000), guest:online('b')})===false);
check('★ 房主斷線超時但訪客在線 → 活的（訪客不該被連坐）',
      roomIsDead({host:offline('a',60000), guest:online('b')})===false);
check('訪客斷線超時但房主在線 → 活的',
      roomIsDead({host:online('a'), guest:offline('b',60000)})===false);
check('房主斷線 29 秒 → 活的', roomIsDead({host:offline('a',29000)})===false);

/* ================= 雙方都走光 ================= */
console.log('\n=== 雙方都走光（規格 6.4：刪除房間節點）===');
check('★ 雙方離線超時 → 死',
      roomIsDead({host:offline('a',60000), guest:offline('b',60000)})===true);
check('房主離線超時、訪客不存在 → 死',
      roomIsDead({host:offline('a',60000)})===true);
check('雙方剛好 30 秒 → 還沒死（用 > 不是 >=）',
      roomIsDead({host:offline('a',30000), guest:offline('b',30000)})===false);
check('雙方 31 秒 → 死',
      roomIsDead({host:offline('a',31000), guest:offline('b',31000)})===true);

/* ================= 結構異常 ================= */
console.log('\n=== 結構異常 ===');
check('null → 死', roomIsDead(null)===true);
check('undefined → 死', roomIsDead(undefined)===true);
check('空物件 → 死（沒有 host）', roomIsDead({})===true);
check('沒有 host 節點 → 死', roomIsDead({guest:online('b')})===true);
check('★ 房主離線但沒有 leftAt → 活的（保守，不把人踢掉）',
      roomIsDead({host:{uid:'a',online:false}})===false);

console.log(`\n${fail===0?'全部通過':'有 '+fail+' 項失敗'}（${pass} 通過 / ${fail} 失敗）`);
process.exit(fail===0?0:1);
