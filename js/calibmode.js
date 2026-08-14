/* 校正模式 — 對戰時雙方套用同一組門檻

   為什麼只統一門檻、不統一基準：

   校正產出兩種東西
     1. 基準（up / down 的絕對數值）—— 綁定這台裝置的鏡頭距離、角度、使用者身材。
        例：肩膀高度 上=42.3 下=61.8。搬到對手手機上會完全錯亂
        （他手機放得遠，肩膀在畫面裡就小，套用你的基準可能整場判不到一下）。
     2. 門檻（TH.down / TH.up）—— 「要下到基準的百分之幾才算一下」，
        是比例值，與裝置無關。

   所以公平性靠統一門檻達成：雙方各自校正自己的基準，但「算不算一下」的
   標準完全相同。這也是規格第 3.3 節的深度定義本來就成立的性質。 */

/** 標準 = 實機調校過的預設值（規格第 3.3 節），不要隨意改動 */
export const MODES = {
  standard: {
    label: '標準',
    hint: '要下到接近最低點才算一下',
    th: { down:0.72, up:0.32 },
  },
  loose: {
    label: '寬鬆',
    hint: '下到一半多就算，適合新手或體力用盡時',
    th: { down:0.58, up:0.40 },
  },
  hostth: {
    label: '房主的標準',
    hint: '雙方都用房主在測試模式調的門檻',
    th: null,          // 由房間的 hostTh 節點提供，見 thresholdsFor
    fromRoom: true,
  },
  custom: {
    label: '自訂',
    hint: '雙方各自用自己在測試模式調的門檻',
    th: null,          // null = 各自沿用本機設定
  },
};

/** 門檻的合法範圍，與測試模式的滑桿及安全規則一致 */
export const TH_RANGE = { down:[0.4,0.95], up:[0.05,0.6] };

/** 檢查一組門檻是否合法可用 */
export function validTh(th){
  return !!th
      && Number.isFinite(th.down) && Number.isFinite(th.up)
      && th.down >= TH_RANGE.down[0] && th.down <= TH_RANGE.down[1]
      && th.up   >= TH_RANGE.up[0]   && th.up   <= TH_RANGE.up[1]
      && th.down > th.up;
}

export const DEFAULT_MODE = 'standard';

export const isValidMode = m => Object.prototype.hasOwnProperty.call(MODES, m);

export const modeLabel = m => MODES[m]?.label ?? MODES[DEFAULT_MODE].label;
export const modeHint  = m => MODES[m]?.hint  ?? MODES[DEFAULT_MODE].hint;

/**
 * 取得某模式該套用的門檻。
 * @param {string} mode
 * @param {{down:number,up:number}} [roomTh] 房間帶來的門檻（hostth 模式用）
 * @returns {{down:number,up:number}|null} null 代表「不要改，用本機現有的」
 */
export function thresholdsFor(mode, roomTh){
  const m = MODES[mode] || MODES[DEFAULT_MODE];
  if(m.fromRoom){
    /* 房主門檻。房間裡的值不合法（沒寫進去、或被改壞）就退回標準 ——
       退回標準比套用壞值安全：壞值可能讓整場判不到一下。 */
    if(validTh(roomTh)) return { down:roomTh.down, up:roomTh.up };
    return { ...MODES[DEFAULT_MODE].th };
  }
  return m.th ? { ...m.th } : null;
}

/* ============ 單人模式 ============

   單人沒有「房主」這個概念，所以 hostth 要排除掉。
   而 custom 的說明文字是為對戰寫的（「雙方各自用…」），
   單人語境要換一句。 */

export const SOLO_MODES = ['standard', 'loose', 'custom'];

/** 單人語境的說明文字。只有 custom 需要覆寫。 */
export function soloModeHint(m){
  if(m === 'custom') return '用你在測試模式自己調的門檻';
  return modeHint(m);
}
