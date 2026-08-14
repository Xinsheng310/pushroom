/* 對戰診斷 — 實測用的即時狀態窗

   為什麼需要這個：兩台裝置的對戰只能靠人類實測，而出問題時
   使用者能提供的只有「畫面卡住了」「數字沒動」這類症狀描述。
   房間狀態、時鐘偏移、雙方旗標這些真正能定位問題的資料，
   當下沒有任何地方看得到 —— 等回到測試模式時現場已經消失了。

   這支把那些資料即時攤在畫面上，並記下最近的狀態轉換。
   實測遇到怪狀況時直接截圖，就有完整的現場。

   三個原則：
     1. 預設關閉。一般使用者不該看到，也不該付它的成本。
     2. 只讀不寫。絕不碰房間狀態 —— 診斷工具弄壞被診斷的東西是最糟的。
     3. 更新頻率獨立於主迴圈，且只在打開時才跑。
        計數中主執行緒很緊，不能讓它跟推論搶。 */

import { $ } from './ui.js';
import { getOffset, isSynced, serverNow } from './clock.js';

/** 更新頻率。2Hz 足夠看狀態變化，又不會跟推論搶主執行緒。 */
const TICK_MS = 500;
/** 事件記錄保留幾筆 */
const MAX_EVENTS = 6;

let on = false;
let timer = null;
let getView = null;          // () => 房間視角（由 versus.js 注入）
let getLocal = null;         // () => 本機狀態
const events = [];

/** localStorage 記住開關，實測時重整不用再打開一次 */
const KEY = 'pushroom.diag.v1';

/**
 * @param {()=>object|null} viewFn  取得目前房間視角
 * @param {()=>object} localFn      取得本機狀態（相位、reps、校正等）
 */
export function installDiag(viewFn, localFn){
  getView = viewFn;
  getLocal = localFn;
  try{ if(localStorage.getItem(KEY) === '1') setDiag(true); }catch(e){}
}

export const diagOn = ()=> on;

export function setDiag(next){
  on = !!next;
  const el = $('diag');
  if(el) el.hidden = !on;
  try{ localStorage.setItem(KEY, on ? '1' : '0'); }catch(e){}
  clearInterval(timer); timer = null;
  if(on){
    render();
    timer = setInterval(render, TICK_MS);
  }
}

export function toggleDiag(){ setDiag(!on); }

/**
 * 記一筆事件。這是診斷面板最有價值的部分 ——
 * 「什麼時候發生了什麼」比「現在是什麼狀態」更能定位問題。
 * 即使面板關著也照記，打開時就能看到剛才發生過什麼。
 */
export function diagEvent(msg){
  const t = new Date().toTimeString().slice(3,8);   // mm:ss
  events.push(t + ' ' + msg);
  if(events.length > MAX_EVENTS) events.shift();
  if(on) render();
}

function fmtSide(s){
  if(!s) return '—';
  const bits = [];
  bits.push(String(s.reps ?? 0) + '下');
  if(s.online === false) bits.push('離線');
  if(s.ready) bits.push('已備');
  if(s.calibrating) bits.push('校正中');
  return bits.join(' · ');
}

function render(){
  const box = $('diagBody');
  if(!box) return;

  const v = getView?.() || null;
  const L = getLocal?.() || {};

  const rows = [];
  rows.push(['相位', L.phase ?? '—']);
  rows.push(['我的數', String(L.reps ?? 0) + (L.manual ? '（手動）' : '')]);
  rows.push(['訊號', L.calibKey ? L.calibKey + ' ' + (L.base ?? '') : '未校正']);
  /* 本場門檻與自己的門檻分開顯示。對戰套用統一標準時兩者會不同，
     那正是「這場公不公平」的關鍵，不該藏起來。 */
  rows.push(['門檻', L.th + (L.th !== L.myTh ? '（本場）' : '')]);

  /* 時鐘偏移是對戰最容易出問題又最看不見的東西。
     倒數對不齊、比賽長度不一樣，幾乎都是這個值異常。 */
  const off = getOffset();
  rows.push(['時鐘', (isSynced() ? '已同步 ' : '未同步 ') +
    (off >= 0 ? '+' : '') + Math.round(off) + 'ms']);

  if(v){
    rows.push(['房號', v.code + '（' + (v.isHost ? '房主' : '訪客') + '）']);
    rows.push(['房間狀態', v.state + (v.startAt ? ' @' + (v.startAt % 100000) : '')]);
    rows.push(['我', fmtSide(v.me)]);
    rows.push(['對手', fmtSide(v.opponent)]);
    rows.push(['標準', v.calibMode + (v.hostTh ? ' ' + v.hostTh.down + '/' + v.hostTh.up : '')]);
    if(v.startAt){
      const left = v.startAt - serverNow();
      if(left > -2000) rows.push(['開賽倒數', Math.round(left) + 'ms']);
    }
  }else{
    rows.push(['房間', '不在房間內']);
  }

  /* 全部用 textContent —— 房號與暱稱都是使用者可控的字串（規格第 8 節） */
  box.textContent = '';
  for(const [k, val] of rows){
    const line = document.createElement('div');
    line.className = 'diagrow';
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('b');    b.textContent = val;
    line.append(a, b);
    box.appendChild(line);
  }

  const ev = $('diagEvents');
  if(ev) ev.textContent = events.length ? events.join('\n') : '（還沒有事件）';
}
