/* DOM 存取、面板切換、繪圖與清單渲染

   規格第 8 節：顯示任何使用者輸入的文字一律用 textContent，禁止 innerHTML。
   這裡所有清單都用建 DOM 的方式產生，不留 innerHTML 的路徑給未來誤用。 */

import { clearTransientErr } from './log.js';

export const $ = id => document.getElementById(id);

export const panels = {
  home:$('home'), setup:$('setup'), run:$('run'), result:$('result'), lab:$('lab'),
  name:$('name'), consent:$('consent'),
  lobby:$('lobby'), wait:$('wait'), vsresult:$('vsresult'), history:$('history'),
};

/* 進場動畫用 class 觸發，動畫結束移除，讓下次切換能重播。
   偏好減少動態時完全不加 class —— CSS 的 prefers-reduced-motion 會關掉
   animation，但留著 class 沒意義，也避免有人日後在該 class 上加樣式。 */
const reduceMotion = ()=>
  matchMedia('(prefers-reduced-motion: reduce)').matches;

let lastShown = null;

/* 哪些畫面該開掃描線。run/setup 一律關閉（見 setScan 的說明）。 */
const SCAN_PANELS = new Set(['wait']);

export const show = name =>{
  const changed = name !== lastShown;
  lastShown = name;
  /* 切畫面時自動管理掃描線，避免忘記關而讓它跟進計數畫面 */
  setScan(SCAN_PANELS.has(name) ? 'on' : 'off');
  /* 非致命的錯誤不該跟著使用者跨畫面，尤其不該出現在結算的勝利瞬間 */
  if(changed) clearTransientErr();
  Object.entries(panels).forEach(([k,el])=>{
    const on = k===name;
    el.classList.toggle('on', on);
    if(!on){ el.classList.remove('enter'); return; }
    if(!changed || reduceMotion()) return;
    /* 移除再加，強制重播動畫（同一個 class 連續加不會重新觸發） */
    el.classList.remove('enter');
    void el.offsetWidth;
    el.classList.add('enter');
  });
};

/* 動畫結束就卸掉 class，不要長期掛著（會固定佔一個合成層） */
for(const el of Object.values(panels)){
  el.addEventListener('animationend', e=>{
    if(e.target === el) el.classList.remove('enter');
  });
}

export const isLabOpen = ()=> panels.lab.classList.contains('on');

/* ============ 小工具 ============ */
export const fmt = ms => {
  const s = Math.ceil(ms/1000);
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
};

/** 建元素並設定文字，一律走 textContent */
function el(tag, text, cls){
  const n = document.createElement(tag);
  if(text != null) n.textContent = text;
  if(cls) n.className = cls;
  return n;
}

function replaceChildren(parent, nodes){
  parent.textContent = '';
  for(const n of nodes) parent.appendChild(n);
}

/* ============ 校正環 ============ */
const ringFg = $('ring').querySelector('.fg');
export const setRing = p => { ringFg.style.strokeDashoffset = 327*(1-p); };
export const setRingStroke = c => { ringFg.style.stroke = c; };
export const showRing = on => { $('ring').style.visibility = on?'visible':'hidden'; };

/* ============ 校正失敗的分數表 ============ */
/**
 * 攤開四個訊號各自的分數，讓使用者自己判斷，而不是只丟一句「訊號太弱」。
 * @param {Array<{k:string,score:number|null}>} report
 * @param {Object|null} best
 * @param {Object} SIGNALS
 * @param {number} PASS
 */
export function renderCalibReport(report, best, SIGNALS, PASS){
  const table = el('table', null, 'scores');
  const tbody = document.createElement('tbody');
  for(const r of report){
    const tr = document.createElement('tr');
    if(best && r.k===best.key && r.score>=PASS) tr.className = 'win';
    tr.appendChild(el('td', SIGNALS[r.k].label));
    tr.appendChild(el('td', r.score==null? '看不到' : r.score.toFixed(1)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const note = el('div',
    `分數要 ${PASS.toFixed(1)} 以上才算穩。分數低代表上下兩個姿勢在鏡頭裡差別不夠明顯，或是撐住時晃動太多。`);
  replaceChildren($('subSay'), [table, note]);
}

/* ============ 節奏條 ============ */
export function addTick(times){
  const n = times.length;
  const gap = n>1 ? times[n-1]-times[n-2] : 1500;
  const h = Math.max(6, Math.min(36, 54000/Math.max(gap,300)));
  const t = el('div', null, 'tick');
  t.style.height = h+'px';
  const c = $('cadence');
  c.appendChild(t);
  while(c.children.length>26) c.removeChild(c.firstChild);
}

export const clearTicks = ()=> { $('cadence').textContent = ''; };

/* ============ 掃描線 ============
   只在等待室與校正取樣期啟用。絕不在計數中開 —— 常駐動畫 + difference
   混色會吃掉推論預算，而掉幀會直接讓使用者少算次數。 */
export function setScan(mode){
  const el = $('scan');
  el.classList.toggle('on', mode === 'on' || mode === 'fast');
  el.classList.toggle('fast', mode === 'fast');
}

/* ============ 深度計的門檻標記 ============
   把兩條判定線畫到刻度尺上。原本散在五處各自設 markDown，
   集中成一個函式才不會漏掉其中一條。 */
export function setGaugeMarks(th){
  $('markDown').style.bottom = (th.down*100)+'%';
  $('markUp').style.bottom   = (th.up*100)+'%';
}

/* ============ 倒數演出 ============ */
/**
 * 顯示一個倒數數字或 GO。單機與對戰共用，確保兩邊演出一致。
 * @param {number|'GO'} v
 */
export function showCountdown(v){
  const el = $('say');
  const isGo = v === 'GO';
  el.textContent = isGo ? 'GO' : String(v);
  el.classList.add('count');
  el.classList.remove('tick','go');
  void el.offsetWidth;                     // 強制重播
  el.classList.add(isGo ? 'go' : 'tick');
}

/** 離開倒數畫面時清掉，否則校正提示會變成巨大字 */
export function clearCountdown(){
  $('say').classList.remove('count','tick','go');
}

/* ============ 全螢幕閃光 ============
   只動 opacity，是計數中唯一安全的全螢幕效果。 */
/**
 * @param {number} [strength=.22] 峰值不透明度
 * @param {string} [color] 省略則用 CSS 的預設（訊號橘）
 */
export function flash(strength = .22, color){
  const f = $('flash');
  if(color) f.style.background = color;
  f.style.transition = 'none';
  f.style.opacity = String(strength);
  requestAnimationFrame(()=>{
    f.style.transition = 'opacity .24s ease-out';
    f.style.opacity = '0';
  });
}

/* 計數回饋。原本 .30 偏亮且蓋滿全屏 220ms，
   降到 .18 把視覺預算讓給數字本身（技術美術建議）。 */
export function pulse(){ flash(.18); }

/* ============ 數字滾動 ============
   結算的總數從 0 跑到最終值。這是最便宜的多巴胺：
   一個 rAF 迴圈只改 textContent，此時相機推論已關閉，預算充足。 */
/**
 * @param {string} id 目標元素 id
 * @param {number} to 最終值
 * @param {number} [ms=700] 總時長
 * @param {(n:number,i:number)=>void} [onStep] 每次跳號的回呼（用來配音效）
 */
export function rollNumber(id, to, ms = 700, onStep){
  const el = $(id);
  const target = Math.max(0, Math.floor(to));
  if(reduceMotion() || target === 0){ el.textContent = String(target); return; }

  const t0 = performance.now();
  let shown = -1, done = false;
  const finishNow = ()=>{
    if(done) return;
    done = true;
    el.textContent = String(target);
  };

  const step = ()=>{
    if(done) return;
    const p = Math.min(1, (performance.now()-t0)/ms);
    /* ease-out：開頭快、結尾慢，最後幾個數字看得清楚 */
    const n = Math.round(target * (1 - Math.pow(1-p, 3)));
    if(n !== shown){
      shown = n;
      el.textContent = String(n);
      onStep?.(n, shown);
    }
    if(p < 1) requestAnimationFrame(step);
    else finishNow();
  };
  requestAnimationFrame(step);

  /* 保險：rAF 在背景分頁或未合成的環境完全不會觸發，
     那時數字會永遠停在 0。用 timeout 補上最終值。 */
  setTimeout(finishNow, ms + 120);
}

/** 一次性播放某個 class 的動畫（移除→重排→加回，強制重播） */
export function replay(el, cls){
  if(reduceMotion()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/* ============ 結算節奏圖 ============ */
export function drawChart(times, dur){
  const c = $('chart'), dpr = Math.min(devicePixelRatio||1, 2);
  const w = c.clientWidth, h = 56;
  c.width = w*dpr; c.height = h*dpr;
  const x = c.getContext('2d');
  x.setTransform(dpr,0,0,dpr,0,0); x.clearRect(0,0,w,h);
  x.strokeStyle = 'rgba(255,255,255,.13)';
  x.beginPath(); x.moveTo(0,h-.5); x.lineTo(w,h-.5); x.stroke();
  if(!times.length || !dur) return;
  x.fillStyle = '#FF5A1F';
  times.forEach((t,i)=>{
    const gap = i? t-times[i-1] : 1500;
    const bh = Math.max(5, Math.min(h-4, 42000/Math.max(gap,300)));
    x.fillRect((t/dur)*(w-3), h-bh, 3, bh);
  });
  x.fillStyle = 'rgba(255,255,255,.35)';
  x.font = '10px "Roboto Mono",monospace';
  x.fillText('每根 = 一下，越高代表越快', 0, 11);
}

/* ============ 測試模式：系統檢查清單 ============ */
export function renderChecks(rows){
  replaceChildren($('checks'), rows.map(([k,ok,note])=>{
    const li = el('li', null, ok?'ok':'bad');
    li.appendChild(document.createTextNode(k));
    li.appendChild(el('small', note));
    return li;
  }));
}

/* ============ 測試模式：即時訊號表 ============ */
export function renderSignalRows(SIGNALS){
  const tb = $('sigTable').querySelector('tbody');
  const keys = Object.keys(SIGNALS);
  if(tb.children.length === keys.length) return;
  replaceChildren(tb, keys.map(k=>{
    const tr = document.createElement('tr');
    tr.dataset.k = k;
    tr.appendChild(el('td', SIGNALS[k].label));
    tr.appendChild(el('td', '—'));
    return tr;
  }));
}

/* ============ 戰績清單 ============
   對手暱稱是使用者輸入的文字，一律走 textContent（規格第 8 節）。 */
/**
 * @param {Array} rows [{verdict:'win'|'loss'|'draw', opName, myReps, opReps, when, durationSec}]
 */
export function renderMatchList(rows){
  const VERDICT = { win:'勝', loss:'敗', draw:'和' };
  replaceChildren($('matchList'), rows.map(r=>{
    const li = document.createElement('li');
    li.appendChild(el('div', VERDICT[r.verdict] || '—', 'verdict '+r.verdict));
    const who = el('div', null, 'who');
    who.appendChild(el('b', r.opName || '對手'));
    who.appendChild(el('small', [r.when, r.durationSec ? r.durationSec+' 秒' : '']
      .filter(Boolean).join(' · ')));
    li.appendChild(who);
    li.appendChild(el('div', `${r.myReps} : ${r.opReps}`, 'score mono'));
    return li;
  }));
}

export function updateSignalRow(k, value, isPicked){
  const tr = $('sigTable').querySelector(`tr[data-k="${k}"]`);
  if(!tr) return;
  tr.classList.toggle('off', value==null);
  tr.classList.toggle('pick', isPicked);
  tr.lastElementChild.textContent = value==null? '看不到' : value.toFixed(1);
}
