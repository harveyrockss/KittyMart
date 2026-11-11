const C='kittymart-v4',A=['./','index.html','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','icons/icon-1024.png','icons/coin.png','logos/summer.webp','logos/christmas.webp','logos/valentine.webp','logos/easter.webp','logos/stpatrick.webp','logos/spring.webp','logos/halloween.webp','logos/newyear.webp','logos/autumn.webp'];
self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(A)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==C).map(n=>caches.delete(n)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));
