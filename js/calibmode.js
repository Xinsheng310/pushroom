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
  custom: {
    label: '自訂',
    hint: '雙方各自用自己在測試模式調的門檻',
    th: null,          // null = 各自沿用本機設定
  },
};

export const DEFAULT_MODE = 'standard';

export const isValidMode = m => Object.prototype.hasOwnProperty.call(MODES, m);

export const modeLabel = m => MODES[m]?.label ?? MODES[DEFAULT_MODE].label;
export const modeHint  = m => MODES[m]?.hint  ?? MODES[DEFAULT_MODE].hint;

/**
 * 取得某模式該套用的門檻。
 * @param {string} mode
 * @returns {{down:number,up:number}|null} null 代表「不要改，用本機現有的」
 */
export function thresholdsFor(mode){
  const m = MODES[mode] || MODES[DEFAULT_MODE];
  return m.th ? { ...m.th } : null;
}
