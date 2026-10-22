/* Palimvo service worker: keeps the app shell (HTML, scripts, styles, icons) available offline.
   Generated at build time by vite.config.ts, which fills in the cache name and the files to
   keep from the first visit (the entry script, its imports and styles, icons). Other build
   files are kept the first time they are used.
   Only the shell is cached. Nothing under /api, /mcp or /oauth, and nothing on other origins,
   goes through here: notes, tokens and sign-in state are never stored by the worker. */
const CACHE = "__CACHE__";
const PRECACHE = [/*__PRECACHE__*/];
const SHELL = "/index.html";
const PASS_THROUGH = /^\/(api|mcp|oauth|\.well-known)(\/|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([SHELL, ...PRECACHE])));
  // No skipWaiting(): a new version takes over only once no open page uses the old one, so an open
  // page never loses the build files it may still load lazily (their old names are gone from the server).
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("palimvo-shell-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (PASS_THROUGH.test(url.pathname)) return;

  if (request.mode === "navigate") {
    // Online: always the server's page, so a deploy shows up on the next load. Offline: the cached shell.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && (response.headers.get("content-type") ?? "").startsWith("text/html")) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put(SHELL, copy)));
          }
          return response;
        })
        .catch(() => caches.match(SHELL).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Build files have content hashes in their names, so a cached copy is never stale.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok && url.pathname.startsWith("/assets/")) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        }),
    ),
  );
});
