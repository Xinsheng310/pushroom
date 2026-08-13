"""開發用的靜態伺服器。

python -m http.server 不送任何 Cache-Control，瀏覽器於是把 js 模組
長期快取起來 —— 改了程式重新整理卻還是跑舊的，這在開發時會浪費大量時間
（而且很容易誤判成「程式沒生效」而去改別的地方）。

這支只多做一件事：對所有回應加上 no-store。
正式站不受影響，那邊由 GitHub Pages 與 service worker 負責快取。

用法：python tools/devserver.py [port]
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只留錯誤，不然每個模組都印一行、洗掉真正的訊息
        if not args or not str(args[0]).startswith(("GET", "HEAD")):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"開發伺服器：http://localhost:{port}（已停用快取）")
    ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
