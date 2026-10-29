self.addEventListener("install", () => {
  console.debug("[Service Worker] installed")
})

self.addEventListener("activate", (event: any) => {
  event.waitUntil((self as any).clients.claim())
  console.debug("[Service Worker] activated")
})

self.addEventListener("fetch", () => {
  // Without this event handler we won't be recognized as a PWA.
})

self.addEventListener("notificationclick", (event: any) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || "./", self.location.href)
  if (target.origin !== self.location.origin) return
  event.waitUntil(
    (self as any).clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients: any[]) => {
      const existing = clients.find((client) => client.url === target.href)
      if (existing) return existing.focus()
      return (self as any).clients.openWindow(target.href)
    }),
  )
})
