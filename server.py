"""Tiny manga reader server. No dependencies beyond the Python standard library.

Library layout (sorted naturally):
    library/<Series>/<Chapter>/<page images>      folder chapter
    library/<Series>/<Chapter>.cbz                archive chapter (zip of images; .zip works too)
    library/<Series>.cbz                          a whole series in one archive; folders inside
                                                  the archive become chapters

Run:  python server.py [port]
"""
import json
import os
import posixpath
import re
import sys
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote

if getattr(sys, "frozen", False):
    # Running as a PyInstaller executable: the frontend is packed inside the bundle,
    # while the library lives next to the .exe so users can find it.
    ROOT = os.path.dirname(os.path.abspath(sys.executable))
    STATIC = os.path.join(sys._MEIPASS, "static")
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
    STATIC = os.path.join(ROOT, "static")
LIBRARY = os.path.join(ROOT, "library")
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"}
ARCHIVE_EXT = {".cbz", ".zip"}
CONTENT_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".avif": "image/avif",
}
BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def clean_name(name):
    """Make a folder/file name safe to write inside the library."""
    name = BAD_CHARS.sub("", name).strip(" .")
    if not name or name in (".", ".."):
        raise ValueError("bad name")
    return name


class Server(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR lets two servers bind the same port, so turn it off there
    # to make the port-in-use fallback below actually trigger.
    allow_reuse_address = sys.platform != "win32"


def serve(host="127.0.0.1", port=8000):
    """Create the server (local machine only), falling back to a random free port if `port` is taken."""
    try:
        return Server((host, port), Handler)
    except OSError:
        return Server((host, 0), Handler)


# ---------------------------------------------------------------- library scan

def natural_key(name):
    """Sort so that 'ch2' < 'ch10'."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def ext(name):
    return os.path.splitext(name)[1].lower()


def is_image(name):
    base = posixpath.basename(name.replace("\\", "/"))
    return ext(base) in IMAGE_EXT and not base.startswith(".")


def is_archive(name):
    return ext(name) in ARCHIVE_EXT


def stem(name):
    return os.path.splitext(name)[0]


_archive_cache = {}   # archive path -> ((mtime, size), [image entry names])


def archive_images(path):
    """Image entries inside a zip, naturally sorted. Cached until the file changes."""
    try:
        key = (os.path.getmtime(path), os.path.getsize(path))
    except OSError:
        return []
    cached = _archive_cache.get(path)
    if cached and cached[0] == key:
        return cached[1]
    names = []
    try:
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                n = info.filename
                if info.is_dir() or "__MACOSX/" in n or not is_image(n):
                    continue
                names.append(n)
    except (zipfile.BadZipFile, OSError):
        names = []
    names.sort(key=lambda n: natural_key(n.replace("\\", "/")))
    _archive_cache[path] = (key, names)
    return names


def archive_chapters(path, url_prefix, default_name):
    """Chapters from one archive. If images sit in several folders inside the archive,
    each folder becomes a chapter; otherwise the whole archive is one chapter."""
    groups = {}
    for n in archive_images(path):
        groups.setdefault(posixpath.dirname(n.replace("\\", "/")), []).append(n)
    if not groups:
        return []
    chapters = []
    for folder in sorted(groups, key=natural_key):
        name = posixpath.basename(folder) if len(groups) > 1 and folder else default_name
        chapters.append({
            "name": name,
            "pages": [quote(f"{url_prefix}/{n}") for n in groups[folder]],
        })
    return chapters


def dedupe(chapters):
    seen = {}
    for c in chapters:
        n = seen.get(c["name"], 0) + 1
        seen[c["name"]] = n
        if n > 1:
            c["name"] = f'{c["name"]} ({n})'
    return chapters


def scan_series_dir(series, series_dir):
    chapters = []
    entries = sorted(os.listdir(series_dir),
                     key=lambda e: natural_key(stem(e) if is_archive(e) else e))
    for entry in entries:
        full = os.path.join(series_dir, entry)
        if os.path.isdir(full):
            pages = sorted((f for f in os.listdir(full) if is_image(f)), key=natural_key)
            if pages:
                chapters.append({
                    "name": entry,
                    "pages": [quote(f"/library/{series}/{entry}/{p}") for p in pages],
                })
        elif is_archive(entry):
            chapters.extend(archive_chapters(full, f"/cbz/{series}/{entry}", stem(entry)))
    return dedupe(chapters)


def scan_library():
    series_list = []
    if not os.path.isdir(LIBRARY):
        return series_list
    entries = sorted(os.listdir(LIBRARY),
                     key=lambda e: natural_key(stem(e) if is_archive(e) else e))
    for entry in entries:
        full = os.path.join(LIBRARY, entry)
        if os.path.isdir(full):
            name, chapters = entry, scan_series_dir(entry, full)
        elif is_archive(entry):
            name = stem(entry)
            chapters = dedupe(archive_chapters(full, f"/cbz/{entry}", name))
        else:
            continue
        if chapters:
            series_list.append({"name": name, "cover": chapters[0]["pages"][0], "chapters": chapters})
    return series_list


# ---------------------------------------------------------------- HTTP handler

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = unquote(self.path.split("?", 1)[0])

        if path == "/api/library":
            self.reply_json(scan_library())
            return

        if path.startswith("/cbz/"):
            self.serve_from_archive(path[len("/cbz/"):])
            return

        if path.startswith("/library/"):
            self.directory = ROOT          # serve images straight from the library
        else:
            self.directory = STATIC        # everything else is the frontend
            if path == "/":
                self.path = "/index.html"
        super().do_GET()

    def serve_from_archive(self, rel):
        """rel is '<archive path inside library>/<entry inside the zip>'."""
        parts = [p for p in rel.split("/") if p]
        archive = entry = None
        for i in range(1, len(parts)):
            candidate = os.path.join(LIBRARY, *parts[:i])
            if is_archive(candidate) and os.path.isfile(candidate):
                archive, entry = candidate, "/".join(parts[i:])
                break
        lib_root = os.path.abspath(LIBRARY) + os.sep
        if not archive or not os.path.abspath(archive).startswith(lib_root):
            self.send_error(404)
            return
        try:
            with zipfile.ZipFile(archive) as z:
                try:
                    info = z.getinfo(entry)
                except KeyError:
                    info = z.getinfo(entry.replace("/", "\\"))   # archives built on Windows
                if info.is_dir() or not is_image(info.filename):
                    raise KeyError(entry)
                etag = f'"{int(os.path.getmtime(archive))}-{info.CRC:08x}"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304)
                    self.send_header("ETag", etag)
                    self.end_headers()
                    return
                data = z.read(info)
        except (KeyError, zipfile.BadZipFile, OSError):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext(info.filename), "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "private, max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path, _, query = self.path.partition("?")
        if path != "/api/upload":
            self.send_error(404)
            return
        try:
            rel = parse_qs(query).get("path", [""])[0].replace("\\", "/")
            parts = [clean_name(p) for p in rel.split("/")]
            if len(parts) == 3 and ext(parts[2]) in IMAGE_EXT:
                dest_dir, fname, archive = os.path.join(LIBRARY, parts[0], parts[1]), parts[2], False
            elif len(parts) == 2 and ext(parts[1]) in ARCHIVE_EXT:
                dest_dir, fname, archive = os.path.join(LIBRARY, parts[0]), parts[1], True
            else:
                raise ValueError("expected series/chapter/image or series/file.cbz")
        except ValueError as e:
            self.reply_json({"ok": False, "error": str(e)}, 400)
            return

        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, fname)
        with open(dest, "wb") as f:
            f.write(data)
        if archive and not archive_images(dest):
            os.remove(dest)
            self.reply_json({"ok": False, "error": f"{fname} is not a zip archive with images inside"}, 400)
            return
        self.reply_json({"ok": True})

    def reply_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def translate_path(self, path):
        # Prevent escaping the chosen directory with "..".
        full = super().translate_path(path)
        if not os.path.abspath(full).startswith(os.path.abspath(self.directory)):
            return os.path.join(self.directory, "__forbidden__")
        return full

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))


def announce(httpd):
    port = httpd.server_address[1]
    print(f"Manga reader running at http://localhost:{port}  (library: {LIBRARY})")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    httpd = serve(port=port)
    announce(httpd)
    httpd.serve_forever()
