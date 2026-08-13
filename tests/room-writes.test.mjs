/* room.js 的每一筆寫入，路徑與欄位是否都被安全規則允許

   起因：room.js 第一版寫入了 leftAt 與 countdownSec 兩個規則沒定義的欄位，
   而規則的 $other:{".validate":false} 會把它們擋掉 —— 部署後才會發現「對戰跑不動」。
   靜態的 rules.test.mjs 檢查不到這種「程式與規則對不上」的問題。

   這支測試把 room.js 實際寫入的路徑抽出來，逐一比對規則是否允許，
   目的是在寫程式階段就攔住 schema 不一致。

   限制：這是規則「結構」比對，不是行為模擬（那需要 emulator + Java）。
   它抓的是「欄位存不存在於規則」，不驗證 .validate 的條件式邏輯。 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here,'..');
const rules = JSON.parse(readFileSync(join(root,'database.rules.json'),'utf8')).rules;
const src = readFileSync(join(root,'js/room.js'),'utf8');

let pass=0, fail=0;
const check=(name,ok,detail='')=>{
  if(ok){ pass++; console.log('  ✓ '+name); }
  else  { fail++; console.log('  ✗ '+name+(detail?'  ← '+detail:'')); }
};

/** 走訪規則樹，$code 這類變數節點用 $ 開頭的鍵匹配 */
function resolve(path){
  let node = rules;
  for(const seg of path){
    if(!node || typeof node!=='object') return null;
    if(node[seg]) { node = node[seg]; continue; }
    const varKey = Object.keys(node).find(k=>k.startsWith('$') && k!=='$other');
    if(varKey){ node = node[varKey]; continue; }
    return null;   // 落到 $other → 被 validate:false 擋掉
  }
  return node;
}

/* room.js 實際會寫入的每一條路徑（rooms/{code}/... 之後的部分） */
const WRITES = [
  { path:['rooms','$','config'],              who:'建房',   fn:'createRoom' },
  { path:['rooms','$','config','durationSec'],who:'建房',   fn:'createRoom' },
  { path:['rooms','$','config','createdAt'],  who:'建房',   fn:'createRoom' },
  { path:['rooms','$','host'],                who:'建房',   fn:'createRoom' },
  { path:['rooms','$','host','uid'],          who:'建房',   fn:'sideData' },
  { path:['rooms','$','host','name'],         who:'建房',   fn:'sideData' },
  { path:['rooms','$','host','online'],       who:'建房',   fn:'sideData' },
  { path:['rooms','$','host','reps'],         who:'計數',   fn:'pushReps' },
  { path:['rooms','$','host','ready'],        who:'準備',   fn:'setReady' },
  { path:['rooms','$','host','leftAt'],       who:'斷線',   fn:'onDisconnect' },
  { path:['rooms','$','guest'],               who:'加入',   fn:'joinRoom' },
  { path:['rooms','$','guest','uid'],         who:'加入',   fn:'sideData' },
  { path:['rooms','$','guest','reps'],        who:'計數',   fn:'pushReps' },
  { path:['rooms','$','guest','leftAt'],      who:'斷線',   fn:'onDisconnect' },
  { path:['rooms','$','state'],               who:'開始',   fn:'startMatch' },
  { path:['rooms','$','startAt'],             who:'開始',   fn:'startMatch' },
  { path:['rooms','$','countdownSec'],        who:'開始',   fn:'startMatch' },
  { path:['rooms','$','calibMode'],           who:'建房',   fn:'setCalibMode' },
  { path:['rooms','$','result'],              who:'結算',   fn:'writeResult' },
  { path:['rooms','$','result','hostReps'],   who:'結算',   fn:'writeResult' },
  { path:['rooms','$','result','guestReps'],  who:'結算',   fn:'writeResult' },
  { path:['rooms','$','result','winner'],     who:'結算',   fn:'writeResult' },
];

console.log('\n=== room.js 的寫入路徑 vs 安全規則 ===');
for(const w of WRITES){
  const node = resolve(w.path);
  const p = w.path.join('/').replace('$','{code}');
  check(`${w.who.padEnd(3)} ${p}`, node!==null, `規則沒有這個節點（會被 $other 擋掉）· ${w.fn}()`);
}

/* 反向檢查：規則定義了但程式沒用到的欄位（可能是規則寫多了，或程式忘了寫） */
console.log('\n=== 規則定義的欄位是否都有程式對應 ===');
for(const side of ['host','guest']){
  for(const field of Object.keys(rules.rooms.$code[side])){
    if(field.startsWith('.') || field.startsWith('$')) continue;
    /* leftAt 由 onDisconnect 寫入，字串上找 leftRef */
    const used = src.includes(`'${field}'`) || src.includes(`${field}:`) || src.includes(`/${field}`)
              || (field==='leftAt' && src.includes('leftRef'));
    check(`${side}.${field} 有被 room.js 使用`, used);
  }
}

/* hasChildren 要求的欄位，sideData() 必須全部提供，否則整個寫入被拒 */
console.log('\n=== sideData() 是否滿足 hasChildren 要求 ===');
for(const side of ['host','guest']){
  const v = rules.rooms.$code[side]['.validate'] || '';
  const required = [...v.matchAll(/'([a-zA-Z]+)'/g)].map(m=>m[1]);
  const sideDataBlock = src.slice(src.indexOf('function sideData'), src.indexOf('function requireReady'));
  const missing = required.filter(f=>!sideDataBlock.includes(f+':'));
  check(`${side} 需要 [${required.join(',')}]`, missing.length===0, '缺少 '+missing.join(','));
}

console.log(`\n${fail===0?'全部通過':'有 '+fail+' 項失敗'}（${pass} 通過 / ${fail} 失敗）`);
process.exit(fail===0?0:1);
