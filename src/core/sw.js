// The hub's service worker, served at /sw.js with scope / (Web Push, architecture.md "Thông báo"). It does one thing: show what
// the hub pushes ({title, body, url, tag}, encrypted end to end) and open or focus the hub on a tap. No fetch handler:
// pages load from the network as before. Registered by the notifications page (modules/notify/push.js).
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('push', e => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { /* not ours: still shown, a push must always show something */ }
  // tag: one notification per hub page on the device, the newest replacing the older one, and still ringing (renotify)
  e.waitUntil(self.registration.showNotification(String(d.title || 'Work Hub'), {
    body: String(d.body || ''), icon: '/icon.png', data: { url: String(d.url || '/') },
    ...(d.tag ? { tag: String(d.tag), renotify: true } : {}),
  }))
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = new URL(e.notification.data?.url || '/', self.location.origin)
  if (url.origin !== self.location.origin) return // only the hub's own pages
  e.waitUntil((async () => {
    // a hub tab already open is reused; navigate() works only on a page this worker controls, otherwise a new window
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      try { await c.focus(); if (await c.navigate(url.href)) return } catch { /* not controlled: try the next */ }
    }
    await self.clients.openWindow(url.href)
  })())
})
