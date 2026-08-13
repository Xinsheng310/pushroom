/* 相機 + MediaPipe Pose Landmarker + 骨架繪製 */

import { log, showErr, hideErr } from './log.js';

/* ============ landmark 索引 ============ */
export const L = {
  NOSE:0, LEYE:2, REYE:5, LEAR:7, REAR:8,
  LSHO:11, RSHO:12, LELB:13, RELB:14, LWRI:15, RWRI:16,
};

const CONNS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];

export const vis = (lm,i) => (lm[i]?.visibility ?? 0);

/* ============ 相機 ============ */
let stream = null;
export const getStream = ()=> stream;

/** 相機是否正在供幀（enabled=false 時仍持有裝置但不耗電於曝光） */
export function isCameraLive(){
  const t = stream?.getVideoTracks?.()[0];
  return !!t && t.readyState === 'live' && t.enabled;
}

/**
 * 暫停/恢復供幀。這不是 stop() —— 裝置仍被持有，
 * 恢復是即時的、不需重新授權、不需等曝光收斂。
 */
export function setCameraPaused(paused){
  const t = stream?.getVideoTracks?.()[0];
  if(!t) return false;
  if(t.enabled === !paused) return false;   // 已經是目標狀態
  t.enabled = !paused;
  return true;
}

/**
 * 完整釋放相機。省電最徹底，但代價是：
 * iOS 重新 getUserMedia 可能再次要求授權，且曝光收斂要 0.5–2 秒。
 * 所以只在「確定不會馬上用到」時呼叫（見 main.js 的省電策略）。
 */
export function releaseCamera(){
  if(!stream) return false;
  stream.getTracks().forEach(t=>{ try{ t.stop(); }catch(e){} });
  stream = null;
  log('相機已釋放（省電）');
  return true;
}

/**
 * 開啟相機。cfg.front 決定前/後鏡頭，前鏡頭時鏡像顯示。
 * @param {{front:boolean}} cfg
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} skel
 */
export async function openCamera(cfg, video, skel){
  try{
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('insecure');
    stream?.getTracks().forEach(t=>t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{ facingMode: cfg.front?'user':'environment', width:{ideal:960}, height:{ideal:720}, frameRate:{ideal:30} }
    });
    video.srcObject = stream; await video.play();
    video.classList.toggle('mirror', cfg.front);
    skel.classList.toggle('mirror', cfg.front);
    hideErr();
  }catch(e){
    /* 相機失敗是致命的 —— 不給權限就完全不能計數，不該自動消失 */
    const fail = msg => { showErr(msg, {fatal:true}); log('相機：'+msg); };
    if(e.message==='insecure' || !window.isSecureContext)
      fail('這個頁面不是安全來源，瀏覽器不給用相機。請用 https:// 網址開啟（或 localhost）。直接開本機檔案是不行的。');
    else if(e.name==='NotAllowedError') fail('相機權限被拒。到瀏覽器網站設定把相機打開，再重新整理。');
    else fail('開不了相機：'+e.name);
  }
}

/* ============ 姿勢模型 ============ */
let landmarker = null, modelStatus = '載入中';
export const getLandmarker = ()=> landmarker;
export const getModelStatus = ()=> modelStatus;

const CDNS = [
  {name:"jsdelivr",      mod:"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14",
                         wasm:"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"},
  {name:"jsdelivr/+esm", mod:"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm",
                         wasm:"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"},
  {name:"unpkg",         mod:"https://unpkg.com/@mediapipe/tasks-vision@0.10.14",
                         wasm:"https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm"},
];
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

/**
 * 依序試三個 CDN，每個再試 GPU → CPU。
 * @param {(ok:boolean)=>void} onReady 成功或全部失敗時回呼
 */
export async function loadModel(onReady){
  for(const cdn of CDNS){
    try{
      log('載入 '+cdn.name+' …');
      // 一定要從套件根目錄 import，不能指 vision_bundle.mjs（那是 default export）
      const raw = await import(/* @vite-ignore */ cdn.mod);
      const ns  = (raw?.FilesetResolver ? raw : raw?.default) || {};
      const {FilesetResolver, PoseLandmarker} = ns;
      if(!FilesetResolver||!PoseLandmarker) throw new Error('取不到具名匯出，keys='+Object.keys(raw||{}).slice(0,6));
      const files = await FilesetResolver.forVisionTasks(cdn.wasm);
      log('wasm ok，載入模型權重…');
      for(const delegate of ["GPU","CPU"]){
        try{
          landmarker = await PoseLandmarker.createFromOptions(files,{
            baseOptions:{ modelAssetPath:MODEL, delegate },
            runningMode:"VIDEO", numPoses:1,
            minPoseDetectionConfidence:.5, minPosePresenceConfidence:.5, minTrackingConfidence:.5
          });
          modelStatus = '已載入 · '+cdn.name+' · '+delegate;
          log('模型就緒（'+delegate+'）');
          onReady(true);
          return;
        }catch(e){ log(delegate+' 失敗：'+(e.message||e).toString().slice(0,90)); }
      }
      throw new Error('GPU/CPU 都建立失敗');
    }catch(e){
      log('✗ '+cdn.name+'：'+(e.message||e).toString().slice(0,120));
    }
  }
  modelStatus = '載入失敗';
  onReady(false);
  showErr('偵測模型載不下來，可能是網路不穩。重新整理再試一次。', {fatal:true});
}

/* ============ 骨架繪製 ============ */

/* 骨架顏色隨下壓深度從冷青燒到訊號橘。
   預先建表避免每幀組字串（規格第 7 節：訓練中不做重度運算）。
   這是「免費演出」：同一個 canvas 的同一次繪製，額外成本趨近零，
   但使用者趴在地上看到的是自己的身體在下壓時整條骨架燒起來 ——
   而且它同時是功能性回饋：告訴他「系統看到你下去了」。 */
const DEPTH_STEPS = 16;
const DEPTH_COLORS = Array.from({length:DEPTH_STEPS+1}, (_,i)=>{
  const t = i/DEPTH_STEPS;
  /* 冷青 53,224,212 → 訊號橘 255,90,31 */
  const r = Math.round( 53 + (255- 53)*t);
  const g = Math.round(224 + ( 90-224)*t);
  const b = Math.round(212 + ( 31-212)*t);
  return `rgba(${r},${g},${b},${(0.55 + 0.3*t).toFixed(2)})`;
});
const DEPTH_WIDTHS = Array.from({length:DEPTH_STEPS+1}, (_,i)=> 2.5 + 2*(i/DEPTH_STEPS));

/**
 * @param {number} [depth] 0~1.25 的下壓深度，用來決定骨架顏色。
 *                         未提供時用預設冷青（例如校正中還沒有基準）。
 */
export function drawSkeleton(sctx, skel, video, lm, depth){
  const dpr = Math.min(devicePixelRatio||1, 2);
  const cw = skel.clientWidth, ch = skel.clientHeight;
  if(skel.width !== cw*dpr){ skel.width = cw*dpr; skel.height = ch*dpr; }
  sctx.setTransform(dpr,0,0,dpr,0,0);
  sctx.clearRect(0,0,cw,ch);
  if(!lm) return;
  const vw = video.videoWidth, vh = video.videoHeight; if(!vw) return;
  const k = Math.max(cw/vw, ch/vh), dx = (cw-vw*k)/2, dy = (ch-vh*k)/2;
  const P = i => [dx+lm[i].x*vw*k, dy+lm[i].y*vh*k];
  /* 深度 0~1 映到查表；沒有深度資訊時用最淺的那格（冷青） */
  const di = depth == null ? 0
    : Math.max(0, Math.min(DEPTH_STEPS, Math.round(depth*DEPTH_STEPS)));
  sctx.strokeStyle = DEPTH_COLORS[di];
  sctx.lineWidth = DEPTH_WIDTHS[di];
  sctx.lineCap = 'round';
  sctx.beginPath();
  for(const [a,b] of CONNS){
    if(vis(lm,a)>.5 && vis(lm,b)>.5){ const A=P(a), B=P(b); sctx.moveTo(A[0],A[1]); sctx.lineTo(B[0],B[1]); }
  }
  sctx.stroke();
  sctx.fillStyle = 'rgba(255,255,255,.85)';
  for(const i of [0,11,12,13,14,15,16]){
    if(vis(lm,i)>.5){ const [x,y]=P(i); sctx.beginPath(); sctx.arc(x,y,3.5,0,7); sctx.fill(); }
  }
}
