/* 校正模式測試 — 公平性的核心保證

   對戰公平的定義：雙方套用「同一組門檻」，但各自校正「自己的基準」。
     - 門檻（TH.down/up）是比例值，與裝置無關 → 必須統一
     - 基準（up/down 絕對值）綁定鏡頭距離/角度/身材 → 不可共用

   這支測試鎖住「同一個 mode 一定產生同一組門檻」這件事，
   以及深度計算在不同基準下仍然對齊同樣的判定比例。 */

const { MODES, DEFAULT_MODE, isValidMode, modeLabel, modeHint, thresholdsFor, validTh, TH_RANGE }
  = await import('../js/calibmode.js');

let pass=0, fail=0;
const check=(name,ok,detail='')=>{
  if(ok){ pass++; console.log('  ✓ '+name); }
  else  { fail++; console.log('  ✗ '+name+(detail?'  ← '+detail:'')); }
};

/* ================= 模式定義 ================= */
console.log('\n=== 模式定義 ===');
check('有 standard / loose / hostth / custom 四種',
      ['standard','loose','hostth','custom'].every(m=>m in MODES));
check('預設是 standard', DEFAULT_MODE==='standard');
check('標準 = 實機調校過的預設值 0.72 / 0.32',
      MODES.standard.th.down===0.72 && MODES.standard.th.up===0.32,
      JSON.stringify(MODES.standard.th));
check('寬鬆確實比標準寬（下壓門檻更低）',
      MODES.loose.th.down < MODES.standard.th.down,
      `寬鬆 ${MODES.loose.th.down} vs 標準 ${MODES.standard.th.down}`);
check('寬鬆的回頂門檻比標準高（更容易判定回到頂點）',
      MODES.loose.th.up > MODES.standard.th.up,
      `寬鬆 ${MODES.loose.th.up} vs 標準 ${MODES.standard.th.up}`);
check('自訂模式回傳 null（沿用本機設定）', thresholdsFor('custom')===null);
check('每個模式都有中文標籤與說明',
      Object.values(MODES).every(m=>m.label && m.hint));

/* 門檻本身要合理：down 必須大於 up，否則狀態機會亂跳 */
console.log('\n=== 門檻合理性 ===');
for(const [key,m] of Object.entries(MODES)){
  if(!m.th) continue;
  check(`${key}: down > up（不然狀態機會抖動）`, m.th.down > m.th.up,
        `down=${m.th.down} up=${m.th.up}`);
  check(`${key}: 兩者都在 0~1.25 之間`,
        m.th.down>0 && m.th.down<=1.25 && m.th.up>=0 && m.th.up<1.25);
  /* 兩門檻之間要有足夠間距，否則訊號雜訊會造成連續誤判 */
  check(`${key}: 門檻間距 >= 0.15（抗雜訊）`, (m.th.down-m.th.up)>=0.15,
        String((m.th.down-m.th.up).toFixed(2)));
}

/* ================= 未知模式的容錯 ================= */
console.log('\n=== 容錯 ===');
check('isValidMode 認得四種', ['standard','loose','hostth','custom'].every(isValidMode));
check('isValidMode 拒絕亂填', !isValidMode('hacked') && !isValidMode(''));
check('未知模式退回標準門檻',
      JSON.stringify(thresholdsFor('hacked'))===JSON.stringify(MODES.standard.th));
check('undefined 退回標準門檻',
      JSON.stringify(thresholdsFor(undefined))===JSON.stringify(MODES.standard.th));
check('未知模式的標籤退回標準', modeLabel('hacked')===MODES.standard.label);
check('未知模式的說明退回標準', modeHint('hacked')===MODES.standard.hint);
/* 原型污染：不可透過 __proto__ 之類的鍵取到東西 */
check('__proto__ 不被當成合法模式', !isValidMode('__proto__'));
check('constructor 不被當成合法模式', !isValidMode('constructor'));

/* ================= 房主門檻模式 ================= */
console.log('\n=== 房主門檻（hostth）===');
const hostTh = { down:0.66, up:0.28 };
check('★ 套用房主帶來的門檻',
      JSON.stringify(thresholdsFor('hostth', hostTh))===JSON.stringify(hostTh),
      JSON.stringify(thresholdsFor('hostth', hostTh)));
check('★ 雙方讀同一組 hostTh 得到相同門檻',
      JSON.stringify(thresholdsFor('hostth',hostTh))===JSON.stringify(thresholdsFor('hostth',hostTh)));

/* 房間裡的值可能沒寫進去、或被改壞。退回標準比套用壞值安全：
   壞值（例如 down<up）會讓狀態機永遠停在某一邊，整場判不到一下。 */
const STD = JSON.stringify(MODES.standard.th);
check('hostTh 缺失 → 退回標準', JSON.stringify(thresholdsFor('hostth', null))===STD);
check('hostTh 為 undefined → 退回標準', JSON.stringify(thresholdsFor('hostth'))===STD);
check('hostTh down<up（顛倒）→ 退回標準',
      JSON.stringify(thresholdsFor('hostth',{down:0.2,up:0.8}))===STD);
check('hostTh 超出範圍（down 過大）→ 退回標準',
      JSON.stringify(thresholdsFor('hostth',{down:1.5,up:0.3}))===STD);
check('hostTh 超出範圍（down 過小）→ 退回標準',
      JSON.stringify(thresholdsFor('hostth',{down:0.1,up:0.05}))===STD);
check('hostTh 非數字 → 退回標準',
      JSON.stringify(thresholdsFor('hostth',{down:'0.7',up:0.3}))===STD);
check('hostTh 為 NaN → 退回標準',
      JSON.stringify(thresholdsFor('hostth',{down:NaN,up:0.3}))===STD);
check('hostTh 為空物件 → 退回標準',
      JSON.stringify(thresholdsFor('hostth',{}))===STD);

console.log('\n=== validTh ===');
check('合法門檻通過', validTh({down:0.72,up:0.32}));
check('邊界值通過（down 0.4 / up 0.6 不成立因 down<up）', !validTh({down:0.4,up:0.6}));
check('down 上界 0.95 通過', validTh({down:0.95,up:0.5}));
check('up 下界 0.05 通過', validTh({down:0.5,up:0.05}));
check('down 超過上界不通過', !validTh({down:0.96,up:0.3}));
check('up 低於下界不通過', !validTh({down:0.7,up:0.04}));
check('null 不通過', !validTh(null));
check('down==up 不通過', !validTh({down:0.5,up:0.5}));
check('Infinity 不通過', !validTh({down:Infinity,up:0.3}));
check('範圍常數與安全規則一致',
      TH_RANGE.down[0]===0.4 && TH_RANGE.down[1]===0.95
      && TH_RANGE.up[0]===0.05 && TH_RANGE.up[1]===0.6);

/* ================= 公平性：同模式 → 同門檻 ================= */
console.log('\n=== 公平性核心 ===');
const aTh = thresholdsFor('standard');
const bTh = thresholdsFor('standard');
check('★ 雙方讀同一個 mode 得到完全相同的門檻',
      aTh.down===bTh.down && aTh.up===bTh.up);
check('回傳的是複本，改動不會污染模式定義',
      (()=>{ const t=thresholdsFor('standard'); t.down=9; return MODES.standard.th.down===0.72; })());

/* 深度公式：d = (ema - up) / (down - up)
   基準不同（不同裝置）但門檻相同時，「做到同樣比例的動作」必須得到同樣判定。 */
const depth = (ema, up, down)=> Math.max(0, Math.min(1.25, (ema-up)/((down-up)||1e-6)));

/* A 裝置：肩膀高度 上=42.3 下=61.8（手機放得近）
   B 裝置：肩膀高度 上=20.1 下=28.4（手機放得遠，數值範圍小很多） */
const A = {up:42.3, down:61.8}, B = {up:20.1, down:28.4};
const th = thresholdsFor('standard');

for(const frac of [0.0, 0.5, 0.72, 0.9, 1.0]){
  const emaA = A.up + frac*(A.down-A.up);
  const emaB = B.up + frac*(B.down-B.up);
  const dA = depth(emaA, A.up, A.down), dB = depth(emaB, B.up, B.down);
  check(`★ 做到 ${(frac*100).toFixed(0)}% 深度：兩裝置的 depth 一致（${dA.toFixed(3)}）`,
        Math.abs(dA-dB)<1e-9, `A=${dA} B=${dB}`);
}

/* 判定一致性刻意不測「正好等於門檻」的點。
   在 frac=0.72 時 A 算出 0.7199999999999999734、B 算出 0.7200000000000000844
   （差 1.1e-16 的浮點表示誤差），剛好落在 > 0.72 的兩側。
   那是浮點數的性質，不是公平性問題 —— 實際動作是 30fps 取樣再過 EMA 的
   連續訊號，不可能精準停在門檻上第 16 位小數。
   所以這裡測「門檻附近但不在門檻上」的判定一致性。 */
for(const frac of [0.0, 0.5, 0.70, 0.74, 0.9, 1.0]){
  const dA = depth(A.up + frac*(A.down-A.up), A.up, A.down);
  const dB = depth(B.up + frac*(B.down-B.up), B.up, B.down);
  check(`→ ${(frac*100).toFixed(0)}% 深度：兩裝置對「是否算下壓」判定相同`,
        (dA>th.down)===(dB>th.down),
        `A:${dA>th.down} B:${dB>th.down}`);
}

/* 寬鬆模式確實讓半程動作也算 */
console.log('\n=== 寬鬆真的更寬嗎 ===');
const half = depth(A.up + 0.65*(A.down-A.up), A.up, A.down);   // 做到 65% 深度
check('做到 65% 深度：標準不算下壓', !(half > MODES.standard.th.down), String(half.toFixed(2)));
check('做到 65% 深度：寬鬆算下壓', half > MODES.loose.th.down);

console.log(`\n${fail===0?'全部通過':'有 '+fail+' 項失敗'}（${pass} 通過 / ${fail} 失敗）`);
process.exit(fail===0?0:1);
