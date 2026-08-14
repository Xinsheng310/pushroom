/* 就位閘門的行為測試。

   真實使用者回饋：拿著手機按下開始 → 鏡頭拍到臉 → 700ms 後就開始
   跑那 4 秒的固定計時，而他還在走去地上擺手機。
   結果兩個步驟取樣到的都是「站著移動中」的畫面，基準完全錯，
   開始計時後一下都算不到。

   根因是條件語意錯了：bodyFound 的意思是「鏡頭裡有個人」，
   不是「他就位了」。這支測試釘住修正後的語意。 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = p => path.join(ROOT, p);

let pass = 0, fail = 0;
const ok = (cond, msg) => cond ? pass++ : (fail++, console.log('  ✗ ' + msg));
const eq = (got, want, msg) => got === want
  ? pass++
  : (fail++, console.log(`  ✗ ${msg}\n      得到 ${JSON.stringify(got)}，預期 ${JSON.stringify(want)}`));

const src = fs.readFileSync(rel('js/calibflow.js'), 'utf8');

/* ---- 把純函式抽出來單獨求值（calibflow 會 import 瀏覽器相依模組） ---- */
function extract(name){
  const re = new RegExp(`(?:export )?(?:function ${name}\\([\\s\\S]*?\\n\\}|const ${name} = [\\s\\S]*?;)`, 'm');
  const m = src.match(re);
  if(!m) throw new Error(`calibflow.js 裡找不到 ${name}`);
  return m[0].replace(/^export /, '');
}
/* STILL_CAP 在下面自己宣告，這裡要排除掉免得重複宣告 */
const consts = src.slice(0, src.indexOf('function stillReset'))
  .match(/^const STILL_\w+ = [\d.]+;$/gm)
  .filter(l => !l.includes('STILL_CAP'))
  .join('\n');

const sandbox = new Function(`
  ${consts}
  const STILL_CAP = 64;
  const stillT = new Float32Array(STILL_CAP);
  const stillV = new Float32Array(STILL_CAP);
  let stillN = 0, stillHead = 0;
  ${extract('stillReset')}
  /* 用可注入的訊號取代 SIGNALS，才能餵假資料 */
  let FEED = null;
  const SIGNALS = { shoulders:{get:()=>FEED}, height:{get:()=>FEED} };
  ${extract('stillness')}
  return {
    stillness, stillReset,
    feed:v=>{FEED=v;},
    C:{STILL_MS, STILL_WIN, STILL_TOL, STILL_GIVEUP_MS},
  };
`)();

const { stillness, stillReset, feed, C } = sandbox;

/** 餵一段固定長度的訊號序列，回傳最後一次的判定 */
function run(values, dtMs = 33, t0 = 1000){
  let out = { still:false, ratio:1 };
  for(let i=0;i<values.length;i++){
    feed(values[i]);
    out = stillness({}, t0 + i*dtMs);
  }
  return out;
}

console.log('=== 常數合理性 ===');
ok(C.STILL_MS >= 1000, '要靜止夠久才算就位，太短會被短暫停頓騙過');
ok(C.STILL_GIVEUP_MS > C.STILL_MS * 4,
   '放行時間要遠大於所需靜止時間，否則等於沒有閘門');
ok(C.STILL_TOL > 0 && C.STILL_TOL < 0.2, '容許值要是個小比例');

console.log('=== 靜止判定 ===');
stillReset();
/* 完全不動：肩寬固定 40 */
ok(run(Array(40).fill(40)).still, '完全靜止應判定為就位');

stillReset();
/* 手持手機：肩寬在 30~50 之間晃（人在走動、鏡頭在動） */
const walking = Array.from({length:40}, (_,i)=> 40 + Math.sin(i*0.8)*10);
ok(!run(walking).still, '手持移動中不可判定為就位 —— 這正是原始 bug');

stillReset();
/* 微幅呼吸起伏：±1%，應該算靜止（人趴著也會呼吸） */
const breathing = Array.from({length:40}, (_,i)=> 40 + Math.sin(i*0.5)*0.4);
ok(run(breathing).still, '呼吸幅度的微動仍應算就位，否則沒人過得了');

stillReset();
/* 緩慢漂移（慢慢走近）：不該算靜止 */
const drifting = Array.from({length:40}, (_,i)=> 30 + i*0.5);
ok(!run(drifting).still, '緩慢接近中不可判定為就位');

console.log('=== 尺度無關 ===');
/* 手機放遠時肩寬絕對值小。同樣的「相對抖動」在遠近都該有相同判定，
   否則遠距離使用者會永遠被判成靜止。 */
stillReset();
const farShaky  = Array.from({length:40}, (_,i)=> 10 + Math.sin(i*0.8)*2.5);   // ±25%
stillReset();
const nearShaky = Array.from({length:40}, (_,i)=> 40 + Math.sin(i*0.8)*10);    // ±25%
stillReset(); const a = run(farShaky).still;
stillReset(); const b = run(nearShaky).still;
eq(a, b, '同樣的相對抖動，遠近應有相同判定（用相對值而非絕對值）');
ok(!a, '±25% 的抖動不該算靜止');

console.log('=== 讀不到訊號 ===');
stillReset();
feed(null);
ok(!stillness({}, 5000).still, '訊號讀不到時不可判定為就位');

console.log('=== 樣本不足 ===');
stillReset();
ok(!run([40,40,40]).still, '剛進畫面樣本太少時不可判定為就位');

console.log('=== 流程接線 ===');
ok(/calib\.step\s*=\s*0\.5/.test(src),
   'bodyFound 成立後應進入就位階段（0.5），而非直接跳到取樣');
ok(/STILL_GIVEUP_MS/.test(src) && /leaveReady/.test(src),
   '就位階段必須有超時放行 —— 沒有出路的閘門比沒有閘門更糟');
ok(/if\(!bodyFound\(lm\)\)\{[\s\S]{0,220}calib\.step = 0/.test(src),
   '就位階段中人走出畫面要退回找人（他去放手機時會發生）');
/* 一動就歸零是這個設計的靈魂：把「你動了」翻成看得見的結果 */
ok(/calib\.stillFrom = 0;[\s\S]{0,80}setRing\(0\)/.test(src),
   '動了要把環歸零，那是零文字的教學');

console.log('=== 失敗診斷 ===');
const diag = new Function(`${extract('diagnose')}; return diagnose;`)();
eq(diag([{k:'elbow',score:null},{k:'eyes',score:null}], null).say, '鏡頭沒拍到你',
   '全部訊號讀不到 → 鏡頭問題');
eq(diag([{k:'height',score:0.3}], {key:'height',up:50,down:50.5,score:0.3}).say,
   '兩次姿勢一樣',
   '上下數值幾乎相同 → 他根本沒做出兩個動作（就是沒趴好的症狀）');
eq(diag([{k:'height',score:1.2}], {key:'height',up:40,down:62,score:1.2}).say,
   '撐住的時候在晃',
   '上下差得出來但分數不夠 → 抖動吃掉了差距');
for(const r of [
  diag([{k:'elbow',score:null}], null),
  diag([{k:'height',score:0.3}], {key:'height',up:50,down:50.5,score:0.3}),
  diag([{k:'height',score:1.2}], {key:'height',up:40,down:62,score:1.2}),
]){
  ok(r.hint && r.hint.length > 6, '每個診斷都要附具體的下一步動作');
}

console.log('=== 演算法沒被動到 ===');
const detect = fs.readFileSync(rel('js/detect.js'), 'utf8');
ok(/SETTLE_MS = 2200, HOLD_MS = 1800/.test(detect),
   'detect.js 的取樣時間常數不可更動（規格第 3 節）');

console.log('');
console.log(fail ? `${pass} 通過 / ${fail} 失敗` : `全部通過（${pass} 通過 / 0 失敗）`);
process.exit(fail ? 1 : 0);
