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
  /* 完成一下：音高隨連續次數走五音階上行，每 5 下循環 */
  rep: (n)=>{
    const step = [0,2,4,7,9][(n-1)%5];
    const f = 660*Math.pow(2, step/12);
    tone({f, dur:.13, type:'square', gain:.22});
    tone({f:f*2, dur:.1, type:'sine', gain:.16});
  },
  tick:  ()=> tone({f:1000, dur:.06, type:'sine', gain:.3}),
  go:    ()=> tone({f:520, dur:.5, type:'sawtooth', gain:.3, slideTo:1040}),
  ready: ()=> tone({f:1320, dur:.16, type:'sine', gain:.3}),
  end:   ()=>{
    tone({f:330, dur:.7, type:'sawtooth', gain:.3, slideTo:160});
    tone({f:220, dur:.7, type:'square', gain:.2, delay:.05});
  },
  warn:  ()=> tone({f:440, dur:.12, type:'triangle', gain:.25}),
};
