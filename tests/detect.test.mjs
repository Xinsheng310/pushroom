/* 差異測試：合成伏地挺身 landmark 序列，
   分別餵給「原始單檔版演算法」與「拆檔後的 detect.js」，
   比對 rep 數、depth 軌跡、校正分數是否完全一致。 */

globalThis.window = { AudioContext:null, webkitAudioContext:null };
globalThis.performance = { now: ()=>0 };

const mod = await import('../js/detect.js');

/* ---------- 原始版邏輯（從 pushup-arena-mvp.html 逐行抄來當對照組） ---------- */
const L={NOSE:0,LEYE:2,REYE:5,LEAR:7,REAR:8,LSHO:11,RSHO:12,LELB:13,RELB:14,LWRI:15,RWRI:16};
let AR=1;
const vis=(lm,i)=>(lm[i]?.visibility??0);
const dist=(lm,a,b)=>Math.hypot((lm[a].x-lm[b].x)*AR, lm[a].y-lm[b].y);
function angle(lm,a,b,c){
  const ux=(lm[a].x-lm[b].x)*AR, uy=lm[a].y-lm[b].y;
  const vx=(lm[c].x-lm[b].x)*AR, vy=lm[c].y-lm[b].y;
  const d=(ux*vx+uy*vy)/(Math.hypot(ux,uy)*Math.hypot(vx,vy)+1e-9);
  return Math.acos(Math.max(-1,Math.min(1,d)))*180/Math.PI;
}
const SIGNALS = {
  elbow:{ label:'手肘角度', get(lm){
    const ok=i=>vis(lm,i)>.5; let s=0,n=0;
    if(ok(L.LSHO)&&ok(L.LELB)&&ok(L.LWRI)){ s+=angle(lm,L.LSHO,L.LELB,L.LWRI); n++; }
    if(ok(L.RSHO)&&ok(L.RELB)&&ok(L.RWRI)){ s+=angle(lm,L.RSHO,L.RELB,L.RWRI); n++; }
    return n? s/n : null; } },
  eyes:{ label:'臉部距離', get(lm){
    return (vis(lm,L.LEYE)>.5&&vis(lm,L.REYE)>.5)? dist(lm,L.LEYE,L.REYE)*100 : null; } },
  shoulders:{ label:'肩寬', get(lm){
    return (vis(lm,L.LSHO)>.5&&vis(lm,L.RSHO)>.5)? dist(lm,L.LSHO,L.RSHO)*100 : null; } },
  height:{ label:'肩膀高度', get(lm){
    return (vis(lm,L.LSHO)>.5&&vis(lm,L.RSHO)>.5)? (lm[L.LSHO].y+lm[L.RSHO].y)/2*100 : null; } },
};
const bodyFound = lm => lm && (vis(lm,L.LSHO)>.5||vis(lm,L.RSHO)>.5||vis(lm,L.NOSE)>.6);
function robust(a){
  if(!a || a.length<10) return null;
  const s=[...a].sort((x,y)=>x-y);
  const med=s[(s.length>>1)];
  const dev=s.map(v=>Math.abs(v-med)).sort((x,y)=>x-y);
  return {m:med, sd:dev[(dev.length>>1)]*1.4826};
}
const PASS=2.0;
const TH={down:.72, up:.32};
const MIN_REP_MS=380, MIN_HOLD_MS=140;
const S={ phase:'idle', key:null, up:0, down:0, ema:null, depth:0,
          repState:'up', lastEdge:0, reps:0, times:[], startAt:0, endAt:0 };
function track(lm,ts){
  const raw = lm && S.key ? SIGNALS[S.key].get(lm) : null;
  if(raw==null) return null;
  S.ema = S.ema==null? raw : S.ema*0.62 + raw*0.38;
  let d=(S.ema-S.up)/((S.down-S.up)||1e-6);
  S.depth = d = Math.max(0,Math.min(1.25,d));
  if(S.repState==='up' && d>TH.down && ts-S.lastEdge>MIN_HOLD_MS){
    S.repState='down'; S.lastEdge=ts; return 'down';
  }
  if(S.repState==='down' && d<TH.up && ts-S.lastEdge>MIN_REP_MS){
    S.repState='up'; S.lastEdge=ts;
    S.reps++; S.times.push(ts-S.startAt);
    return 'rep';
  }
  return '';
}
function origFinishCalibration(samples){
  const report=[]; let best=null;
  for(const k in SIGNALS){
    const u=robust(samples[1]?.[k]), d=robust(samples[2]?.[k]);
    if(!u||!d){ report.push({k,score:null}); continue; }
    const score = Math.abs(u.m-d.m) / (u.sd+d.sd+1e-3);
    report.push({k,score,u:u.m,d:d.m});
    if(!best || score>best.score) best={key:k,up:u.m,down:d.m,score};
  }
  return {report,best};
}

/* ---------- 合成 landmark ---------- */
// 可重現的偽隨機（不用 Math.random，讓兩邊吃同一組資料）
let seed = 12345;
const rnd = ()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };

/** t: 0=頂點(手臂撐直) 1=最低點。jitter 模擬關節點跳動 */
function makeLm(t, jitter=0.002){
  const j = ()=> (rnd()-0.5)*2*jitter;
  // 頂點：肩膀高、臉遠、手肘直；最低點：肩膀低、臉近、手肘彎
  const shoY = 0.35 + t*0.22;
  const eyeGap = 0.075 - t*0.028;      // 靠近鏡頭 → 兩眼間距變大；此處模擬俯視放地上
  const shoGap = 0.30 - t*0.02;
  const elbowBend = t*0.16;            // 手腕往肩膀靠 → 夾角變小
  const lm = new Array(29).fill(null).map(()=>({x:0.5,y:0.5,visibility:0.0}));
  const set=(i,x,y,v=0.9)=>{ lm[i]={x:x+j(), y:y+j(), visibility:v}; };
  set(L.NOSE, 0.5, shoY-0.09);
  set(L.LEYE, 0.5-eyeGap/2, shoY-0.10);
  set(L.REYE, 0.5+eyeGap/2, shoY-0.10);
  set(L.LSHO, 0.5-shoGap/2, shoY);
  set(L.RSHO, 0.5+shoGap/2, shoY);
  set(L.LELB, 0.5-shoGap/2-0.06, shoY+0.13-elbowBend*0.3);
  set(L.RELB, 0.5+shoGap/2+0.06, shoY+0.13-elbowBend*0.3);
  set(L.LWRI, 0.5-shoGap/2-0.02+elbowBend, shoY+0.26-elbowBend);
  set(L.RWRI, 0.5+shoGap/2+0.02-elbowBend, shoY+0.26-elbowBend);
  return lm;
}

/* ---------- 1. 校正取樣：模組版 vs 原始版 ---------- */
function collectSamples(target, n){
  const bucket={};
  for(let i=0;i<n;i++){
    const lm=makeLm(target);
    for(const k in SIGNALS){ const v=SIGNALS[k].get(lm); if(v!=null) (bucket[k] ||= []).push(v); }
  }
  return bucket;
}
seed=12345; const up1=collectSamples(0,60), dn1=collectSamples(1,60);
seed=12345; const up2=collectSamples(0,60), dn2=collectSamples(1,60);

const origCal = origFinishCalibration({1:up1,2:dn1});
const modCal  = mod.scoreCalibration({1:up2,2:dn2});

const calSame = JSON.stringify(origCal)===JSON.stringify(modCal);
console.log('=== 校正分數 ===');
for(const r of modCal.report){
  console.log(`  ${SIGNALS[r.k].label.padEnd(6)} ${r.score==null?'無資料':r.score.toFixed(2)}`);
}
console.log('  採用：', modCal.best?.key, ' 分數', modCal.best?.score.toFixed(2),
            ' 通過門檻', PASS, '→', modCal.best?.score>=PASS ? 'PASS':'FAIL');
console.log('  與原始版一致：', calSame ? '✓' : '✗ 不一致！');

/* ---------- 2. 計數狀態機：跑 12 下伏地挺身 ---------- */
// 每下 1.6 秒，30fps；下壓 0.6s、底部停 0.15s、撐起 0.6s、頂部停 0.25s
function repProfile(phaseT){
  if(phaseT<0.375) return phaseT/0.375;                 // 下壓
  if(phaseT<0.469) return 1;                            // 底部
  if(phaseT<0.844) return 1-(phaseT-0.469)/0.375;       // 撐起
  return 0;                                             // 頂部
}
function runSeq(trackFn, state, cal, applyFn){
  applyFn(cal.best);
  const REPS=12, PERIOD=1600, FPS=30, DT=1000/FPS;
  const trace=[];
  for(let ts=0; ts<REPS*PERIOD; ts+=DT){
    const t = repProfile((ts%PERIOD)/PERIOD);
    const r = trackFn(makeLm(t), ts);
    trace.push(state.depth.toFixed(4)+':'+r);
  }
  return {reps:state.reps, times:state.times.map(t=>Math.round(t)), trace};
}

seed=999;
S.key=origCal.best.key; S.up=origCal.best.up; S.down=origCal.best.down; S.ema=null;
S.reps=0; S.times=[]; S.repState='up'; S.lastEdge=0; S.startAt=0;
const origRun = runSeq(track, S, origCal, ()=>{});

seed=999;
mod.S.key=modCal.best.key; mod.S.up=modCal.best.up; mod.S.down=modCal.best.down;
mod.resetCounter(); mod.S.startAt=0;
const modRun = runSeq(mod.track, mod.S, modCal, ()=>{});

console.log('\n=== 計數狀態機（合成 12 下） ===');
console.log('  原始版 reps =', origRun.reps);
console.log('  模組版 reps =', modRun.reps);
console.log('  depth 軌跡逐幀一致：', origRun.trace.join('|')===modRun.trace.join('|') ? '✓' : '✗ 不一致！');
console.log('  計數時間戳一致：', JSON.stringify(origRun.times)===JSON.stringify(modRun.times) ? '✓' : '✗');

/* ---------- 3. 邊界：看不到身體 / 半程不該計數 ---------- */
mod.resetCounter();
const nullRes = mod.track(null, 5000);
const emptyRes = mod.track(new Array(29).fill(null).map(()=>({x:.5,y:.5,visibility:0})), 5001);

// 半程：只下到 depth 0.5（低於 down 門檻 0.72）
mod.resetCounter(); mod.S.ema=null;
let halfReps=0;
for(let ts=0; ts<6*1600; ts+=1000/30){
  const t = repProfile((ts%1600)/1600)*0.5;   // 只做一半深度
  if(mod.track(makeLm(t), ts)==='rep') halfReps++;
}
console.log('\n=== 邊界情況 ===');
console.log('  lm=null 回傳 null：', nullRes===null ? '✓' : '✗ '+nullRes);
console.log('  visibility 全 0 回傳 null：', emptyRes===null ? '✓' : '✗ '+emptyRes);
console.log('  半程動作(6 下) 計數 =', halfReps, halfReps===0 ? '✓ 正確不計' : '✗ 誤計');

console.log('\n=== 常數核對（規格第 3 節） ===');
console.log('  SETTLE_MS', mod.SETTLE_MS, mod.SETTLE_MS===2200?'✓':'✗');
console.log('  HOLD_MS  ', mod.HOLD_MS, mod.HOLD_MS===1800?'✓':'✗');
console.log('  PASS     ', mod.PASS, mod.PASS===2.0?'✓':'✗');
console.log('  TH.down  ', mod.TH.down, mod.TH.down===0.72?'✓':'✗');
console.log('  TH.up    ', mod.TH.up, mod.TH.up===0.32?'✓':'✗');

const allOk = calSame && origRun.reps===modRun.reps
  && origRun.trace.join('|')===modRun.trace.join('|')
  && nullRes===null && emptyRes===null && halfReps===0;
console.log('\n' + (allOk ? '全部通過：拆檔後演算法行為與原始版逐幀相同' : '有差異，需檢查'));
process.exit(allOk?0:1);
