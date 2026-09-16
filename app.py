"""Koma desktop launcher: runs the server in the background and opens it
in a native window via pywebview. The server only listens on this machine.

Run:  python app.py [port]      (or pythonw app.py to hide the console)
"""
import os
import sys
import threading

import webview

from server import LIBRARY, announce, serve


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.makedirs(LIBRARY, exist_ok=True)   # so users can see where to drop manga
    httpd = serve("127.0.0.1", port)
    announce(httpd)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    webview.create_window(
        "Koma",
        f"http://127.0.0.1:{httpd.server_address[1]}/",
        width=1000,
        height=850,
        min_size=(500, 400),
    )
    webview.start()          # blocks until the window is closed
    httpd.shutdown()


if __name__ == "__main__":
    main()
