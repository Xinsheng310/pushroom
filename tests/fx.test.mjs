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

console.log('=== 背景不可蓋掉文字 ===');
/* 實機截圖抓到的問題：等高線原本用 step(.86,band) 畫，
   等於每一圈有 14% 的寬度整片亮起 —— 那是同心色塊不是等高線，
   實測 61.7% 的畫面被點亮、文字區亮度到 126（ink 基準 15）。
   修正後降到 0.8% 與 22。這幾條防的就是同一類回歸。 */
/* 註解要先去掉 —— shader 裡的說明文字引用了「不該這樣寫」的舊寫法，
   直接比對整段會把說明誤判成違規。 */
const frag = fx.slice(fx.indexOf('const FRAG'), fx.indexOf('`;', fx.indexOf('const FRAG')))
  .replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/step\(\.\d+,\s*band\)/.test(frag),
   '等高線不可用 step(x,band) 畫 —— 那會變成整片色塊而非細線');
ok(/fwidth|float w=/.test(frag),
   '等高線要用「到邊界的距離 + 線寬」畫成細線');
/* 內容集中在畫面中段，背景在那裡最亮就是跟文字打對台 */
ok(/clear|smoothstep\(\.?0?\.?,\s*\.\d+,\s*d\)/.test(frag),
   '中央區域要壓暗，把最暗的地方讓給文字');
ok(!/core\s*=\s*smoothstep\([^)]*\)\s*\*\s*uLock/.test(frag),
   '中央不可再加光暈 —— 那正好在大標與按鈕後面');
/* 波形三項相加會超過 1 而爆白，且置中會壓到巨大數字 */
ok(/min\(1\.,/.test(frag),
   '波形的亮度相加要 clamp 在 1 以內，否則會爆成純白');
ok(!/float base=uv\.y\+\.10;/.test(frag),
   '波形不可置中 —— 那正好在結算的巨大數字後面');

console.log('=== 有被 precache ===');
ok(fs.readFileSync(rel('sw.js'),'utf8').includes("'./js/fx.js'"), 'sw.js 要 precache fx.js');

console.log('');
console.log(fail ? `${pass} 通過 / ${fail} 失敗` : `全部通過（${pass} 通過 / 0 失敗）`);
process.exit(fail ? 1 : 0);
