// HQ service worker: only for phone notifications (nothing is cached).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "HQ", {
    body: d.body || "",
    tag: d.tag,
    renotify: !!d.tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: d.url || "/" },
  }));
});

// Tapping a notification: bring HQ forward on that chat, or open it.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: "hq-open", url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
