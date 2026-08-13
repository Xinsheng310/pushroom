/* 斷線寬限期與時鐘對齊的邏輯測試（規格第 6.4、6.5 節）

   這兩塊是對戰最容易出錯的地方，而且錯了很難察覺：
     - 寬限期算錯 → 對手只是進背景就被判離開，或永遠等不到超時
     - 時鐘對齊錯 → 一方先開始，多做幾下

   room.js / clock.js 依賴 firebase.js（會去 import CDN），
   Node 環境下無法載入，所以這裡把兩個核心演算法以相同邏輯重新實作驗證。
   任何一邊改動都必須同步這裡 —— 這是刻意的重複，用來鎖住行為。 */

const GRACE_MS = 30000;

let pass=0, fail=0;
const check=(name,ok,detail='')=>{
  if(ok){ pass++; console.log('  ✓ '+name); }
  else  { fail++; console.log('  ✗ '+name+(detail?'  ← '+detail:'')); }
};

/* ---------- seatExpired（與 room.js 同邏輯） ---------- */
function seatExpired(side, now){
  if(!side) return true;
  if(side.online) return false;
  if(!side.leftAt) return false;
  return now - side.leftAt > GRACE_MS;
}

console.log('\n=== 位子是否已空出（seatExpired）===');
const NOW = 1000000;
check('沒人 → 空位', seatExpired(null, NOW)===true);
check('在線 → 位子是他的', seatExpired({online:true}, NOW)===false);
check('剛斷線 1 秒 → 還在寬限期',
      seatExpired({online:false,leftAt:NOW-1000}, NOW)===false);
check('斷線 29 秒 → 還在寬限期',
      seatExpired({online:false,leftAt:NOW-29000}, NOW)===false);
check('斷線正好 30 秒 → 還沒過期（用 > 不是 >=）',
      seatExpired({online:false,leftAt:NOW-30000}, NOW)===false);
check('斷線 31 秒 → 已過期',
      seatExpired({online:false,leftAt:NOW-31000}, NOW)===true);
check('★ 斷線但沒有 leftAt → 保守視為仍佔用（不可把人踢掉）',
      seatExpired({online:false}, NOW)===false);
check('★ leftAt 為 0 也不可當成很久以前',
      seatExpired({online:false,leftAt:0}, NOW)===false);
check('leftAt 在未來（時鐘偏差）→ 不算過期',
      seatExpired({online:false,leftAt:NOW+5000}, NOW)===false);

/* ---------- 寬限期剩餘時間 ---------- */
function graceLeft(op, now){
  if(!op) return {stale:false,expired:false,msLeft:0};
  if(op.online) return {stale:false,expired:false,msLeft:GRACE_MS};
  const left = op.leftAt || now;
  return { stale:true, expired:seatExpired(op,now),
           msLeft: Math.max(0, GRACE_MS-(now-left)) };
}

console.log('\n=== 寬限期剩餘（給 UI 顯示倒數）===');
let g = graceLeft({online:true}, NOW);
check('對手在線 → 不顯示警告', g.stale===false && g.expired===false);
g = graceLeft({online:false,leftAt:NOW-10000}, NOW);
check('斷線 10 秒 → stale 且剩 20 秒', g.stale && !g.expired && g.msLeft===20000, String(g.msLeft));
g = graceLeft({online:false,leftAt:NOW-31000}, NOW);
check('斷線 31 秒 → expired 且剩 0', g.stale && g.expired && g.msLeft===0);
g = graceLeft({online:false}, NOW);
check('★ 沒有 leftAt → stale 但給滿額寬限、不判過期',
      g.stale && !g.expired && g.msLeft===GRACE_MS, JSON.stringify(g));
g = graceLeft(null, NOW);
check('對手不存在 → 不是 stale（房間只有一人是正常狀態）',
      g.stale===false, JSON.stringify(g));

/* ---------- 時鐘對齊（與 clock.js 同邏輯） ---------- */
function makeTimer(startAtServer, offset, perfNow){
  const serverNow = ()=> perfNow.wall + offset;
  const perfAtStart = perfNow.perf + (startAtServer - serverNow());
  return {
    perfAtStart,
    started: p => p >= perfAtStart,
    elapsed: p => p - perfAtStart,
    remainingTo: (p,dur) => perfAtStart + dur - p,
  };
}

console.log('\n=== 時鐘對齊（規格第 6.5 節）===');
/* 情境：伺服器時刻 T 開始比賽。
   A 手機時鐘快 5 秒（offset = -5000），B 手機慢 8 秒（offset = +8000）。
   兩人 performance.now() 各自從不同值起算。
   對齊後「距離開始還有多久」必須一致。 */
const T = 1700000000000;
const A = makeTimer(T, -5000, {wall:T+5000-3000, perf:10000});  // A 快 5 秒，距開始還有 3 秒
const B = makeTimer(T, +8000, {wall:T-8000-3000, perf:777777});  // B 慢 8 秒，距開始還有 3 秒

check('A 距開始 3 秒', Math.abs((A.perfAtStart-10000)-3000)<1, String(A.perfAtStart-10000));
check('B 距開始 3 秒', Math.abs((B.perfAtStart-777777)-3000)<1, String(B.perfAtStart-777777));
check('★ 兩支手機時鐘差 13 秒，對齊後起跑點一致（誤差<1ms）',
      Math.abs((A.perfAtStart-10000)-(B.perfAtStart-777777))<1);

/* 60 秒賽制，起跑後兩邊剩餘時間必須一致 */
const aLeft = A.remainingTo(10000+3000+10000, 60000);  // A 起跑後 10 秒
const bLeft = B.remainingTo(777777+3000+10000, 60000); // B 起跑後 10 秒
check('起跑後 10 秒，雙方剩餘時間一致', Math.abs(aLeft-bLeft)<1, aLeft+' vs '+bLeft);
check('剩餘時間正確（60-10=50 秒）', Math.abs(aLeft-50000)<1, String(aLeft));

check('起跑前 started() 為 false', A.started(10000+2999)===false);
check('起跑時 started() 為 true', A.started(10000+3000)===true);

/* 加入時比賽已經開始（遲到的訪客）→ 起點在過去，elapsed 為正 */
const late = makeTimer(T, 0, {wall:T+20000, perf:5000});
check('遲到加入 → 起點在過去', late.perfAtStart < 5000);
check('遲到 20 秒 → elapsed 約 20 秒', Math.abs(late.elapsed(5000)-20000)<1,
      String(late.elapsed(5000)));

console.log(`\n${fail===0?'全部通過':'有 '+fail+' 項失敗'}（${pass} 通過 / ${fail} 失敗）`);
process.exit(fail===0?0:1);
