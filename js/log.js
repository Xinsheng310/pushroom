/* 畫面內日誌 + 錯誤橫幅
   手機沒有 console，所以任何錯誤都直接印在畫面上。 */

const LOG = [];

export function log(m){
  LOG.push(new Date().toTimeString().slice(0,8) + '  ' + m);
  if(LOG.length > 60) LOG.shift();
  const el = document.getElementById('log');
  if(el){ el.textContent = LOG.join('\n'); el.scrollTop = el.scrollHeight; }
}

export function showErr(msg){
  const b = document.getElementById('err');
  b.textContent = msg;
  b.style.display = 'block';
}

export function hideErr(){
  document.getElementById('err').style.display = 'none';
}

export function installGlobalHandlers(){
  addEventListener('error', e => {
    log('ERR ' + (e.message || e.type));
    showErr('JS 錯誤：' + e.message);
  });
  addEventListener('unhandledrejection', e => {
    log('REJECT ' + (e.reason?.message || e.reason));
  });
}
