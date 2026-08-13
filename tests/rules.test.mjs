/* 安全規則的靜態檢查

   完整的規則行為驗證需要 Firebase emulator（需要 Java）。
   這支測試不需要 Java，做的是「規則檔本身是否健全」的檢查：
     - database.rules.json 是合法 JSON、結構符合預期
     - 每個必要的約束都存在（規格第 5 節逐條對照）
     - Firestore 規則的關鍵條件字串都在
   目的是擋住「改規則時手滑刪掉某條約束」這種錯誤。

   emulator 的完整測試見 tests/rules.emulator.test.mjs（需 Java）。 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0, fail = 0;
function check(name, ok, detail=''){
  if(ok){ pass++; console.log('  ✓ ' + name); }
  else  { fail++; console.log('  ✗ ' + name + (detail? '  ← '+detail : '')); }
}

/* ================= RTDB ================= */
console.log('\n=== database.rules.json ===');

const rawDb = readFileSync(join(root,'database.rules.json'),'utf8');
let db = null;
try { db = JSON.parse(rawDb); check('是合法 JSON', true); }
catch(e){ check('是合法 JSON', false, e.message); }

if(db){
  const r = db.rules;
  const room = r?.rooms?.$code;

  check('根層預設拒絕讀寫', r['.read']===false && r['.write']===false);
  check('房間層沒有 .write（避免整個子樹被授權）', room && !('.write' in room),
        room && '.write' in room ? '房間層有 .write，會授權整個子樹' : '');
  check('房號格式排除 0 O 1 I L',
        room?.['.validate']?.includes('A-HJ-KM-NP-Z2-9'),
        room?.['.validate']);

  for(const side of ['host','guest']){
    const n = room?.[side];
    check(`${side}：只有本人 uid 能寫`,
          n?.uid?.['.validate'] === 'newData.val() == auth.uid');
    check(`${side}：佔位後只有本人可改`,
          n?.['.write']?.includes("data.child('uid').val() == auth.uid"));
    const reps = n?.reps?.['.validate'] || '';
    check(`${side}：reps 是非負整數且有上限`,
          reps.includes('>= 0') && reps.includes('% 1 == 0') && reps.includes('<='),
          reps);
    check(`${side}：未知欄位被拒絕`, n?.$other?.['.validate'] === false);
  }

  check('startAt 強制伺服器時間戳（不可信任客戶端時鐘）',
        room?.startAt?.['.validate'] === 'newData.val() == now',
        room?.startAt?.['.validate']);
  check('startAt 只有房主能寫',
        room?.startAt?.['.write']?.includes("host').child('uid').val() == auth.uid"));
  check('state 只有房主能推進',
        room?.state?.['.write']?.includes("host').child('uid').val() == auth.uid"));
  check('state 只接受四種值',
        ['waiting','counting','live','done'].every(v => room?.state?.['.validate']?.includes(`'${v}'`)));
  check('result 寫入後不可再改',
        room?.result?.['.write']?.includes('!data.exists()'));
  check('config 寫入後不可再改',
        room?.config?.['.write']?.includes('!data.exists()'));
  check('房間未知子節點被拒絕', room?.$other?.['.validate'] === false);
}

/* ================= Firestore ================= */
console.log('\n=== firestore.rules ===');

const fs = readFileSync(join(root,'firestore.rules'),'utf8');
const has = s => fs.includes(s);

check('rules_version = 2', has("rules_version = '2'"));
check('users 不儲存 email（明確擋掉）', has("!d.keys().hasAny(['email'])"));
check('users 不可刪除', /allow delete: if false/.test(fs));
check('users 建立/更新限本人', has('isSelf(uid)'));
check('stats 每個欄位都驗證非負整數',
      ['totalReps','bestSession','wins','losses','draws','matches']
        .every(k => new RegExp(`${k}\\s*is int`).test(fs)));
check('matches 僅參與者可讀',
      has('request.auth.uid in resource.data.players'));
check('matches 僅參與者可建立',
      has('request.auth.uid in request.resource.data.players'));
check('matches 建立後不可改刪',
      has('allow update, delete: if false'));
check('players 必須與 a/b 的 uid 一致（防偽造參與者）',
      has('d.players.hasOnly([d.a.uid, d.b.uid])') && has('d.players.hasAll([d.a.uid, d.b.uid])'));
check('players 兩人不可相同（防自己跟自己打刷勝場）',
      has('d.players[0] != d.players[1]'));
check('winner 必須與雙方次數相符',
      has("d.winner == 'a'") && has('d.a.reps >  d.b.reps'));
check('playedAt 必須是 timestamp', has('d.playedAt is timestamp'));
check('未列出的路徑一律拒絕',
      /match \/\{document=\*\*\} \{\s*allow read, write: if false;/.test(fs));

/* 括號配對——規則檔語法錯誤最常見的來源 */
const brOpen = (fs.match(/\{/g)||[]).length, brClose = (fs.match(/\}/g)||[]).length;
check('大括號配對', brOpen===brClose, `${brOpen} vs ${brClose}`);
const pOpen = (fs.match(/\(/g)||[]).length, pClose = (fs.match(/\)/g)||[]).length;
check('小括號配對', pOpen===pClose, `${pOpen} vs ${pClose}`);

/* ================= 結果 ================= */
console.log(`\n${fail===0 ? '全部通過' : '有 '+fail+' 項失敗'}（${pass} 通過 / ${fail} 失敗）`);
if(fail===0) console.log('注意：這是靜態檢查。規則的實際行為需要 emulator 驗證（見檔頭說明）。');
process.exit(fail===0?0:1);
