// Klartext service worker: offline app shell + receive files shared from other apps.
const CACHE = "kt-v3";
const SHELL = ["/", "/styles.css", "/app.js", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== "kt-share").map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname === "/share-target") {
    e.respondWith((async () => {
      const form = await e.request.formData(); const c = await caches.open("kt-share");
      let i = 0;
      for (const f of form.getAll("files")) if (f && f.size) await c.put(`/shared/${Date.now()}-${i++}`, new Response(f, { headers: { "content-type": f.type, "x-name": encodeURIComponent(f.name) } }));
      return Response.redirect("/?shared=1", 303);
    })());
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // network first, fall back to cache (keeps the app fresh, works offline)
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("/"))));
});
