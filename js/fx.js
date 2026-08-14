/* 背景演出 — 等高線場（WebGL）

   這是「量測儀在校準你」方向的核心：背景不是裝飾，是狀態的視覺化。
     載入中     → 等高線扭動、密度高
     載入完成   → 整個場鎖定成規則同心圓（開機完成的訊號）
     對手加入   → 從單一中心變兩個中心互相干涉，中間浮出駐波帶
     結算       → 改畫你這場真實的每下時間戳

   ⚠ 最大的風險不是效能，是 WebGL context 數量。
   MediaPipe 自己持有一個 WebGL2 context，iOS Safari 對同頁面的
   context 數量限制很緊，超過就會強制回收最舊的 —— 而被回收的
   很可能正是 MediaPipe 那個，結果是姿勢偵測整個掛掉。
   那比「特效不夠酷」嚴重一百倍。

   所以有三條鐵律：
     1. 只建立一個 WebGL1 context（用 webgl 不用 webgl2，
        跟 MediaPipe 的 webgl2 分開資源池）。
     2. 進入需要推論的畫面前，主動 loseContext() 真的釋放掉，
        不是只暫停 rAF。離開後才重建。
     3. context lost 要有完整 fallback —— 移掉 canvas，
        首頁退回純 CSS 背景，使用者永遠不會看到破圖。 */

import { log } from './log.js';

/* 只有這些畫面可以開場。其餘（尤其 setup/run）一律釋放 context。
   跟 ui.js 的 SCAN_PANELS 同一個模式：集中管理，不靠各處記得關。 */
export const FX_PANELS = new Set(['home', 'lobby', 'wait', 'result', 'vsresult']);

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';

/* 等高線用 fract 取環帶、step 硬切成階 —— 不做連續漸層，
   那會立刻變成 2000 年代的音樂視覺化。
   顏色只有 ink 與 cool 兩軸：橘色永遠不進背景（橘＝需要立刻注意）。 */
/* fwidth() 在 WebGL1 需要 OES_standard_derivatives。
   沒有這個 extension shader 就編不過、整層背景會靜默消失，
   所以要在 acquire() 裡先啟用，並在編不過時退回無導數的版本。 */
const FRAG = `#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec2  uRes;
uniform float uTime;
uniform float uPower;    // 0=未上電 1=完全亮起
uniform float uLock;     // 0=流動抖動 1=鎖定成規則同心圓
uniform float uSecond;   // 0=單一中心 1=雙中心干涉（對手加入）
uniform float uWave;     // 1=改畫結算波形
uniform float uReps[40];
uniform float uN;

float hash(vec2 v){return fract(sin(dot(v,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 v){
  vec2 i=floor(v),f=fract(v);
  f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 v){
  float s=0.,a=.5;
  for(int i=0;i<4;i++){s+=a*noise(v);v*=2.03;a*=.5;}
  return s;
}

void main(){
  vec2 uv=(gl_FragCoord.xy-.5*uRes)/uRes.y;
  vec3 ink=vec3(.043,.059,.078), cool=vec3(.208,.878,.831);

  if(uWave>.5){
    /* 結算：每一下畫成一根尖峰。
       峰寬必須遠小於相鄰兩下的間距，否則幾十根會糊成一團，
       那就看不出節奏、失去整個意義。 */
    float x=gl_FragCoord.x/uRes.x;
    float y=0.;
    float near=1.0;
    for(int i=0;i<40;i++){
      if(float(i)>=uN) break;
      float dx=abs(x-uReps[i]);
      y=max(y, exp(-pow(dx*260.,2.)));
      near=min(near,dx);
    }
    /* 波形壓到畫面下三分之一。原本置中（uv.y+.10）正好在
       巨大數字後面 —— 那個數字是結算畫面的主角，不能被干擾。
       實測舊值在文字區的亮度到 210（ink 基準 15），完全讀不了。 */
    float base=uv.y+.30;
    float h=y*.24;
    float line=smoothstep(.010,0.,abs(base-h))*(.4+y*.6);
    float stem=step(near,.0012)*step(base,h)*step(-.02,base)*.28;
    /* 三者相加要收在 1 以內，否則會爆成純白。
       整體再乘 .22 —— 這是背景，不是主角。 */
    float ink_add=min(1., line+stem)*.22;
    gl_FragColor=vec4(ink+cool*ink_add*uPower,1.);
    return;
  }

  /* 中心：uSecond 打開時變兩個，中間形成干涉帶 */
  float d1=length(uv-vec2(-.30*uSecond,0.));
  float d2=length(uv-vec2( .30,0.));
  float d=mix(d1, min(d1,d2)*.72+abs(d1-d2)*.5, uSecond);

  /* 未鎖定時疊 fbm 讓等高線扭動；鎖定後收斂成規則同心圓 */
  float wob=fbm(uv*2.3+uTime*.08)*(1.-uLock);
  float v=d*7.5+wob*1.9-uTime*.10;

  /* 等高線必須是「線」而不是「帶」。
     原本用 step(.86,band) 等於讓每一圈有 14% 的寬度整片亮起，
     那不是等高線、那是同心色塊 —— 實機上直接蓋掉文字。

     改用「離環帶邊界的距離」畫細線：fwidth 讓線寬固定在
     一個像素左右，不隨圈數或螢幕密度變粗。 */
  float band=fract(v);
  float edge=min(band,1.-band);             // 到最近一條等高線的距離
  float w=fwidth(v)*1.2;                    // 一像素寬（螢幕空間）
  float c=1.-smoothstep(0.,w,edge);

  /* 中央的光暈拿掉。內容（大標、按鈕、狀態列）全部壓在中間，
     背景在那裡最亮等於刻意跟文字打對台。
     改成「越靠中央越暗」，把最暗的區域讓給文字。 */
  float clear=smoothstep(.0,.62,d);         // 中央 0 → 外圍 1

  gl_FragColor=vec4(ink+cool*c*.16*clear*uPower,1.);
}`;

/* 沒有 OES_standard_derivatives 時的退回版：
   用固定寬度取代 fwidth。線會略粗一點，但仍然是線而不是色塊。 */
const FRAG_NO_DERIV = FRAG
  .replace(/^#extension .*\n/m, '')
  .replace('float w=fwidth(v)*1.2;', 'float w=0.06;');

/* 目標值（外部設定）與目前值（每幀補間）分開，
   這樣呼叫端只要說「要變成什麼」，不必自己管動畫。 */
const target = { power:0, lock:0, second:0, wave:0 };
const cur    = { power:0, lock:0, second:0, wave:0 };
/* 補間速度（每毫秒的比例）。wave 不補間，切換是瞬間的。 */
const SPEED = { power:0.0016, lock:0.0022, second:0.0018 };

let gl = null, canvas = null, prog = null, u = null;
let raf = 0, lastT = 0;
let repData = new Float32Array(40);
let repN = 0;
let failed = false;         // 建立失敗或 context lost → 永久退回 CSS 背景

export const fxAlive = ()=> !!gl;
export const fxFailed = ()=> failed;

function compile(type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
    log('shader 編譯失敗：'+(gl.getShaderInfoLog(s)||'').slice(0,90));
    return null;
  }
  return s;
}

/** 建立 context。已經有了或已經放棄就不做事。 */
export function acquire(){
  if(gl || failed) return;
  canvas = document.getElementById('fx');
  if(!canvas) return;

  /* 刻意用 webgl 而非 webgl2 —— 跟 MediaPipe 的 webgl2 分開資源池，
     降低 iOS 上互相搶奪而被回收的機率。 */
  gl = canvas.getContext('webgl', {
    antialias:false, alpha:false, depth:false, stencil:false,
    powerPreference:'low-power', preserveDrawingBuffer:false,
  });
  if(!gl){ giveUp('取不到 WebGL'); return; }

  canvas.addEventListener('webglcontextlost', onLost, false);

  /* 先啟用導數（fwidth 用），沒有就用退回版的 shader */
  const hasDeriv = !!gl.getExtension('OES_standard_derivatives');
  const vs = compile(gl.VERTEX_SHADER, VERT);
  let fs = compile(gl.FRAGMENT_SHADER, hasDeriv ? FRAG : FRAG_NO_DERIV);
  /* 就算宣稱支援，某些驅動仍會編不過 —— 再退一次，不要直接放棄整層 */
  if(!fs && hasDeriv) fs = compile(gl.FRAGMENT_SHADER, FRAG_NO_DERIV);
  if(!vs || !fs){ giveUp('shader 編譯失敗'); return; }

  prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){ giveUp('program 連結失敗'); return; }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = n => gl.getUniformLocation(prog, n);
  u = { res:U('uRes'), time:U('uTime'), power:U('uPower'), lock:U('uLock'),
        second:U('uSecond'), wave:U('uWave'), reps:U('uReps[0]'), n:U('uN') };

  canvas.hidden = false;
  /* 只有真的建立成功才讓面板轉透明 —— 那些不透明底色是
     「相機不可透出」的最後一道防線，不能因為 fx 沒起來就失守。 */
  document.documentElement.classList.add('fxon');
  lastT = 0;
  raf = requestAnimationFrame(frame);
}

/**
 * 真的釋放 context，不是只暫停。
 * 進入需要推論的畫面前必須呼叫 —— 見檔頭第 2 條鐵律。
 */
export function release(){
  cancelAnimationFrame(raf); raf = 0;
  if(!gl) return;
  canvas?.removeEventListener('webglcontextlost', onLost, false);
  try{ gl.getExtension('WEBGL_lose_context')?.loseContext(); }catch(e){}
  gl = null; prog = null; u = null;
  document.documentElement.classList.remove('fxon');

  /* loseContext() 之後這個 <canvas> 元素就永久壞掉了 ——
     再對它 getContext('webgl') 只會拿到 null。
     所以要換一個乾淨的節點，否則從計數畫面回到首頁就再也沒有背景。
     （這是實測時才發現的：release 之後 acquire 永遠失敗。） */
  if(canvas){
    const fresh = canvas.cloneNode(false);
    fresh.hidden = true;
    canvas.replaceWith(fresh);
    canvas = fresh;
  }
  /* 下次 acquire 從頭開始上電，開機序列才會重播 */
  cur.power = 0; target.power = 0;
}

function onLost(e){
  e.preventDefault();
  giveUp('context lost');
}

/** 失敗就永久退回 CSS 背景。使用者不會看到破圖，只是少了演出。 */
function giveUp(why){
  log('背景演出停用（'+why+'）');
  failed = true;
  cancelAnimationFrame(raf); raf = 0;
  gl = null; prog = null; u = null;
  if(canvas) canvas.hidden = true;
  document.documentElement.classList.remove('fxon');
  document.documentElement.classList.add('nofx');
}

function resize(){
  /* dpr 上限 1.5：背景是低頻圖案，再高的解析度看不出差別，
     但填充率成本是平方成長。 */
  const d = Math.min(devicePixelRatio || 1, 1.5);
  const w = (canvas.clientWidth  * d) | 0;
  const h = (canvas.clientHeight * d) | 0;
  if(w === 0 || h === 0) return false;
  if(canvas.width !== w || canvas.height !== h){
    canvas.width = w; canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.uniform2f(u.res, w, h);
  return true;
}

function frame(t){
  raf = requestAnimationFrame(frame);
  if(!gl) return;
  const dt = lastT ? Math.min(t - lastT, 50) : 16;
  lastT = t;

  /* 朝目標補間。用「每毫秒逼近固定比例」而非固定時長，
     這樣中途改目標不會有跳動。 */
  for(const k of ['power','lock','second']){
    const diff = target[k] - cur[k];
    if(Math.abs(diff) < 0.001) cur[k] = target[k];
    else cur[k] += diff * Math.min(1, SPEED[k] * dt);
  }
  cur.wave = target.wave;

  if(!resize()) return;
  gl.uniform1f(u.time, t * 0.001);
  gl.uniform1f(u.power, cur.power);
  gl.uniform1f(u.lock, cur.lock);
  gl.uniform1f(u.second, cur.second);
  gl.uniform1f(u.wave, cur.wave);
  gl.uniform1fv(u.reps, repData);
  gl.uniform1f(u.n, repN);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* ============ 對外的狀態切換 ============ */

/** 上電（進場）。 */
export const fxPower = on => { target.power = on ? 1 : 0; };

/** 鎖定：模型載入完成時呼叫，整個場收斂成規則同心圓。 */
export const fxLock = on => { target.lock = on ? 1 : 0; };

/** 雙中心：對手加入時呼叫，場的拓撲改變、中間浮出干涉帶。 */
export const fxSecond = on => { target.second = on ? 1 : 0; };

/**
 * 切成結算波形。
 * @param {number[]} times 每一下的時間戳（毫秒，相對於開始）
 *
 * 用真實資料是這個效果的全部意義 —— 一旦改成裝飾性亂數，
 * 使用者第二次玩就會發現波形跟自己的節奏對不上，信任就崩了。
 */
export function fxWave(times){
  const n = Math.min(times?.length || 0, 40);
  if(!n){ target.wave = 0; repN = 0; return; }
  /* 正規化到 0.04–0.96，兩端留白免得首尾的峰被裁掉 */
  const span = times[n-1] || 1;
  const arr = new Float32Array(40);
  for(let i=0;i<n;i++) arr[i] = (times[i]/span) * 0.92 + 0.04;
  repData = arr; repN = n;
  target.wave = 1;
}

/** 離開結算，回到等高線場 */
export const fxField = ()=> { target.wave = 0; repN = 0; };
