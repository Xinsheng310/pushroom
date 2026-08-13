/* 房號邏輯測試 — 規格第 6.1、6.2 節

   房號是使用者要念給旁邊的人聽、或手打進去的，
   所以「打錯也能進」跟「別人猜不到」同樣重要。 */

import { webcrypto } from 'node:crypto';
if(!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.location = { origin:'https://x.github.io', pathname:'/pushroom/', search:'' };

const {
  ALPHABET, CODE_LEN, makeCode, normalizeCode, isValidCode, codeFromUrl, shareUrl,
} = await import('../js/roomcode.js');

let pass=0, fail=0;
const check=(name,ok,detail='')=>{
  if(ok){ pass++; console.log('  ✓ '+name); }
  else  { fail++; console.log('  ✗ '+name+(detail?'  ← '+detail:'')); }
};
const eq=(name,actual,expected)=>
  check(name+'  ('+JSON.stringify(expected)+')', actual===expected, '得到 '+JSON.stringify(actual));

/* ================= 字元集 ================= */
console.log('\n=== 字元集（規格第 6.1 節）===');
check('長度 31', ALPHABET.length===31, String(ALPHABET.length));
for(const bad of ['0','O','1','I','L']){
  check(`排除了 ${bad}`, !ALPHABET.includes(bad));
}
check('沒有重複字元', new Set(ALPHABET).size===ALPHABET.length);
check('全為大寫英數', /^[A-Z2-9]+$/.test(ALPHABET));

/* ================= 產生 ================= */
console.log('\n=== 產生房號 ===');
const codes = Array.from({length:20000}, makeCode);
check('全部長度為 '+CODE_LEN, codes.every(c=>c.length===CODE_LEN));
check('全部只用字元集內字元', codes.every(c=>[...c].every(ch=>ALPHABET.includes(ch))));
check('全部通過 isValidCode', codes.every(isValidCode));

/* 分布檢查：若產生器壞掉（例如永遠回傳同一碼、或某字元機率為 0）
   會造成大量房號碰撞。這裡確認每個字元都出現過、且沒有極端偏差。 */
const freq = {};
for(const c of codes) for(const ch of c) freq[ch]=(freq[ch]||0)+1;
const seen = Object.keys(freq).length;
check('31 個字元全都出現過', seen===31, seen+' 個');
const counts = Object.values(freq);
const expected = codes.length*CODE_LEN/31;
const maxDev = Math.max(...counts.map(n=>Math.abs(n-expected)/expected));
check('字元分布無極端偏差（<20%）', maxDev<0.2, (maxDev*100).toFixed(1)+'%');
const uniq = new Set(codes).size;
check('2 萬組的重複率合理（<3%）', (codes.length-uniq)/codes.length < 0.03,
      ((codes.length-uniq)/codes.length*100).toFixed(2)+'%');

/* ================= 正規化 ================= */
console.log('\n=== 正規化（打錯也要能進）===');
eq('小寫轉大寫', normalizeCode('k7m2'), 'K7M2');
eq('零 → Q', normalizeCode('0AAA'), 'QAAA');
eq('字母 O → Q', normalizeCode('OAAA'), 'QAAA');
eq('O 與 0 結果相同', normalizeCode('0000'), normalizeCode('OOOO'));
eq('數字 1 → J', normalizeCode('1AAA'), 'JAAA');
eq('字母 I → J', normalizeCode('IAAA'), 'JAAA');
eq('字母 L → J', normalizeCode('LAAA'), 'JAAA');
eq('豎線 | → J', normalizeCode('|AAA'), 'JAAA');
eq('1/I/L 結果相同', normalizeCode('1I1L'), 'JJJJ');
eq('去掉空白', normalizeCode('K 7 M 2'), 'K7M2');
eq('去掉連字號', normalizeCode('K7-M2'), 'K7M2');
eq('去掉底線', normalizeCode('K7_M2'), 'K7M2');
eq('超過四碼截斷', normalizeCode('K7M2XYZ'), 'K7M2');
eq('丟掉標點', normalizeCode('K7M2!!!'), 'K7M2');
eq('丟掉中文', normalizeCode('K7房M2'), 'K7M2');
eq('丟掉 emoji', normalizeCode('K7💪M2'), 'K7M2');
eq('空字串', normalizeCode(''), '');
eq('null 不爆炸', normalizeCode(null), '');
eq('undefined 不爆炸', normalizeCode(undefined), '');
eq('全是非法字元', normalizeCode('中文中文'), '');
eq('混合大小寫加雜訊', normalizeCode(' k7-m2 '), 'K7M2');

/* 正規化必須是穩定的：正規化過的房號再正規化一次不變 */
check('正規化具冪等性', codes.slice(0,500).every(c=>normalizeCode(c)===c));

/* ================= 驗證 ================= */
console.log('\n=== isValidCode ===');
check('合法四碼通過', isValidCode('K7M2'));
check('三碼不通過', !isValidCode('K7M'));
check('五碼不通過', !isValidCode('K7M22'));
check('含排除字元不通過', !isValidCode('K0M2') && !isValidCode('KIM2'));
check('小寫不通過（須先正規化）', !isValidCode('k7m2'));
check('空字串不通過', !isValidCode(''));
check('null 不通過', !isValidCode(null));
check('非字串不通過', !isValidCode(1234));

/* ================= 網址 ================= */
console.log('\n=== 網址（規格第 6.2 節）===');
eq('從 ?room= 取出', codeFromUrl('?room=K7M2'), 'K7M2');
eq('小寫也能取出', codeFromUrl('?room=k7m2'), 'K7M2');
eq('誤輸入也能取出', codeFromUrl('?room=k7-m2'), 'K7M2');
eq('O/0 也能取出', codeFromUrl('?room=07m2'), 'Q7M2');
eq('沒有 room 參數回傳 null', codeFromUrl('?x=1'), null);
eq('空 search 回傳 null', codeFromUrl(''), null);
eq('房號不合法回傳 null', codeFromUrl('?room=中文'), null);
eq('房號太短回傳 null', codeFromUrl('?room=K7'), null);
eq('與其他參數並存', codeFromUrl('?a=1&room=K7M2&b=2'), 'K7M2');
eq('分享連結', shareUrl('K7M2'), 'https://x.github.io/pushroom/?room=K7M2');

/* 往返測試：產生 → 分享連結 → 從連結取回，必須拿到原本的房號 */
check('產生→連結→取回 往返一致',
  codes.slice(0,1000).every(c=>codeFromUrl('?room='+c)===c));

console.log(`\n${fail===0?'全部通過':'有 '+fail+' 項失敗'}（${pass} 通過 / ${fail} 失敗）`);
process.exit(fail===0?0:1);
