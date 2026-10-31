/* TrackInsight service worker: app shell offline, last data as fallback. Bookings made offline are queued by the app itself. */
const VERSION = "ti-v3";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];
const DATA_PATHS = ["/api/dataset", "/api/auth/me", "/api/closings", "/api/comments/open", "/api/branding/logo", "/api/weeks", "/api/me/reminder"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Pages: network first, cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).then((res) => { caches.open(VERSION).then((c) => c.put("/", res.clone())); return res; }).catch(() => caches.match("/")));
    return;
  }
  // Data the app needs to open: network first, last copy when offline.
  if (DATA_PATHS.some((p) => url.pathname === p)) {
    event.respondWith(fetch(req).then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())); return res; }).catch(() => caches.match(req).then((hit) => hit ?? new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "content-type": "application/json" } }))));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;
  // Hashed assets and icons: cache first.
  event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())); return res; })));
});
