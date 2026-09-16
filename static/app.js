// Simple manga reader: library -> chapters -> reader. State is kept in the URL hash
// so refresh/back work, and reading progress is kept in localStorage.

const $ = (id) => document.getElementById(id);
const view = $("view"), title = $("title"), back = $("back");
const pager = $("pager"), counter = $("counter"), prevBtn = $("prev"), nextBtn = $("next");
const controls = $("reader-controls"), modeBtn = $("mode"), fitBtn = $("fit");
const addBtn = $("add"), addDialog = $("add-dialog"), addFiles = $("add-files");
const addSummary = $("add-summary"), addSeries = $("add-series"), addStatus = $("add-status");
const addCancel = $("add-cancel"), addConfirm = $("add-confirm");
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)$/i;
const ARCHIVE_EXT = /\.(cbz|zip)$/i;
const addCbz = $("add-cbz");

let library = [];
let state = { series: null, chapter: null, page: 0 };
let prefs = load("prefs", { mode: "page", fit: "width" });
let progress = load("progress", {});   // { "series/chapter": lastPageIndex }

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function progressKey() { return `${state.series.name}/${state.chapter.name}`; }

// ---------- routing ----------
function go(hash) { location.hash = hash; }

function route() {
  const parts = location.hash.slice(1).split("/").map(decodeURIComponent).filter(Boolean);
  const series = library.find((s) => s.name === parts[0]);
  const chapter = series?.chapters.find((c) => c.name === parts[1]);

  if (series && chapter) {
    const saved = progress[`${series.name}/${chapter.name}`] ?? 0;
    const page = parts[2] !== undefined ? Number(parts[2]) : saved;
    state = { series, chapter, page: Math.min(Math.max(page || 0, 0), chapter.pages.length - 1) };
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
  controls.classList.toggle("hidden", !reader);
  pager.classList.toggle("hidden", !(reader && prefs.mode === "page"));
  view.className = reader ? `reader ${prefs.mode} fit-${prefs.fit}` : "";
  view.onscroll = null;
  view.scrollTop = 0;
}

function renderLibrary() {
  setChrome({ heading: "Library", showBack: false, reader: false });
  if (!library.length) {
    view.innerHTML = `<div class="empty">No manga found.<br>
      Click <b>+ Add manga</b> above, or drop folders or <code>.cbz</code> files into
      <code>library/&lt;Series&gt;/</code> and refresh.</div>`;
    return;
  }
  view.innerHTML = `<div class="grid">${library.map((s) => `
    <div class="card" data-series="${esc(s.name)}">
      <img src="${s.cover}" alt="" loading="lazy">
      <div class="name">${esc(s.name)}</div>
      <div class="sub">${s.chapters.length} chapter${s.chapters.length === 1 ? "" : "s"}</div>
    </div>`).join("")}</div>`;
  view.querySelectorAll(".card").forEach((el) =>
    el.onclick = () => go(encodeURIComponent(el.dataset.series)));
}

function renderChapters() {
  const s = state.series;
  setChrome({ heading: s.name, showBack: true, reader: false });
  view.innerHTML = `<div class="list">${s.chapters.map((c) => {
    const p = progress[`${s.name}/${c.name}`];
    const done = p !== undefined && p >= c.pages.length - 1;
    const started = p !== undefined && !done;
    return `<div class="row ${done ? "read" : ""}" data-chapter="${esc(c.name)}">
      <span>${esc(c.name)} ${started ? `<span class="badge">p.${p + 1}</span>` : ""}</span>
      <span class="meta">${c.pages.length} pages</span>
    </div>`;
  }).join("")}</div>`;
  view.querySelectorAll(".row").forEach((el) =>
    el.onclick = () => go(`${encodeURIComponent(s.name)}/${encodeURIComponent(el.dataset.chapter)}`));
}

function renderReader() {
  const { series, chapter, page } = state;
  setChrome({ heading: `${series.name} — ${chapter.name}`, showBack: true, reader: true });
  progress[progressKey()] = page;
  save("progress", progress);

  if (prefs.mode === "strip") {
    view.innerHTML = chapter.pages.map((p, i) => `<img src="${p}" data-i="${i}" loading="lazy">`).join("");
    view.querySelector(`img[data-i="${page}"]`)?.scrollIntoView();
    // Track which page is in view so progress is saved while scrolling.
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

  view.innerHTML = `<img src="${chapter.pages[page]}" alt="Page ${page + 1}">`;
  view.querySelector("img").onclick = (e) => {
    // Right half of the screen advances, left half goes back.
    if (e.clientX > window.innerWidth / 2) nextPage(); else prevPage();
  };
  counter.textContent = `${page + 1} / ${chapter.pages.length}`;
  prevBtn.disabled = page === 0 && !adjacentChapter(-1);
  nextBtn.disabled = page === chapter.pages.length - 1 && !adjacentChapter(1);
  // Preload the next page so it appears instantly.
  if (chapter.pages[page + 1]) new Image().src = chapter.pages[page + 1];
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
  if (state.page < state.chapter.pages.length - 1) go(pageHash(state.chapter, state.page + 1));
  else { const c = adjacentChapter(1); if (c) go(pageHash(c, 0)); }
}
function prevPage() {
  if (!state.chapter) return;
  if (state.page > 0) go(pageHash(state.chapter, state.page - 1));
  else { const c = adjacentChapter(-1); if (c) go(pageHash(c, c.pages.length - 1)); }
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
  else if (e.key === "F5") { e.preventDefault(); location.reload(); }   // rescan the library
});

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- add manga ----------
// Pending upload: [{ file, rel }] where rel is [chapter, image] or [archive.cbz],
// relative to the series folder. Built from whichever pickers were used.
let pending = [];

function openAddDialog() {
  pending = [];
  addFiles.value = "";
  addCbz.value = "";
  addSeries.value = "";
  addSummary.textContent = "";
  addStatus.textContent = "";
  addConfirm.disabled = true;
  addDialog.classList.remove("hidden");
}
function closeAddDialog() { addDialog.classList.add("hidden"); }

function collectPending() {
  pending = [];
  let seriesGuess = "";
  for (const file of addFiles.files) {
    const parts = file.webkitRelativePath.split("/");
    if (parts.length < 2) continue;
    const name = parts[parts.length - 1];
    if (ARCHIVE_EXT.test(name)) {
      // Series/archive.cbz (or deeper): the archive is a chapter of the top folder.
      seriesGuess = parts[0];
      pending.push({ file, rel: [name] });
    } else if (IMAGE_EXT.test(name)) {
      if (parts.length === 2) {
        // Picked a chapter folder directly: folder = chapter, series typed by the user.
        pending.push({ file, rel: [parts[0], name] });
      } else {
        seriesGuess = parts[0];
        pending.push({ file, rel: [parts[parts.length - 2], name] });
      }
    }
  }
  for (const file of addCbz.files) {
    if (ARCHIVE_EXT.test(file.name)) pending.push({ file, rel: [file.name] });
  }

  const pages = pending.filter((p) => p.rel.length === 2);
  const chapters = new Set(pages.map((p) => p.rel[0])).size;
  const archives = pending.length - pages.length;
  const bits = [];
  if (pages.length) bits.push(`${pages.length} page${pages.length === 1 ? "" : "s"} in ${chapters} chapter${chapters === 1 ? "" : "s"}`);
  if (archives) bits.push(`${archives} archive${archives === 1 ? "" : "s"}`);
  addSummary.textContent = pending.length ? bits.join(", ") : "No images or archives found.";
  if (seriesGuess && !addSeries.value.trim()) addSeries.value = seriesGuess;
  updateAddConfirm();
}
addFiles.onchange = collectPending;
addCbz.onchange = collectPending;
addSeries.oninput = updateAddConfirm;
function updateAddConfirm() {
  addConfirm.disabled = !(pending.length && addSeries.value.trim());
}

async function uploadPending() {
  const series = addSeries.value.trim();
  addConfirm.disabled = true; addCancel.disabled = true; addFiles.disabled = true; addCbz.disabled = true;
  let done = 0;
  try {
    for (const { file, rel } of pending) {
      const path = [series, ...rel].map(encodeURIComponent).join("/");
      const r = await fetch(`/api/upload?path=${path}`, { method: "POST", body: file });
      const res = await r.json();
      if (!res.ok) throw new Error(res.error || "upload failed");
      addStatus.textContent = `Copying ${++done} / ${pending.length}`;
    }
    library = await (await fetch("/api/library")).json();
    closeAddDialog();
    go(encodeURIComponent(series));
  } catch (e) {
    addStatus.textContent = `Error: ${e.message}`;
    addConfirm.disabled = false;
  } finally {
    addCancel.disabled = false; addFiles.disabled = false; addCbz.disabled = false;
  }
}

addBtn.onclick = openAddDialog;
addCancel.onclick = closeAddDialog;
addConfirm.onclick = uploadPending;
addDialog.onclick = (e) => { if (e.target === addDialog && !addCancel.disabled) closeAddDialog(); };

// ---------- boot ----------
window.addEventListener("hashchange", route);
updateButtons();
fetch("/api/library")
  .then((r) => r.json())
  .then((data) => { library = data; route(); })
  .catch(() => { view.innerHTML = `<div class="empty">Could not load library. Is server.py running?</div>`; });
