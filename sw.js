/* Service Worker — 只快取靜態資源，不做離線對戰（規格第 9 節）

   幾個刻意的限制：

   1. 只處理「自己網域的 GET」。Firebase 的即時連線、MediaPipe 的
      wasm/模型都必須直接走網路 —— 快取即時資料會讓對手的比分停在舊值，
      那比沒有快取糟糕得多。

   2. HTML 用 network-first：程式更新後要立刻生效。
      拿不到網路才回快取（至少開得起來、能看到「連不上」的畫面）。

   3. 其他靜態資源用 stale-while-revalidate：先給快取（開得快），
      同時背景更新。下次開就是新版。

   4. 換版時清掉舊快取，避免舊 JS 與新 HTML 混搭。 */

const VERSION = 'v9';
const CACHE = 'pushroom-' + VERSION;

/* 這些是「App 的骨架」，安裝時就抓下來 */
const PRECACHE = [
  './',
  './index.html',
  './css/app.css',
  './js/main.js',
  './js/log.js',
  './js/audio.js',
  './js/pose.js',
  './js/detect.js',
  './js/ui.js',
  './js/firebase.js',
  './js/firebase-config.js',
  './js/auth.js',
  './js/matches.js',
  './js/room.js',
  './js/roomcode.js',
  './js/clock.js',
  './js/share.js',
  './js/versus.js',
  './js/calibmode.js',
  './js/calibstore.js',
  './js/perf.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e=>{
  e.waitUntil((async ()=>{
    if(!DEV){
      const c = await caches.open(CACHE);
      /* 個別 add，一個失敗不要讓整個安裝失敗 */
      await Promise.allSettled(PRECACHE.map(u=>c.add(new Request(u, {cache:'reload'}))));
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e=>{
  e.waitUntil((async ()=>{
    const names = await caches.keys();
    await Promise.all(names.filter(n=>n!==CACHE).map(n=>caches.delete(n)));
    await self.clients.claim();
  })());
});

/* 本機開發時完全不介入 —— 開發中改了檔案卻被快取供應舊版，
   會變成「明明改了卻沒效果」的假 bug，非常難查。
   正式環境（github.io）才啟用快取。 */
const DEV = self.location.hostname === 'localhost'
         || self.location.hostname === '127.0.0.1';

/** 這個請求該不該被 SW 處理 */
function shouldHandle(req){
  if(DEV) return false;
  if(req.method !== 'GET') return false;
  const url = new URL(req.url);
  /* 只管自己的網域。Firebase / MediaPipe / Google Fonts 一律直接走網路。 */
  if(url.origin !== self.location.origin) return false;
  /* Range 請求（影片/音訊分段）不適合這種快取策略 */
  if(req.headers.has('range')) return false;
  return true;
}

const isHtml = req =>
  req.mode === 'navigate' ||
  (req.headers.get('accept') || '').includes('text/html');

self.addEventListener('fetch', e=>{
  const req = e.request;
  if(!shouldHandle(req)) return;      // 不呼叫 respondWith = 交給瀏覽器原生處理

  if(isHtml(req)){
    /* network-first：程式更新要立刻生效 */
    e.respondWith((async ()=>{
      try{
        const fresh = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone()).catch(()=>{});
        return fresh;
      }catch(err){
        const cached = await caches.match(req);
        return cached || caches.match('./index.html');
      }
    })());
    return;
  }

  /* stale-while-revalidate：先給快取，背景更新 */
  e.respondWith((async ()=>{
    const cached = await caches.match(req);
    const network = fetch(req).then(res=>{
      if(res && res.ok){
        caches.open(CACHE).then(c=>c.put(req, res.clone())).catch(()=>{});
      }
      return res;
    }).catch(()=> null);
    return cached || (await network) || new Response('離線', {status:503});
  })());
});

/* 讓頁面可以要求立刻換版 */
self.addEventListener('message', e=>{
  if(e.data === 'skipWaiting') self.skipWaiting();
});
