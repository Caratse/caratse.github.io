const CACHE_NAME = "daily-budget-cloud-v58-entry-income-categories-20260803";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./firebase-config.js?v=58",
  "./firebase-cloud-v58.js?v=58",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(APP_SHELL.map(url => cache.add(url)))
    )
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

function isCodeRequest(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".webmanifest");
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  if (isCodeRequest(event.request)) {
    event.respondWith(
      fetch(event.request, {cache:"no-store"}).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() =>
        caches.match(event.request).then(cached => cached || caches.match("./index.html"))
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached =>
      cached || fetch(event.request).then(response => {
        if (
          response &&
          response.ok &&
          new URL(event.request.url).origin === self.location.origin
        ) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
    )
  );
});
