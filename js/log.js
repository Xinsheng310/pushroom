/* 畫面內日誌 + 錯誤橫幅
   手機沒有 console，所以任何錯誤都直接印在畫面上。 */

const LOG = [];

export function log(m){
  LOG.push(new Date().toTimeString().slice(0,8) + '  ' + m);
  if(LOG.length > 60) LOG.shift();
  const el = document.getElementById('log');
  if(el){ el.textContent = LOG.join('\n'); el.scrollTop = el.scrollHeight; }
}

/* ============ 錯誤橫幅 ============

   原本的行為有三個問題，都會污染整段使用體驗：
     1. 永不消失 —— 一次早期失誤（例如模型載入失敗）會讓橘色橫幅
        永久釘在畫面底部，跨畫面殘留到結算的勝利瞬間。
     2. 沒有關閉方式 —— 使用者無法自己收掉。
     3. 蓋住底部按鈕 —— #err 是 fixed + z-index:99，
        小螢幕捲到底時會壓住「離開房間」「回首頁」這類按鈕。

   改成：可關閉、非致命的自動消失、切畫面時清掉非致命的。 */

const AUTO_HIDE_MS = 6000;
let hideTimer = null;
let currentFatal = false;

function errEl(){ return document.getElementById('err'); }

/**
 * @param {string} msg
 * @param {{fatal?:boolean}} [opts] fatal 的錯誤不自動消失也不隨切畫面清掉
 *        （例如相機權限被拒、模型載不起來 —— 那些不解決就無法使用）
 */
export function showErr(msg, opts = {}){
  const b = errEl();
  if(!b) return;
  const fatal = !!opts.fatal;
  currentFatal = fatal;

  b.textContent = '';
  const text = document.createElement('span');
  text.textContent = msg;              // 使用者輸入可能出現在錯誤訊息裡，一律 textContent
  b.appendChild(text);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'errclose';
  close.setAttribute('aria-label', '關閉');
  close.textContent = '✕';
  close.addEventListener('click', hideErr);
  b.appendChild(close);

  b.style.display = 'flex';
  log('錯誤：' + msg);

  clearTimeout(hideTimer);
  if(!fatal) hideTimer = setTimeout(hideErr, AUTO_HIDE_MS);
}

export function hideErr(){
  clearTimeout(hideTimer); hideTimer = null;
  currentFatal = false;
  const b = errEl();
  if(b){ b.style.display = 'none'; b.textContent = ''; }
}

/** 切換畫面時呼叫。致命錯誤留著（問題還在），其餘清掉避免跨畫面殘留。 */
export function clearTransientErr(){
  if(!currentFatal) hideErr();
}

export function installGlobalHandlers(){
  /* JS 例外只寫進畫面內日誌，不彈橫幅。
     對開發有用的 "Cannot read properties of null" 對使用者只是恐慌來源，
     而且那類錯誤通常無法由使用者處理。測試模式看得到就夠了。 */
  addEventListener('error', e => log('ERR ' + (e.message || e.type)));
  addEventListener('unhandledrejection', e => log('REJECT ' + (e.reason?.message || e.reason)));
}
