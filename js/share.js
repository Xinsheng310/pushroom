/* 分享房號 — 規格第 6.2 節

   同時提供房號與帶參數的連結，兩者一起分享。
   優先使用 navigator.share()（系統原生分享選單，iOS/Android 都會列出 LINE）。
   不支援時退回複製到剪貼簿 + LINE URL scheme。

   不引入 LINE SDK 或 LIFF，不需要申請任何東西。 */

import { log } from './log.js';
import { shareUrl } from './roomcode.js';

/** 分享的文字內容。房號單獨一行，方便對方用眼睛讀或複製。 */
function shareText(code){
  return `來比伏地挺身\n房號 ${code}\n${shareUrl(code)}`;
}

export const canNativeShare = ()=> typeof navigator.share === 'function';

/**
 * 分享房號。
 * @param {string} code
 * @returns {Promise<'shared'|'copied'|'cancelled'|'failed'>}
 */
export async function shareCode(code){
  const text = shareText(code);

  if(canNativeShare()){
    try{
      /* title 不放房號 —— 有些 App 只取 title，會讓連結消失。
         把完整資訊放在 text，url 另外給，讓 App 自己決定怎麼組。 */
      await navigator.share({ title:'PUSH ROOM', text, url:shareUrl(code) });
      log('已透過系統分享選單分享');
      return 'shared';
    }catch(e){
      /* 使用者按取消也會 reject，這不是錯誤 */
      if(e.name==='AbortError'){ return 'cancelled'; }
      log('系統分享失敗，改用複製：'+(e.message||e).toString().slice(0,60));
    }
  }

  return (await copyText(text)) ? 'copied' : 'failed';
}

/** 複製到剪貼簿。有兩層退回方案，因為 clipboard API 在非安全來源或舊瀏覽器不可用。 */
export async function copyText(text){
  try{
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(text);
      return true;
    }
  }catch(e){ /* 往下試舊方法 */ }

  /* 舊方法：塞一個離屏 textarea 再 execCommand。
     iOS 需要 textarea 可見且未 readonly 才選得到，所以用透明而非 display:none。 */
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly','');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }catch(e){
    log('複製失敗：'+(e.message||e).toString().slice(0,60));
    return false;
  }
}

/** LINE 分享連結。不需要 SDK，純 URL scheme。 */
export function lineUrl(code){
  return 'https://line.me/R/msg/text/?' + encodeURIComponent(shareText(code));
}
