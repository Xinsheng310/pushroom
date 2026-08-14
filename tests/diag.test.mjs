/* 診斷窗的靜態約束。

   這支工具的存在意義是「幫忙定位問題」，所以它自己絕對不能製造問題。
   兩條紅線用測試釘住：

     1. 只讀不寫 —— 診斷工具改壞了被診斷的東西，是最糟的失敗模式。
     2. 不擋操作 —— 它蓋在計數畫面上，若吃掉點擊就會讓中止鈕按不到。 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = p => path.join(ROOT, p);

let pass = 0, fail = 0;
const ok = (cond, msg) => cond ? pass++ : (fail++, console.log('  ✗ ' + msg));

const diag = fs.readFileSync(rel('js/diag.js'), 'utf8');
const css  = fs.readFileSync(rel('css/app.css'), 'utf8');
const html = fs.readFileSync(rel('index.html'), 'utf8');
const main = fs.readFileSync(rel('js/main.js'), 'utf8');

console.log('=== 只讀不寫 ===');
/* 不可以匯入任何會改動房間或本機狀態的模組 */
for(const forbidden of ['./room.js', './firebase.js', './calibstore.js', './detect.js']){
  ok(!diag.includes(`from '${forbidden}'`),
     `diag.js 不該 import ${forbidden} —— 診斷只能讀，不能碰狀態`);
}
/* 明確列出「會改動遠端或本機持久狀態」的函式名。
   不要用 /set[A-Z]/ 這種粗糙的樣式 —— 那會誤判 setAttribute
   （那是畫面操作，本來就必須做）。 */
for(const writer of ['setReady', 'setCalibrating', 'setCalibMode',
                     'pushReps', 'writeResult', 'startMatch', 'setState',
                     'saveCalib', 'clearCalib', 'leaveRoom']){
  ok(!diag.includes(writer + '('), `diag.js 不該呼叫 ${writer}() —— 診斷只能讀`);
}

console.log('=== 不擋操作 ===');
const diagCss = css.slice(css.indexOf('#diag{'));
ok(/#diag\{[^}]*pointer-events:none/.test(diagCss),
   '#diag 必須 pointer-events:none，否則會擋住計數畫面的按鈕');
ok(/\.diagclose\{[^}]*pointer-events:auto/.test(css),
   '.diagclose 要收回 pointer-events，否則關不掉');
/* 高度必須有上限且用相對單位 —— #count 的位置隨視窗高度變，
   固定像素在小螢幕（375×667）會壓住巨大數字。 */
ok(/#diag\{[^}]*max-height:\s*\d+vh/.test(diagCss),
   '#diag 的 max-height 要用 vh，固定像素在小螢幕會壓到數字');

console.log('=== 預設關閉 ===');
ok(/id="diag"[^>]*\bhidden\b/.test(html), '#diag 預設要是 hidden');
ok(/aria-checked="false"[^>]*id="swDiag"|id="swDiag"[^>]*aria-checked="false"/.test(html),
   '測試模式的診斷開關預設要是關的');
/* 重整後開關要跟還原的狀態一致，否則按下去會反向操作 */
ok(/swDiag'\)\.setAttribute\('aria-checked', String\(diagOn\(\)\)\)/.test(main),
   'main.js 要在啟動時把開關同步成 diagOn() —— 否則重整後開關會反向');

console.log('=== 文字安全 ===');
/* 房號與暱稱都是使用者可控的字串（規格第 8 節） */
ok(!diag.includes('innerHTML'), 'diag.js 不可使用 innerHTML');
ok(diag.includes('textContent'), 'diag.js 應該用 textContent 寫入');

console.log('=== 有被 precache ===');
const sw = fs.readFileSync(rel('sw.js'), 'utf8');
ok(sw.includes("'./js/diag.js'"), 'sw.js 要 precache diag.js');

console.log('');
console.log(fail ? `${pass} 通過 / ${fail} 失敗` : `全部通過（${pass} 通過 / 0 失敗）`);
process.exit(fail ? 1 : 0);
