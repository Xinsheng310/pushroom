/* 音效 — 全部用 Web Audio 合成，沒有任何素材檔。

   聲音是動作中唯一的回饋頻道（iOS Safari 不支援震動），
   這組音色是實機調校過的，改動前先問人類。見規格第 7 節。 */

let actx = null;

/** 必須由使用者手勢觸發（iOS 限制）。任何按鈕的 click 都會呼叫這個。 */
export function audioOn(){
  if(!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if(actx.state === 'suspended') actx.resume();
}

export function audioState(){
  return actx ? actx.state : null;
}

function tone({f=880, dur=.1, type='sine', gain=.5, slideTo=null, delay=0}){
  if(!actx) return;
  const t0 = actx.currentTime + delay;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t0);
  if(slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0+dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0+.008);
  g.gain.exponentialRampToValueAtTime(.0001, t0+dur);
  o.connect(g).connect(actx.destination);
  o.start(t0); o.stop(t0+dur+.05);
}

export const sfx = {
  /* 到最低點：低頻悶響 */
  bottom: ()=> tone({f:150, dur:.09, type:'triangle', gain:.35}),
  /* 完成一下：音高隨連續次數走五音階上行，每 5 下循環。
     每 5 下、每 10 下疊一層和聲當里程碑 —— 使用者趴著看不到畫面，
     用聽覺告訴他「又過一個檻」。 */
  rep: (n)=>{
    const step = [0,2,4,7,9][(n-1)%5];
    const f = 660*Math.pow(2, step/12);
    tone({f, dur:.13, type:'square', gain:.22});
    tone({f:f*2, dur:.1, type:'sine', gain:.16});
    if(n % 10 === 0){
      /* 每 10 下：五度和聲 + 八度，明顯的成就感 */
      tone({f:f*1.5, dur:.26, type:'sine', gain:.16, delay:.03});
      tone({f:f*3,   dur:.2,  type:'sine', gain:.09, delay:.05});
    }else if(n % 5 === 0){
      /* 每 5 下：只加五度，比較含蓄 */
      tone({f:f*1.5, dur:.18, type:'sine', gain:.11, delay:.03});
    }
  },
  tick:  ()=> tone({f:1000, dur:.06, type:'sine', gain:.3}),
  go:    ()=> tone({f:520, dur:.5, type:'sawtooth', gain:.3, slideTo:1040}),
  ready: ()=> tone({f:1320, dur:.16, type:'sine', gain:.3}),
  end:   ()=>{
    tone({f:330, dur:.7, type:'sawtooth', gain:.3, slideTo:160});
    tone({f:220, dur:.7, type:'square', gain:.2, delay:.05});
  },
  warn:  ()=> tone({f:440, dur:.12, type:'triangle', gain:.25}),

  /* 對戰專用 —— 都是「不搶走自己節奏」的低調音色 */
  /** 對手完成一下：低音撥弦。刻意比自己的音效暗、短，
      讓你知道他在動但不會誤以為是自己的計數。 */
  oppRep: ()=>{
    tone({f:98, dur:.14, type:'triangle', gain:.16});
    tone({f:196, dur:.09, type:'sine', gain:.07, delay:.01});
  },
  /** 對手加入房間：上行雙音，社交產品的魔法時刻 */
  joined: ()=>{
    tone({f:660, dur:.12, type:'sine', gain:.22});
    tone({f:880, dur:.18, type:'sine', gain:.2, delay:.1});
  },
  /** 贏了：上行大三和弦 */
  win: ()=>{
    [523,659,784,1046].forEach((f,i)=>
      tone({f, dur:.5, type:'sine', gain:.2 - i*0.03, delay:i*0.07}));
  },
  /** 輸了：下行、短、不刺耳。安靜比噪音有份量。 */
  lose: ()=>{
    tone({f:392, dur:.32, type:'triangle', gain:.2});
    tone({f:294, dur:.42, type:'triangle', gain:.16, delay:.14});
  },
  /** 平手：同音兩下 */
  draw: ()=>{
    tone({f:440, dur:.2, type:'sine', gain:.2});
    tone({f:440, dur:.28, type:'sine', gain:.15, delay:.16});
  },
};

/* ============ 深度驅動的持續音 ============
   接近最低點時的漸強嗡鳴。使用者趴在地上、視線 40 公分、手臂在抖 ——
   聲音的資訊帶寬遠大於視覺，而 Web Audio 在獨立 thread 跑，GPU 成本為零。
   這是規格第 7 節「聲音是動作中唯一的回饋頻道」還沒吃滿的部分。 */
let humOsc = null, humGain = null, humFilter = null;

export function humStart(){
  if(!actx || humOsc) return;
  try{
    humOsc = actx.createOscillator();
    humGain = actx.createGain();
    humFilter = actx.createBiquadFilter();
    humOsc.type = 'sawtooth';
    humOsc.frequency.value = 62;
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 200;
    humGain.gain.value = 0;
    humOsc.connect(humFilter).connect(humGain).connect(actx.destination);
    humOsc.start();
  }catch(e){ humOsc = null; }
}

/**
 * 依深度更新嗡鳴。0 無聲，接近 1 時最明顯。
 * @param {number} depth 0~1.25
 */
export function humSet(depth){
  if(!actx || !humGain) return;
  /* 只有深度過半才開始出聲 —— 否則整場都在嗡嗡叫很煩 */
  const t = Math.max(0, Math.min(1, (depth - .45) / .55));
  const g = t*t*0.075;                     // 平方讓漸強更有加速感
  const now = actx.currentTime;
  humGain.gain.setTargetAtTime(g, now, .05);
  humFilter.frequency.setTargetAtTime(180 + t*520, now, .05);
}

export function humStop(){
  if(!humOsc) return;
  try{
    humGain.gain.setTargetAtTime(0, actx.currentTime, .04);
    const o = humOsc, g = humGain;
    humOsc = null; humGain = null; humFilter = null;
    setTimeout(()=>{ try{ o.stop(); o.disconnect(); g.disconnect(); }catch(e){} }, 300);
  }catch(e){ humOsc = null; humGain = null; humFilter = null; }
}
