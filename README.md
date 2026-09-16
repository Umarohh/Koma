# Koma

An open source, lightweight, simple manga reader. Point it at a folder of images or `.cbz` files
and read them in a clean, dark, distraction-free window. No accounts, no tracking, nothing
uploaded anywhere. Plain Python and vanilla JavaScript, with no framework and no database server.

It comes in two flavours:

- **Desktop app** for Windows (also runs from source on any OS with Python). Reads your manga
  straight from a folder on disk, with no importing or conversion.
- **Phone version** that runs entirely in the phone's browser and stores manga on the phone, so
  it works offline with no PC involved.

## Features

- Reads folders of images and `.cbz` / `.zip` archives. Archives are read in place, nothing is
  extracted
- Library grid with covers, and a chapter list that shows reading progress
- Page mode (tap or click either half of the page, arrow keys, or A/D) and vertical strip mode
- Fit to width or fit to height
- Auto-advances into the next chapter at the end of the current one
- Remembers your last page in every chapter
- Swipe to turn pages on touch screens; Esc goes back
- Chapters and pages sort naturally, so `Chapter 2` comes before `Chapter 10`

Supported image formats: jpg, png, gif, webp, avif. `.cbr` (RAR) archives are not supported.

## Desktop app

### Windows executable (no Python needed)

1. Download `Koma-win64.zip` from the
   [Releases page](https://github.com/Umarohh/manga-reader/releases) and unzip it.
2. Put manga in the `library` folder next to `Koma.exe` (see the layout below), or use the
   **+ Add manga** button inside the app.
3. Double-click `Koma.exe`.

It needs Windows 10 or 11 with the Edge WebView2 runtime, which is already installed on nearly
every machine. Windows SmartScreen may warn the first time because the exe is not code-signed;
choose "More info" and "Run anyway".

### From source

Requires Python 3.8 or newer. The desktop window needs one package:

```
pip install pywebview
python app.py           # opens the reader in its own window; closing it stops the server
```

You can also skip the window and use a normal browser:

```
python server.py        # then open http://localhost:8000  (pass a port number to change it)
```

### Adding manga

Click **+ Add manga** on the library screen. Choose a series folder laid out as
`Series/Chapter/pages` (it may contain `.cbz` files), a single chapter folder, or pick `.cbz`
files directly and type the series name. Everything is copied into `library/`.

Or arrange files in `library/` by hand. Image folders:

```
library/
  One Piece/
    Chapter 1/
      001.jpg
      002.jpg
    Chapter 2/
      ...
```

Archives:

```
library/
  Berserk/
    Vol 01.cbz          # one archive = one chapter
    Vol 02.cbz
  Vinland Saga.cbz      # a whole series in one archive; folders inside it become chapters
```

Both styles can be mixed within a series. After adding files, press F5 in the app or restart it.

### Building the executable

```
pip install pywebview pyinstaller
python build_exe.py     # -> dist/Koma.exe and dist/Koma-win64.zip
```

## Phone version (no PC needed)

**Open https://umarohh.github.io/manga-reader/ on your phone.**

It's a standalone build of the reader that runs entirely in the phone's browser. Manga is
imported from `.cbz` files or images on the phone, unpacked in the browser, stored in the
browser's own storage, and read offline. Works on Android and iPhone. Nothing is uploaded
anywhere; the site only delivers the app itself.

1. Open the link above in the phone's browser (Safari on iPhone, Chrome on Android).
2. Use **Add to Home Screen**: the Share menu in Safari, or the browser menu in Chrome, which may
   also offer an "Install app" prompt.
3. Open it from the new icon, tap **+ Add manga**, and pick `.cbz` files from the phone's file
   browser.

Things to know:

- Everything lives inside that browser on that phone. Clearing the site's data, or removing the
  home-screen app, deletes the imported manga. The library screen shows how much space is used,
  and each series has a **Delete** button.
- Importing copies the pages into the browser, so a 200 MB volume uses about 200 MB. Storage
  limits vary by browser; Safari on iPhone is the tightest.
- Folder picking is not available on iPhone; use **Choose .cbz files** or **Choose images** there.

The site is published automatically from the `web/` folder by the workflow in
`.github/workflows/pages.yml` whenever `main` changes. If you fork this repository, enable Pages
in your fork's settings (Source: GitHub Actions) and your copy will be at
`https://<your-username>.github.io/manga-reader/`. To try it locally:
`python -m http.server 8080 -d web` and open http://localhost:8080.

## Project layout

```
app.py                  desktop launcher: starts the server and opens it in a pywebview window
server.py               the server: library scanning, CBZ reading, page serving, uploads
static/                 frontend for the desktop app (HTML/CSS/JS, no framework)
web/                    the standalone phone version (separate frontend with in-browser storage)
build_exe.py            builds the Windows executable and release zip with PyInstaller
.github/workflows/      publishes web/ to GitHub Pages
library/                your manga goes here (ignored by git)
```

Everything is plain Python and vanilla JavaScript. The only third-party packages are pywebview
for the desktop window and PyInstaller for building the exe.

## License

MIT. See [LICENSE](LICENSE).
