/* 效能量測 — 讓「加了這個特效有沒有掉幀」變成可回答的問題

   為什麼需要這個：規格第 7 節說掉幀會直接傷害計數準確度
   （推論頻率下降 → 動作的上下邊緣被錯過 → 少算次數）。
   但「有沒有掉幀」用肉眼看不出來，靠感覺調特效等於瞎猜。

   為什麼看 p95 而不是平均：掉幀是尾端現象。
   平均值會把偶發的 80ms 長幀藏在一堆 33ms 裡面。 */

const CAP = 240;          // 約 8 秒 @30fps 的滾動窗

const mk = ()=>({ buf:new Float32Array(CAP), n:0, i:0 });
const infer = mk();       // 單次推論耗時
const frame = mk();       // 連續兩幀的間隔（真實幀時間）

/* 長幀計數：45ms 約等於掉 1 幀（30fps 基準），80ms 是明顯卡頓 */
let long45 = 0, long80 = 0, frames = 0;
let lastFrameAt = -1;

function push(s, v){
  s.buf[s.i] = v;
  s.i = (s.i+1) % CAP;
  if(s.n < CAP) s.n++;
}

export function perfInfer(ms){ push(infer, ms); }

export function perfFrame(ts){
  if(lastFrameAt >= 0){
    const dt = ts - lastFrameAt;
    push(frame, dt);
    frames++;
    if(dt > 80) long80++;
    else if(dt > 45) long45++;
  }
  lastFrameAt = ts;
}

/** 進入/離開偵測相位時呼叫，避免把「暫停期間」算成一個超長幀 */
export function perfGap(){ lastFrameAt = -1; }

export function perfReset(){
  infer.n = infer.i = 0; frame.n = frame.i = 0;
  long45 = long80 = frames = 0; lastFrameAt = -1;
}

function pct(s, p){
  if(!s.n) return 0;
  const a = Array.prototype.slice.call(s.buf, 0, s.n).sort((x,y)=>x-y);
  return a[Math.min(a.length-1, Math.floor(a.length*p))];
}

/**
 * @returns {{infer:{p50,p95,max}, frame:{p50,p95,max}, long45, long80, frames, fps}}
 */
export function perfStats(){
  const f50 = pct(frame,.5);
  return {
    infer: { p50:pct(infer,.5), p95:pct(infer,.95), max:pct(infer,1) },
    frame: { p50:f50,           p95:pct(frame,.95), max:pct(frame,1) },
    long45, long80, frames,
    fps: f50 ? Math.round(1000/f50) : 0,
  };
}

/** 給測試模式顯示的單行摘要 */
export function perfLine(){
  const s = perfStats();
  if(!s.frames) return '尚未取樣';
  return `推論 ${s.infer.p50.toFixed(1)}/${s.infer.p95.toFixed(1)}ms · `
       + `幀 ${s.frame.p50.toFixed(1)}/${s.frame.p95.toFixed(1)}ms · `
       + `${s.fps}fps · 長幀 ${s.long45}+${s.long80}`;
}
