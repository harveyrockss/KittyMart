// Retires the old KittyMart service worker so family devices pick up the new game.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  const cs = await self.clients.matchAll();
  cs.forEach(c => c.navigate(c.url));
})()));
