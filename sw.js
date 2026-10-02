/* Capri JR31 · service worker
   - Permite instalar la app (ícono propio, sin barra del navegador).
   - Siempre trae la versión nueva de la app cuando hay internet; si no hay, abre la última guardada.
   - Muestra los avisos del sistema y al tocarlos abre la app en ese trabajo. */
const CACHE = 'jr31-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/icon-192.png'])).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;           // Supabase, mapas, etc. van directo
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        const c = await caches.open(CACHE); c.put('/', res.clone());
        return res;
      } catch (err) {
        return (await caches.match('/')) || Response.error();
      }
    })());
  }
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { await c.focus(); c.postMessage({ tipo: 'abrir', job_id: data.job_id || null, notif_id: data.notif_id || null }); return; }
    }
    await self.clients.openWindow('/?app=1' + (data.job_id ? '&job=' + encodeURIComponent(data.job_id) : ''));
  })());
});
