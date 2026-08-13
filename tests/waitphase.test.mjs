/* 等待室階段機的行為測試。

   等待室原本九個區塊視覺重量一樣，使用者得自己判斷「現在輪到我做什麼」。
   改成由單一階段 class 驅動之後，這裡守住三件事：
     1. 每個情境算出來的階段是對的
     2. 開始鈕在該擋的時候擋住（尤其是對方正在校正）
     3. 擋住時按鈕上的字要說明為什麼

   純函式測試 —— 不需要瀏覽器、不需要 Firebase。 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = p => path.join(ROOT, p);

let pass = 0, fail = 0;
const eq = (got, want, msg) => got === want
  ? pass++
  : (fail++, console.log(`  ✗ ${msg}\n      得到 ${JSON.stringify(got)}，預期 ${JSON.stringify(want)}`));
const ok = (cond, msg) => cond ? pass++ : (fail++, console.log('  ✗ ' + msg));

/* versus.js 會 import firebase 等瀏覽器相依，不能直接 import。
   把要測的純函式從原始碼裡取出來單獨求值 —— 它們刻意寫成不依賴任何模組。 */
const src = fs.readFileSync(rel('js/versus.js'), 'utf8');
function extract(name){
  const re = new RegExp(`export (?:function ${name}\\([\\s\\S]*?\\n\\}|const ${name} = [\\s\\S]*?;)`, 'm');
  const m = src.match(re);
  if(!m) throw new Error(`versus.js 裡找不到 ${name}`);
  return m[0].replace(/^export /, '');
}
const { waitPhase, canHostStart, startLabel, PHASE_HINT, PHASES } =
  new Function(`
    ${extract('PHASES')}
    ${extract('PHASE_HINT')}
    ${extract('waitPhase')}
    ${extract('canHostStart')}
    ${extract('startLabel')}
    return { waitPhase, canHostStart, startLabel, PHASE_HINT, PHASES };
  `)();

console.log('=== 階段判定 ===');
eq(waitPhase({isHost:true,  hasOpponent:false, meReady:false}), 'ph-share',
   '房主開房、對手還沒來 → 該做的是把房號傳出去');
eq(waitPhase({isHost:true,  hasOpponent:true,  meReady:false}), 'ph-ready',
   '房主、對手到了 → 該做的是確認校正並開始');
eq(waitPhase({isHost:false, hasOpponent:true,  meReady:false}), 'ph-guest-set',
   '訪客剛加入 → 該做的是校正並按準備');
eq(waitPhase({isHost:false, hasOpponent:true,  meReady:true }), 'ph-guest-wait',
   '訪客已準備 → 什麼都不用做');
/* 訪客的階段不該被「房主在不在」影響 —— 他該做的事一樣 */
eq(waitPhase({isHost:false, hasOpponent:false, meReady:false}), 'ph-guest-set',
   '訪客即使暫時看不到房主，該做的事仍是校正');

console.log('=== 每個階段都有提示文字 ===');
for(const p of PHASES){
  ok(typeof PHASE_HINT[p] === 'string' && PHASE_HINT[p].length > 0,
     `${p} 應該有提示文字`);
}

console.log('=== 開始鈕的門檻 ===');
const OP = {online:true, ready:true};
ok(canHostStart({opponent:OP, opponentCalibrating:false}), '對手在線且已準備 → 可以開始');
ok(!canHostStart({opponent:null, opponentCalibrating:false}), '沒有對手 → 不能開始');
ok(!canHostStart({opponent:{online:false, ready:true}, opponentCalibrating:false}),
   '對手離線 → 不能開始');
ok(!canHostStart({opponent:{online:true, ready:false}, opponentCalibrating:false}),
   '對手還沒按準備 → 不能開始（避免手機還在口袋裡就被開賽）');
ok(!canHostStart({opponent:OP, opponentCalibrating:true}),
   '對手正在校正 → 不能開始，否則會把人從校正中途拽走');

console.log('=== 擋住時要說明原因 ===');
eq(startLabel({opponent:null, opponentCalibrating:false}), '等對手加入', '沒對手時的文字');
eq(startLabel({opponent:{online:false,ready:true}, opponentCalibrating:false}), '對手連線中…', '對手離線時的文字');
eq(startLabel({opponent:OP, opponentCalibrating:true}), '等對方校正完', '對方校正中的文字');
eq(startLabel({opponent:{online:true,ready:false}, opponentCalibrating:false}), '等對手按準備', '對手未準備的文字');
eq(startLabel({opponent:OP, opponentCalibrating:false}), '開始', '可以開始時的文字');
/* 「校正中」要排在「未準備」前面：對方按過準備才去校正時，
   顯示「等對手按準備」會讓房主以為對方沒動作。 */
eq(startLabel({opponent:{online:true,ready:false}, opponentCalibrating:true}), '等對方校正完',
   '同時未準備又在校正 → 應優先說校正中（那才是正在發生的事）');

console.log('=== HTML 與 CSS 有跟上 ===');
const html = fs.readFileSync(rel('index.html'), 'utf8');
const css  = fs.readFileSync(rel('css/app.css'), 'utf8');
for(const id of ['calibPeer','peerState','peerHint','waitFoldBtn','waitFoldBody','waitFoldSum','wCalibBar']){
  ok(html.includes(`id="${id}"`), `index.html 應該有 #${id}`);
}
for(const p of PHASES){
  ok(css.includes(p), `app.css 應該用到階段 class ${p}`);
}
ok(css.includes('.peerfill'), 'app.css 應該有對手校正的掃描條 .peerfill');
ok(css.includes('peerScan'), 'app.css 應該有 peerScan 動畫');
/* 動畫的 selector 必須以 #wait.on 起頭，否則離開面板後還會繼續佔合成層 */
ok(/#wait\.on[^{]*\.peerfill\s*\{[^}]*animation/.test(css),
   'peerfill 的動畫 selector 要以 #wait.on 開頭，面板一離開就要停');
ok(/prefers-reduced-motion/.test(css.slice(css.indexOf('.peerfill') - 400)),
   'peerfill 動畫附近應有 prefers-reduced-motion 的出路');

console.log('=== calibrating 的清理路徑 ===');
const room = fs.readFileSync(rel('js/room.js'), 'utf8');
ok(/export async function setCalibrating/.test(room), 'room.js 應該有 setCalibrating');
/* 校正要 8.7 秒、手機躺在地上，斷線機率不低。
   沒有 onDisconnect 的話旗標會永遠卡在 true，對手畫面停在「對方正在校正」。 */
ok(/onDisconnect[\s\S]{0,200}calibrating|calibrating[\s\S]{0,400}onDisconnect/.test(room),
   'setCalibrating 開啟時必須掛 onDisconnect 清理');
const vsrc = src;
ok(/calibFlagTimer\s*=\s*setTimeout/.test(vsrc),
   'versus.js 應該有校正旗標的逾時保險（防流程卡住但沒斷線）');

console.log('');
console.log(fail ? `${pass} 通過 / ${fail} 失敗` : `全部通過（${pass} 通過 / 0 失敗）`);
process.exit(fail ? 1 : 0);
