/* 校正存檔測試

   存檔壞掉的後果比「沒存檔」嚴重得多：
   壞掉的基準會讓整場計數錯亂，而使用者不會知道原因。
   所以 loadCalib 對任何不合法的內容都必須回傳 null（當作沒存過）。 */

/* 最小的 localStorage 替身 */
let store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k,v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
/* log() 會摸 document，給個替身 */
globalThis.document = { getElementById: ()=>null };

const {
  loadCalib, saveCalib, clearCalib, isStale, matchesCamera, describeAge, STALE_MS,
} = await import('../js/calibstore.js');

let pass=0, fail=0;
const check=(name,ok,detail='')=>{
  if(ok){ pass++; console.log('  ✓ '+name); }
  else  { fail++; console.log('  ✗ '+name+(detail?'  ← '+detail:'')); }
};

const GOOD = { key:'height', up:42.3, down:61.8, score:155.8,
               thDown:0.72, thUp:0.32, front:true };
const reset = ()=>{ store = {}; };
const put = obj => { store['reproom.calib.v1'] = JSON.stringify(obj); };

/* ================= 存 / 讀 ================= */
console.log('\n=== 存檔與讀取 ===');
reset();
check('沒存過回傳 null', loadCalib()===null);
check('saveCalib 回傳 true', saveCalib(GOOD)===true);
const back = loadCalib();
check('讀回同一組值',
      back && back.key==='height' && back.up===42.3 && back.down===61.8
      && back.thDown===0.72 && back.thUp===0.32 && back.front===true,
      JSON.stringify(back));
check('有寫入 savedAt 時間戳', typeof back.savedAt==='number' && back.savedAt>0);
check('clearCalib 清得掉', (clearCalib(), loadCalib()===null));

/* ================= 壞資料一律當沒存過 ================= */
console.log('\n=== 壞資料防護（壞基準會讓整場計數錯亂）===');
reset(); store['reproom.calib.v1'] = '不是 JSON';
check('不是 JSON → null', loadCalib()===null);
reset(); store['reproom.calib.v1'] = 'null';
check('JSON null → null', loadCalib()===null);
reset(); store['reproom.calib.v1'] = '"字串"';
check('JSON 字串 → null', loadCalib()===null);
reset(); put({ ...GOOD, key:undefined });
check('缺 key → null', loadCalib()===null);
reset(); put({ ...GOOD, key:'' });
check('key 為空字串 → null', loadCalib()===null);
reset(); put({ ...GOOD, up:'42.3' });
check('up 是字串 → null', loadCalib()===null);
reset(); put({ ...GOOD, down:undefined });
check('缺 down → null', loadCalib()===null);
reset(); put({ ...GOOD, up:NaN });
check('up 為 NaN → null（JSON 會變 null）', loadCalib()===null);
reset(); put({ ...GOOD, thDown:null });
check('缺 thDown → null', loadCalib()===null);
reset(); put({ ...GOOD, up:50, down:50 });
check('★ 上下基準相同 → null（否則深度公式除以零）', loadCalib()===null);
reset(); put({ ...GOOD, thDown:0.3, thUp:0.7 });
check('★ 門檻顛倒（down<up）→ null（否則狀態機卡死）', loadCalib()===null);
reset(); put({ ...GOOD, thDown:0.5, thUp:0.5 });
check('門檻相同 → null', loadCalib()===null);

/* 合法但不尋常的值要放行 —— 使用者可能真的用後鏡頭、或基準反向 */
console.log('\n=== 合法但不尋常的值要放行 ===');
reset(); put({ ...GOOD, up:61.8, down:42.3 });
check('基準反向（down<up）仍可用：肩膀高度就是往下變大',
      loadCalib()!==null);
reset(); put({ ...GOOD, front:false });
check('後鏡頭存檔可讀', loadCalib()?.front===false);

/* ================= 過期判斷 ================= */
console.log('\n=== 過期判斷 ===');
const NOW = 1700000000000;
check('剛存的不算過期', isStale({savedAt:NOW}, NOW)===false);
check('23 小時前不算過期', isStale({savedAt:NOW-23*3600e3}, NOW)===false);
check('25 小時前算過期', isStale({savedAt:NOW-25*3600e3}, NOW)===true);
check('沒有 savedAt 算過期', isStale({}, NOW)===true);
check('null 算過期', isStale(null, NOW)===true);
check('STALE_MS 是一天', STALE_MS===24*60*60*1000);

/* ================= 鏡頭比對 ================= */
console.log('\n=== 鏡頭比對（換鏡頭基準就失效）===');
check('前鏡頭存檔 vs 目前前鏡頭 → 相符', matchesCamera({front:true}, true));
check('前鏡頭存檔 vs 目前後鏡頭 → 不符', !matchesCamera({front:true}, false));
check('後鏡頭存檔 vs 目前後鏡頭 → 相符', matchesCamera({front:false}, false));
check('null 存檔 → 不符', !matchesCamera(null, true));

/* ================= 時間描述 ================= */
console.log('\n=== 時間描述 ===');
check('剛剛', describeAge({savedAt:NOW-10e3}, NOW)==='剛剛校正',
      describeAge({savedAt:NOW-10e3}, NOW));
check('分鐘', describeAge({savedAt:NOW-5*60e3}, NOW)==='5 分鐘前校正');
check('小時', describeAge({savedAt:NOW-3*3600e3}, NOW)==='3 小時前校正');
check('天', describeAge({savedAt:NOW-3*24*3600e3}, NOW)==='3 天前校正');
check('沒有 savedAt 回空字串', describeAge({}, NOW)==='');

/* ================= localStorage 不可用時不能爆炸 ================= */
console.log('\n=== localStorage 不可用（隱私模式）===');
const orig = globalThis.localStorage;
globalThis.localStorage = {
  getItem(){ throw new Error('denied'); },
  setItem(){ throw new Error('denied'); },
  removeItem(){ throw new Error('denied'); },
};
check('讀取失敗回傳 null 而不是拋錯', loadCalib()===null);
check('寫入失敗回傳 false 而不是拋錯', saveCalib(GOOD)===false);
check('清除失敗不拋錯', (()=>{ try{ clearCalib(); return true; }catch(e){ return false; } })());
globalThis.localStorage = orig;

console.log(`\n${fail===0?'全部通過':'有 '+fail+' 項失敗'}（${pass} 通過 / ${fail} 失敗）`);
process.exit(fail===0?0:1);
