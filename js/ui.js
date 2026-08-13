/* DOM 存取、面板切換、繪圖與清單渲染

   規格第 8 節：顯示任何使用者輸入的文字一律用 textContent，禁止 innerHTML。
   這裡所有清單都用建 DOM 的方式產生，不留 innerHTML 的路徑給未來誤用。 */

export const $ = id => document.getElementById(id);

export const panels = {
  home:$('home'), setup:$('setup'), run:$('run'), result:$('result'), lab:$('lab'),
  name:$('name'), consent:$('consent'),
};

export const show = name =>
  Object.entries(panels).forEach(([k,el]) => el.classList.toggle('on', k===name));

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

/* ============ 計數閃光 ============ */
export function pulse(){
  const f = $('flash');
  f.style.transition = 'none';
  f.style.opacity = '.30';
  requestAnimationFrame(()=>{ f.style.transition='opacity .22s ease-out'; f.style.opacity='0'; });
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

export function updateSignalRow(k, value, isPicked){
  const tr = $('sigTable').querySelector(`tr[data-k="${k}"]`);
  if(!tr) return;
  tr.classList.toggle('off', value==null);
  tr.classList.toggle('pick', isPicked);
  tr.lastElementChild.textContent = value==null? '看不到' : value.toFixed(1);
}
