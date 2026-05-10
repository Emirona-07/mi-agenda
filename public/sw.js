self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
// fetch: solo pass-through (sin cache offline por ahora)
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
