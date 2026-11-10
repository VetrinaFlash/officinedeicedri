// Service worker: notifiche push + cache leggera dell'interfaccia.
const CACHE = 'odc-v1';
const SHELL = ['/', '/index.html', '/assets/app.css', '/assets/common.js', '/assets/shop.js', '/admin/', '/admin/index.html', '/assets/admin.js', '/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// rete prima, cache come riserva (solo file statici; le API non vengono mai salvate)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Aggiornamento', body: e.data && e.data.text() }; }
  const title = data.title || 'Officine dei Cedri';
  e.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { url: data.url || '/' },
    });
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'push', payload: data }));
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || '/', location.origin).href;
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameApp = clients.find(c => new URL(c.url).pathname.startsWith(new URL(target).pathname.startsWith('/admin') ? '/admin' : '/'));
    if (sameApp) { await sameApp.focus(); return sameApp.navigate(target).catch(() => {}); }
    return self.clients.openWindow(target);
  })());
});
