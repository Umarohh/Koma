// Service worker: caches the app shell so the reader opens offline.
// Strategy: serve from cache, then refresh the cache from the network in the background.
const CACHE = "manga-reader-v1";
const ASSETS = ["./", "./index.html", "./app.js", "./style.css", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (!cached) return fetch(e.request);           // only app files (pre-cached on install) are kept
      fetch(e.request)
        .then((resp) => { if (resp.ok) cache.put(e.request, resp.clone()); })
        .catch(() => {});
      return cached;
    })
  );
});
