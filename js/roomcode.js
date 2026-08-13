/* 四碼房號 — 產生與正規化

   規格第 6.1 節：
     - 四碼，字元集為大寫英數但排除 0 O 1 I L
     - 輸入時大小寫不敏感，並自動將常見誤輸入正規化
     - 建立時檢查碰撞

   為什麼排除那五個字元：房號要用嘴巴念給旁邊的人聽、或用手打進去。
   0/O、1/I/L 在多數字型下難以分辨，唸起來也一樣（「歐」「愛」）。
   排除後剩 31 個字元，31^4 = 923,521 種組合，對「朋友之間開房」夠用。 */

/** 字元集：A-Z 去掉 O I L，2-9（去掉 0 1）。共 31 個。 */
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 4;

/* 使用者可能打錯或聽錯的字元 → 對應到字元集裡的字元。

   被排除的五個字元本身也要能被修正 —— 使用者不知道我們排除了什麼，
   他看到房號念成「歐」就可能打 O 或 0，兩者都得導向同一個結果。

   O/0 → Q：形近，且 Q 在字元集裡。
   I/1/L/| → J：這四個在各種字型下互相混淆，統一導向 J。 */
const FIXES = {
  '0':'Q', 'O':'Q',
  '1':'J', 'I':'J', 'L':'J', '|':'J',
};

/**
 * 產生一組隨機房號。用 crypto 而非 Math.random —— 房號可猜中就等於能偷看別人的房間。
 * @returns {string} 例如 "K7M2"
 */
export function makeCode(){
  const out = new Array(CODE_LEN);
  const buf = new Uint32Array(CODE_LEN);
  crypto.getRandomValues(buf);
  for(let i=0;i<CODE_LEN;i++){
    /* 取模會有極輕微的偏差（2^32 不是 31 的倍數），
       對「別人猜不到」這個需求來說完全可接受。 */
    out[i] = ALPHABET[buf[i] % ALPHABET.length];
  }
  return out.join('');
}

/**
 * 把使用者輸入正規化成合法房號。
 * 大小寫不敏感、去掉空白與連字號、修正常見誤輸入。
 * @param {string} raw
 * @returns {string} 正規化後的字串（可能仍不足四碼，由 isValidCode 判斷）
 */
export function normalizeCode(raw){
  const s = (raw ?? '').toString().toUpperCase();
  let out = '';
  for(const ch of s){
    if(ch===' '||ch==='-'||ch==='_') continue;          // 分隔符直接忽略
    const fixed = FIXES[ch] ?? ch;
    /* 修正後仍不在字元集裡的（標點、中文、emoji…）直接丟掉 */
    if(ALPHABET.includes(fixed)) out += fixed;
    if(out.length>=CODE_LEN) break;
  }
  return out;
}

/** 是否為合法的四碼房號（已正規化的字串） */
export function isValidCode(code){
  return typeof code==='string'
      && code.length===CODE_LEN
      && [...code].every(c=>ALPHABET.includes(c));
}

/** 從網址取出房號（規格第 6.2 節的 ?room=XXXX），取不到回傳 null */
export function codeFromUrl(search = location.search){
  const raw = new URLSearchParams(search).get('room');
  if(!raw) return null;
  const c = normalizeCode(raw);
  return isValidCode(c) ? c : null;
}

/** 房號的分享連結 */
export function shareUrl(code){
  return location.origin + location.pathname + '?room=' + code;
}
