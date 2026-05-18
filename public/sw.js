/* Service Worker — Mi Piel */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));

/* ── Push notifications ───────────────────────────────────────────────── */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  const title = data.title || 'Nueva reserva';
  const options = {
    body:     data.body  || 'Alguien reservó un turno.',
    icon:     '/icon-192.png',
    badge:    '/icon-192.png',
    tag:      data.tag   || 'booking',
    renotify: true,
    data:     { url: data.url || '/admin' },
    actions:  [{ action: 'open', title: 'Ver agenda' }],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/admin';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes('/admin') && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
