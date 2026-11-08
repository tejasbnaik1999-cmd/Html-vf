/* Folio service worker: keeps the app working offline and serves stored files at ./doc/<id>/ */
importScripts('./core.js');

const VERSION = 'folio-v1';
const SHELL = ['./', './index.html', './app.css', './app.js', './core.js', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  const scope = new URL(self.registration.scope).pathname;
  const rel = url.pathname.slice(scope.length);

  const m = /^doc\/([A-Za-z0-9_-]+)\/?/.exec(rel);
  if (m) { e.respondWith(serveDoc(m[1])); return; }

  // app shell: cache first, refresh in the background when online
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = rel === '' ? './' : e.request;
    const hit = await cache.match(key, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) cache.put(key, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  })());
});

async function serveDoc(id) {
  try {
    const blob = await Folio.composeDoc(id);
    if (!blob) return new Response('<p style="font:16px system-ui;padding:2em">This file is no longer in your library.</p>', { status: 404, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    return new Response(blob, { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (err) {
    return new Response('Could not open file: ' + err, { status: 500 });
  }
}
