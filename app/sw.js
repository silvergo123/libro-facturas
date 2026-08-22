const CACHE = "libro-v1";
const SHELL = ["./","./index.html","./manifest.json","./icon-192.png","./icon-512.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n=>n!==CACHE).map(n=>caches.delete(n)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Las llamadas a la API nunca se cachean: los datos viven en el servidor.
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
