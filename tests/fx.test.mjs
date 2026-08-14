/* 背景等高線場的靜態約束。

   這層的風險不在「好不好看」，在它會不會弄壞計數：
   MediaPipe 自己持有一個 WebGL2 context，iOS 對同頁面的 context
   數量限制很緊，超過就強制回收最舊的 —— 被回收的很可能正是 MediaPipe，
   結果是姿勢偵測整個掛掉。那比特效不夠酷嚴重得多。

   所以這裡釘住的都是「會不會炸」的事，不是外觀。 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = p => path.join(ROOT, p);

let pass = 0, fail = 0;
const ok = (cond, msg) => cond ? pass++ : (fail++, console.log('  ✗ ' + msg));

const fx   = fs.readFileSync(rel('js/fx.js'), 'utf8');
const ui   = fs.readFileSync(rel('js/ui.js'), 'utf8');
const css  = fs.readFileSync(rel('css/app.css'), 'utf8');
const html = fs.readFileSync(rel('index.html'), 'utf8');
const main = fs.readFileSync(rel('js/main.js'), 'utf8');

console.log('=== 不跟 MediaPipe 搶 context ===');
ok(/getContext\('webgl'/.test(fx),
   "必須用 webgl 而非 webgl2 —— 跟 MediaPipe 的 webgl2 分開資源池");
ok(!/getContext\('webgl2'/.test(fx), '不可建立 webgl2 context');
ok(/loseContext\(\)/.test(fx),
   'release() 必須真的 loseContext()，不能只暫停 rAF');

/* 需要推論的畫面一律不能有場。這是整層最重要的一條。 */
const INFER = ['setup','run','lab'];
const m = fx.match(/FX_PANELS\s*=\s*new Set\(\[([^\]]*)\]/);
ok(!!m, 'fx.js 應該有 FX_PANELS 清單');
if(m){
  for(const p of INFER){
    ok(!m[1].includes(`'${p}'`),
       `FX_PANELS 不可包含 ${p} —— 那個畫面正在推論，不能再開 WebGL`);
  }
}
ok(/FX_PANELS\.has\(name\)/.test(ui) && /release\(\)/.test(ui),
   'ui.js 的 show() 要集中管理 acquire/release，不靠各處記得呼叫');

console.log('=== 釋放後必須能重建 ===');
/* loseContext() 之後那個 <canvas> 元素永久壞掉，
   再 getContext 只會拿到 null。不換節點的話，
   從計數畫面回首頁就再也沒有背景 —— 而且完全不會報錯。 */
ok(/cloneNode|replaceWith|createElement\('canvas'\)/.test(fx),
   'release() 之後要換一個乾淨的 canvas 節點，否則 acquire() 永遠失敗');

console.log('=== 壞掉也不能擋住畫面 ===');
ok(/webglcontextlost/.test(fx), '要處理 webglcontextlost');
ok(/classList\.add\('nofx'\)/.test(fx), '失敗時要標記 nofx 讓 CSS 退回');
ok(/pointer-events:none/.test(css.slice(css.indexOf('#fx{'), css.indexOf('#fx{')+260)),
   '#fx 必須 pointer-events:none，不能擋住任何操作');
ok(/id="fx"[^>]*\bhidden\b/.test(html), '#fx 預設要 hidden');

/* 面板的不透明底色是「相機不可透出」的最後一道防線。
   只有在 shader 真的在畫時才可以讓出，而且是靠 fxon 這個 class。 */
ok(/html\.fxon/.test(css),
   '面板轉透明必須掛在 .fxon 之下 —— 沒有 fx 時要維持不透明，否則會透出相機');
ok(/classList\.add\('fxon'\)/.test(fx) && /classList\.remove\('fxon'\)/.test(fx),
   'fxon 要跟著 context 的生死一起加/移除');

console.log('=== 波形要用真實資料 ===');
ok(/fxWave\(S\.times\)/.test(main),
   '結算波形必須餵真實的 S.times —— 裝飾性亂數會讓使用者發現對不上');
ok(/uReps/.test(fx), 'shader 要接受每下的時間戳');

console.log('=== 色彩紀律 ===');
/* 橘 = 需要立刻注意。背景永遠不是需要立刻注意的東西。 */
const fragBody = fx.slice(fx.indexOf('const FRAG'), fx.indexOf('`;', fx.indexOf('const FRAG')));
ok(!/1\.0*,\s*\.35|signal|FF5A1F/i.test(fragBody),
   'shader 不可出現橘色 —— 那是「需要立刻注意」的專用色');

console.log('=== 有被 precache ===');
ok(fs.readFileSync(rel('sw.js'),'utf8').includes("'./js/fx.js'"), 'sw.js 要 precache fx.js');

console.log('');
console.log(fail ? `${pass} 通過 / ${fail} 失敗` : `全部通過（${pass} 通過 / 0 失敗）`);
process.exit(fail ? 1 : 0);
