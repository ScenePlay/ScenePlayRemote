// The portal has NO service worker — this file exists to evict one.
//
// Another app served on the same host and port (Recipe Library also defaults
// to :8000 and registers /sw.js) leaves its worker registered for the origin
// in every browser that visited it. Those browsers then fetch /sw.js here on
// their update check, log a 404, and can keep serving the other app's cached
// pages over ours. A registered worker's only way out is a replacement that
// removes itself: the browser installs this as the "update", it drops every
// cache, unregisters, and reloads the open tabs so they load uncontrolled.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* no Cache API, nothing to clear */ }
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      try { c.navigate(c.url); } catch (e) { /* the next load is uncontrolled anyway */ }
    }
  })());
});
