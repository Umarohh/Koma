"""Build a single-file Windows executable and a release zip.

Requires:  pip install pyinstaller pywebview
Run:       python build_exe.py
Output:    dist/MangaReader.exe
           dist/MangaReader-win64.zip   (exe + empty library folder + README)

The exe needs no Python on the target machine. It uses the Edge WebView2 runtime,
which ships with Windows 11 and most Windows 10 installs.
"""
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
NAME = "MangaReader"


def main():
    subprocess.check_call([
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", NAME,
        "--icon", os.path.join(ROOT, "icon.ico"),
        "--add-data", f"{os.path.join(ROOT, 'static')}{os.pathsep}static",
        "--collect-all", "webview",
        "--collect-all", "clr_loader",
        os.path.join(ROOT, "app.py"),
    ], cwd=ROOT)

    exe = os.path.join(DIST, f"{NAME}.exe")
    out = os.path.join(DIST, f"{NAME}-win64.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(exe, f"{NAME}/{NAME}.exe")
        z.write(os.path.join(ROOT, "README.md"), f"{NAME}/README.md")
        z.write(os.path.join(ROOT, "library", "README.txt"), f"{NAME}/library/README.txt")
    print(f"\nBuilt {exe} ({os.path.getsize(exe) // 1_000_000} MB)")
    print(f"Release zip: {out}")

    # PyInstaller leftovers that are not needed after the build.
    shutil.rmtree(os.path.join(ROOT, "build"), ignore_errors=True)
    spec = os.path.join(ROOT, f"{NAME}.spec")
    if os.path.exists(spec):
        os.remove(spec)


if __name__ == "__main__":
    main()
