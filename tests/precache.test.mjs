/* sw.js 的 PRECACHE 清單必須涵蓋所有 js 模組。

   為什麼要測：拆檔時新增模組很容易忘了加進 PRECACHE。
   線上開發時完全看不出問題（網路抓得到），
   但已安裝 PWA 的使用者離線開啟就會少一個模組 —— 整個 App 白畫面。
   這是「只在最不方便的時候才會爆」的錯，必須靠測試擋。 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 路徑錨在這支檔案的位置，不靠 cwd —— 從哪個目錄執行都要一樣。 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = p => path.join(ROOT, p);

let pass = 0, fail = 0;
const ok = (cond, msg) => cond ? pass++ : (fail++, console.log('  ✗ ' + msg));

const sw = fs.readFileSync(rel('sw.js'), 'utf8');
const listed = new Set(
  [...sw.matchAll(/'\.\/js\/([A-Za-z0-9_-]+\.js)'/g)].map(m => m[1])
);
const actual = fs.readdirSync(rel('js')).filter(f => f.endsWith('.js'));

for (const f of actual) {
  ok(listed.has(f), `js/${f} 沒有列進 sw.js 的 PRECACHE —— 離線時會載不到`);
}
for (const f of listed) {
  ok(fs.existsSync(rel(path.join('js', f))),
     `sw.js 的 PRECACHE 列了 js/${f}，但檔案不存在 —— install 會失敗`);
}

/* index.html 實際載入的進入點也要在清單裡 */
const html = fs.readFileSync(rel('index.html'), 'utf8');
for (const m of html.matchAll(/src="\.?\/?js\/([A-Za-z0-9_-]+\.js)"/g)) {
  ok(listed.has(m[1]), `index.html 載入 js/${m[1]}，但 sw.js 沒有 precache`);
}

/* 改了模組清單就要改版本號，否則舊 cache 不會失效 */
ok(/const VERSION = 'v\d+';/.test(sw), 'sw.js 應有 VERSION 常數');

console.log(fail ? `\n${pass} 通過 / ${fail} 失敗` : `全部通過（${pass} 通過 / 0 失敗）`);
process.exit(fail ? 1 : 0);
