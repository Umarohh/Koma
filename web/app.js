// Koma (phone version): everything runs in the browser, no server needed.
// Manga is imported from .cbz/.zip archives or image folders, unpacked with the
// browser's built-in decompressor, stored in IndexedDB, and read offline.
// Navigation state lives in the URL hash so refresh/back work; reading progress
// and preferences live in localStorage.

const $ = (id) => document.getElementById(id);
const view = $("view"), title = $("title"), back = $("back");
const pager = $("pager"), counter = $("counter"), prevBtn = $("prev"), nextBtn = $("next");
const controls = $("reader-controls"), modeBtn = $("mode"), fitBtn = $("fit");
const addBtn = $("add"), deleteBtn = $("delete");
const addDialog = $("add-dialog"), addCbz = $("add-cbz"), addImages = $("add-images"), addFolder = $("add-folder");
const addSummary = $("add-summary"), addSeries = $("add-series");
const addChapterField = $("add-chapter-field"), addChapter = $("add-chapter");
const addStatus = $("add-status"), addCancel = $("add-cancel"), addConfirm = $("add-confirm");

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)$/i;
const ARCHIVE_EXT = /\.(cbz|zip)$/i;
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const natCmp = (a, b) => collator.compare(a, b);

let library = [];                             // [{ id, name, chapters: [{ id, name, pageCount }] }]
let state = { series: null, chapter: null, page: 0 };
let prefs = load("prefs", { mode: "page", fit: "width" });
let progress = load("progress", {});          // { "series/chapter": lastPageIndex }
let loaded = { chapterId: null, urls: [] };   // object URLs for the chapter that is open
const coverUrls = new Map();                  // series id -> object URL

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function progressKey() { return `${state.series.name}/${state.chapter.name}`; }
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// ---------- storage (IndexedDB) ----------
let dbPromise;
function db() {
  return dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("koma", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("series", { keyPath: "id" });
      d.createObjectStore("chapters", { keyPath: "id" }).createIndex("seriesId", "seriesId");
      d.createObjectStore("pages", { keyPath: "id" }).createIndex("chapterId", "chapterId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const reqp = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

async function loadLibrary() {
  const d = await db();
  const tx = d.transaction(["series", "chapters"]);
  const [series, chapters] = await Promise.all([
    reqp(tx.objectStore("series").getAll()), reqp(tx.objectStore("chapters").getAll()),
  ]);
  series.sort((a, b) => natCmp(a.name, b.name));
  return series
    .map((s) => ({ ...s, chapters: chapters.filter((c) => c.seriesId === s.id).sort((a, b) => natCmp(a.name, b.name)) }))
    .filter((s) => s.chapters.length);
}
async function getPages(chapterId) {
  const d = await db();
  const rows = await reqp(d.transaction("pages").objectStore("pages").index("chapterId").getAll(chapterId));
  return rows.sort((a, b) => a.index - b.index).map((r) => r.blob);
}
async function getPage(chapterId, index) {
  const d = await db();
  return (await reqp(d.transaction("pages").objectStore("pages").get(`${chapterId}/${index}`)))?.blob ?? null;
}
async function getOrCreateSeries(name) {
  const d = await db();
  const tx = d.transaction("series", "readwrite");
  const store = tx.objectStore("series");
  let s = (await reqp(store.getAll())).find((x) => x.name === name);
  if (!s) { s = { id: uid(), name, added: Date.now() }; store.put(s); }
  await txDone(tx);
  return s;
}
function deletePagesOf(pagesStore, chapterId) {
  return new Promise((resolve, reject) => {
    const req = pagesStore.index("chapterId").openKeyCursor(IDBKeyRange.only(chapterId));
    req.onsuccess = () => { const c = req.result; if (!c) return resolve(); pagesStore.delete(c.primaryKey); c.continue(); };
    req.onerror = () => reject(req.error);
  });
}
// Importing a chapter whose name already exists in the series replaces it.
async function saveChapter(seriesId, name, blobs) {
  const d = await db();
  const tx = d.transaction(["chapters", "pages"], "readwrite");
  const chapters = tx.objectStore("chapters"), pages = tx.objectStore("pages");
  const existing = (await reqp(chapters.index("seriesId").getAll(seriesId))).find((c) => c.name === name);
  if (existing) await deletePagesOf(pages, existing.id);
  const id = existing?.id ?? uid();
  chapters.put({ id, seriesId, name, pageCount: blobs.length, added: Date.now() });
  blobs.forEach((blob, index) => pages.put({ id: `${id}/${index}`, chapterId: id, index, blob }));
  await txDone(tx);
}
async function deleteSeries(series) {
  const d = await db();
  const tx = d.transaction(["series", "chapters", "pages"], "readwrite");
  for (const c of series.chapters) {
    await deletePagesOf(tx.objectStore("pages"), c.id);
    tx.objectStore("chapters").delete(c.id);
  }
  tx.objectStore("series").delete(series.id);
  await txDone(tx);
}

// ---------- zip reading (no library: central directory parsed by hand, deflate via the browser) ----------
async function readZipEntries(file) {
  // The end-of-central-directory record is within the last 64 KB + 22 bytes.
  const tailSize = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file.name} is not a zip archive`);
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error(`${file.name}: zip64 archives are not supported`);
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const utf8 = new TextDecoder("utf-8"), latin1 = new TextDecoder("latin1");
  const entries = [];
  for (let i = 0, p = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const flags = cd.getUint16(p + 8, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
    entries.push({
      name: (flags & 0x800 ? utf8 : latin1).decode(nameBytes),
      method: cd.getUint16(p + 10, true),
      compSize: cd.getUint32(p + 20, true),
      size: cd.getUint32(p + 24, true),
      localOffset: cd.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntry(file, e, type) {
  const head = new DataView(await file.slice(e.localOffset, e.localOffset + 30).arrayBuffer());
  if (head.getUint32(0, true) !== 0x04034b50) throw new Error(`${file.name}: corrupt entry ${e.name}`);
  const start = e.localOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const data = file.slice(start, start + e.compSize, type);
  if (e.method === 0) return data;                                   // stored
  if (e.method !== 8) throw new Error(`${file.name}: unsupported compression in ${e.name}`);
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot unzip files. Please update it.");
  const stream = data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Blob([await new Response(stream).arrayBuffer()], { type });
}

// ---------- import ----------
const imageMime = (name) => MIME[name.split(".").pop().toLowerCase()] || "application/octet-stream";
const stem = (name) => name.replace(/\.[^.]+$/, "");
function isImageEntry(name) {
  const norm = name.replace(/\\/g, "/");
  const base = norm.split("/").pop();
  return IMAGE_EXT.test(base) && !base.startsWith(".") && !norm.includes("__MACOSX/") && !norm.endsWith("/");
}

// Unpack one archive into the series. Folders inside the archive become chapters when
// there is more than one; otherwise the whole archive is one chapter named after the file.
async function importArchive(file, seriesId, onStatus) {
  const entries = (await readZipEntries(file)).filter((e) => isImageEntry(e.name));
  const norm = (n) => n.replace(/\\/g, "/");
  entries.sort((a, b) => natCmp(norm(a.name), norm(b.name)));
  const groups = new Map();
  for (const e of entries) {
    const dir = norm(e.name).split("/").slice(0, -1).join("/");
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(e);
  }
  if (!groups.size) throw new Error(`${file.name} has no images inside`);
  let done = 0;
  for (const [dir, list] of [...groups].sort((a, b) => natCmp(a[0], b[0]))) {
    const name = groups.size > 1 && dir ? dir.split("/").pop() : stem(file.name);
    const pages = [];
    for (const e of list) {
      pages.push(await readZipEntry(file, e, imageMime(e.name)));
      onStatus(`${file.name}: ${++done} / ${entries.length}`);
    }
    onStatus(`Saving ${name}…`);
    await saveChapter(seriesId, name, pages);
  }
}

// items: [{ kind: "archive", file }] or [{ kind: "page", chapter, file }] (chapter may be null).
async function importItems(items, seriesName, chapterName, onStatus = () => {}) {
  const series = await getOrCreateSeries(seriesName);
  try {
    const byChapter = new Map();
    for (const it of items) {
      if (it.kind !== "page") continue;
      const ch = it.chapter || chapterName;
      if (!byChapter.has(ch)) byChapter.set(ch, []);
      byChapter.get(ch).push(it.file);
    }
    for (const [name, files] of byChapter) {
      files.sort((a, b) => natCmp(a.name, b.name));
      onStatus(`Saving ${name} (${files.length} pages)…`);
      await saveChapter(series.id, name, files.map((f) => f.slice(0, f.size, f.type || imageMime(f.name))));
    }
    for (const it of items) if (it.kind === "archive") await importArchive(it.file, series.id, onStatus);
  } finally {
    // Don't leave an empty series behind if nothing could be imported.
    const d = await db();
    const tx = d.transaction(["series", "chapters"], "readwrite");
    const n = await reqp(tx.objectStore("chapters").index("seriesId").count(series.id));
    if (n === 0) tx.objectStore("series").delete(series.id);
    await txDone(tx);
  }
  try { await navigator.storage?.persist?.(); } catch {}
  return series;
}

// ---------- routing ----------
function go(hash) { location.hash = hash; }

let routeToken = 0;
async function route() {
  const token = ++routeToken;
  const parts = location.hash.slice(1).split("/").map(decodeURIComponent).filter(Boolean);
  const series = library.find((s) => s.name === parts[0]);
  const chapter = series?.chapters.find((c) => c.name === parts[1]);

  if (series && chapter) {
    const saved = progress[`${series.name}/${chapter.name}`] ?? 0;
    const page = parts[2] !== undefined ? Number(parts[2]) : saved;
    state = { series, chapter, page: Math.min(Math.max(page || 0, 0), chapter.pageCount - 1) };
    if (loaded.chapterId !== chapter.id) {
      setChrome({ heading: `${series.name} — ${chapter.name}`, showBack: true, reader: true });
      view.innerHTML = `<div class="empty">Loading…</div>`;
      const blobs = await getPages(chapter.id);
      if (token !== routeToken) return;             // user navigated elsewhere meanwhile
      loaded.urls.forEach(URL.revokeObjectURL);
      loaded = { chapterId: chapter.id, urls: blobs.map((b) => URL.createObjectURL(b)) };
    }
    renderReader();
  } else if (series) {
    state = { series, chapter: null, page: 0 };
    renderChapters();
  } else {
    state = { series: null, chapter: null, page: 0 };
    renderLibrary();
  }
}

// ---------- views ----------
function setChrome({ heading, showBack, reader }) {
  title.textContent = heading;
  back.classList.toggle("hidden", !showBack);
  addBtn.classList.toggle("hidden", showBack);
  deleteBtn.classList.toggle("hidden", !(showBack && !reader));
  controls.classList.toggle("hidden", !reader);
  pager.classList.toggle("hidden", !(reader && prefs.mode === "page"));
  view.className = reader ? `reader ${prefs.mode} fit-${prefs.fit}` : "";
  view.onscroll = null;
  view.scrollTop = 0;
}

async function coverFor(s) {
  if (coverUrls.has(s.id)) return coverUrls.get(s.id);
  const blob = await getPage(s.chapters[0].id, 0);
  const url = blob ? URL.createObjectURL(blob) : "";
  coverUrls.set(s.id, url);
  return url;
}
function forgetCovers() {
  for (const url of coverUrls.values()) URL.revokeObjectURL(url);
  coverUrls.clear();
}

function formatBytes(n) {
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}
async function storageLine() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return `Using ${formatBytes(usage)} of about ${formatBytes(quota)} available on this device.`;
  } catch { return ""; }
}

function renderLibrary() {
  setChrome({ heading: "Library", showBack: false, reader: false });
  if (!library.length) {
    view.innerHTML = `<div class="empty">Nothing here yet.<br>
      Tap <b>+ Add manga</b> to import <code>.cbz</code> files or image folders.
      They are stored on this device and readable offline.</div>
      <div class="storage"></div>`;
  } else {
    view.innerHTML = `<div class="grid">${library.map((s) => `
      <div class="card" data-series="${esc(s.name)}">
        <img alt="" data-id="${esc(s.id)}">
        <div class="name">${esc(s.name)}</div>
        <div class="sub">${s.chapters.length} chapter${s.chapters.length === 1 ? "" : "s"}</div>
      </div>`).join("")}</div><div class="storage"></div>`;
    view.querySelectorAll(".card").forEach((el) => {
      el.onclick = () => go(encodeURIComponent(el.dataset.series));
      const s = library.find((x) => x.name === el.dataset.series);
      coverFor(s).then((url) => { el.querySelector("img").src = url; });
    });
  }
  storageLine().then((t) => { const el = view.querySelector(".storage"); if (el) el.textContent = t; });
}

function renderChapters() {
  const s = state.series;
  setChrome({ heading: s.name, showBack: true, reader: false });
  view.innerHTML = `<div class="list">${s.chapters.map((c) => {
    const p = progress[`${s.name}/${c.name}`];
    const done = p !== undefined && p >= c.pageCount - 1;
    const started = p !== undefined && !done;
    return `<div class="row ${done ? "read" : ""}" data-chapter="${esc(c.name)}">
      <span>${esc(c.name)} ${started ? `<span class="badge">p.${p + 1}</span>` : ""}</span>
      <span class="meta">${c.pageCount} pages</span>
    </div>`;
  }).join("")}</div>`;
  view.querySelectorAll(".row").forEach((el) =>
    el.onclick = () => go(`${encodeURIComponent(s.name)}/${encodeURIComponent(el.dataset.chapter)}`));
}

function renderReader() {
  const { series, chapter, page } = state;
  const urls = loaded.urls;
  setChrome({ heading: `${series.name} — ${chapter.name}`, showBack: true, reader: true });
  progress[progressKey()] = page;
  save("progress", progress);

  if (prefs.mode === "strip") {
    view.innerHTML = urls.map((u, i) => `<img src="${u}" data-i="${i}" loading="lazy">`).join("");
    view.querySelector(`img[data-i="${page}"]`)?.scrollIntoView();
    view.onscroll = () => {
      const imgs = [...view.querySelectorAll("img")];
      const mid = view.scrollTop + view.clientHeight / 2;
      const i = imgs.findIndex((img) => img.offsetTop + img.offsetHeight > mid);
      if (i >= 0 && i !== state.page) {
        state.page = i;
        progress[progressKey()] = i;
        save("progress", progress);
      }
    };
    return;
  }

  view.innerHTML = `<img src="${urls[page]}" alt="Page ${page + 1}">`;
  view.querySelector("img").onclick = (e) => {
    if (e.clientX > window.innerWidth / 2) nextPage(); else prevPage();
  };
  counter.textContent = `${page + 1} / ${urls.length}`;
  prevBtn.disabled = page === 0 && !adjacentChapter(-1);
  nextBtn.disabled = page === urls.length - 1 && !adjacentChapter(1);
}

// ---------- navigation ----------
function adjacentChapter(dir) {
  const i = state.series.chapters.indexOf(state.chapter) + dir;
  return state.series.chapters[i] || null;
}
function pageHash(chapter, page) {
  return `${encodeURIComponent(state.series.name)}/${encodeURIComponent(chapter.name)}/${page}`;
}
function nextPage() {
  if (!state.chapter) return;
  if (state.page < state.chapter.pageCount - 1) go(pageHash(state.chapter, state.page + 1));
  else { const c = adjacentChapter(1); if (c) go(pageHash(c, 0)); }
}
function prevPage() {
  if (!state.chapter) return;
  if (state.page > 0) go(pageHash(state.chapter, state.page - 1));
  else { const c = adjacentChapter(-1); if (c) go(pageHash(c, c.pageCount - 1)); }
}
function goBack() {
  if (state.chapter) go(encodeURIComponent(state.series.name));
  else go("");
}

// Swipe left/right to turn pages on touch screens (page mode only).
let touchX = null, touchY = null;
view.addEventListener("touchstart", (e) => {
  touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
}, { passive: true });
view.addEventListener("touchend", (e) => {
  if (touchX === null || !state.chapter || prefs.mode !== "page") return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  touchX = touchY = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    if (dx < 0) nextPage(); else prevPage();
  }
}, { passive: true });

nextBtn.onclick = nextPage;
prevBtn.onclick = prevPage;
back.onclick = goBack;
modeBtn.onclick = () => {
  prefs.mode = prefs.mode === "page" ? "strip" : "page";
  save("prefs", prefs); updateButtons(); route();
};
fitBtn.onclick = () => {
  prefs.fit = prefs.fit === "width" ? "height" : "width";
  save("prefs", prefs); updateButtons(); route();
};
function updateButtons() {
  modeBtn.textContent = prefs.mode === "page" ? "Strip mode" : "Page mode";
  fitBtn.textContent = `Fit: ${prefs.fit}`;
}

document.addEventListener("keydown", (e) => {
  const open = document.querySelector(".dialog:not(.hidden)");
  if (open) {
    if (e.key === "Escape" && !addCancel.disabled) open.classList.add("hidden");
    return;
  }
  if (e.key === "ArrowRight" || e.key === "d") nextPage();
  else if (e.key === "ArrowLeft" || e.key === "a") prevPage();
  else if (e.key === "Escape") goBack();
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- delete series ----------
deleteBtn.onclick = async () => {
  const s = state.series;
  if (!s || !confirm(`Delete "${s.name}" and all ${s.chapters.length} chapter(s) from this device?`)) return;
  await deleteSeries(s);
  await refreshLibrary();
  go("");
};

// ---------- add manga dialog ----------
let pending = [];   // [{ kind: "archive", file }] or [{ kind: "page", chapter, file }]

function openAddDialog() {
  pending = [];
  addCbz.value = ""; addImages.value = ""; addFolder.value = "";
  addSeries.value = ""; addChapter.value = "";
  addSummary.textContent = ""; addStatus.textContent = "";
  addChapterField.classList.add("hidden");
  addConfirm.disabled = true;
  addDialog.classList.remove("hidden");
}
function closeAddDialog() { addDialog.classList.add("hidden"); }

function collectPending() {
  pending = [];
  let seriesGuess = "";
  for (const file of addFolder.files) {
    const parts = (file.webkitRelativePath || file.name).split("/");
    if (parts.length < 2) continue;
    const name = parts[parts.length - 1];
    if (ARCHIVE_EXT.test(name)) {
      seriesGuess = parts[0];
      pending.push({ kind: "archive", file });
    } else if (IMAGE_EXT.test(name)) {
      if (parts.length === 2) pending.push({ kind: "page", chapter: parts[0], file });
      else { seriesGuess = parts[0]; pending.push({ kind: "page", chapter: parts[parts.length - 2], file }); }
    }
  }
  for (const file of addCbz.files) if (ARCHIVE_EXT.test(file.name)) pending.push({ kind: "archive", file });
  for (const file of addImages.files) if (IMAGE_EXT.test(file.name) || file.type.startsWith("image/")) pending.push({ kind: "page", chapter: null, file });

  const pages = pending.filter((p) => p.kind === "page");
  const needsChapter = pages.some((p) => !p.chapter);
  const chapters = new Set(pages.map((p) => p.chapter || "(untitled)")).size;
  const archives = pending.length - pages.length;
  const bits = [];
  if (pages.length) bits.push(`${pages.length} page${pages.length === 1 ? "" : "s"} in ${chapters} chapter${chapters === 1 ? "" : "s"}`);
  if (archives) bits.push(`${archives} archive${archives === 1 ? "" : "s"}`);
  addSummary.textContent = pending.length ? bits.join(", ") : "No images or archives found.";
  addChapterField.classList.toggle("hidden", !needsChapter);
  if (seriesGuess && !addSeries.value.trim()) addSeries.value = seriesGuess;
  updateAddConfirm();
}
addCbz.onchange = addImages.onchange = addFolder.onchange = collectPending;
addSeries.oninput = addChapter.oninput = updateAddConfirm;
function updateAddConfirm() {
  const needsChapter = pending.some((p) => p.kind === "page" && !p.chapter);
  addConfirm.disabled = !(pending.length && addSeries.value.trim() && (!needsChapter || addChapter.value.trim()));
}

async function runImport() {
  const series = addSeries.value.trim(), chapter = addChapter.value.trim();
  addConfirm.disabled = addCancel.disabled = addCbz.disabled = addImages.disabled = addFolder.disabled = true;
  try {
    await importItems(pending, series, chapter, (t) => { addStatus.textContent = t; });
    await refreshLibrary();
    closeAddDialog();
    go(encodeURIComponent(series));
  } catch (e) {
    addStatus.textContent = `Error: ${e.message}`;
    addConfirm.disabled = false;
  } finally {
    addCancel.disabled = addCbz.disabled = addImages.disabled = addFolder.disabled = false;
  }
}

addBtn.onclick = openAddDialog;
addCancel.onclick = closeAddDialog;
addConfirm.onclick = runImport;
addDialog.onclick = (e) => { if (e.target === addDialog && !addCancel.disabled) closeAddDialog(); };

// ---------- boot ----------
async function refreshLibrary() {
  forgetCovers();
  library = await loadLibrary();
}

window.addEventListener("hashchange", route);
updateButtons();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
refreshLibrary()
  .then(route)
  .catch((e) => { view.innerHTML = `<div class="empty">Could not open storage: ${esc(e.message)}</div>`; });
