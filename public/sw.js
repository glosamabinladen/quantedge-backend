// sw.js — QuantEdge Pro Service Worker
// Handles push notifications for iPad + MacBook Air (Firefox)
// Deploy this to: https://glosamabinladen.github.io/quantedge-pro/sw.js

const CACHE_NAME = "quantedge-pro-v5";
const BACKEND = "https://kaleidoscopic-sundae-1092b5.netlify.app";

// ─── Install & Cache ───────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  console.log("[QE SW] Installing v5...");
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        "/quantedge-pro/",
        "/quantedge-pro/journal.html",
        "/quantedge-pro/icons/icon-192.png",
        "/quantedge-pro/icons/icon-512.png",
      ]).catch(() => {})
    )
  );
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  console.log("[QE SW] Activating...");
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── Push Notification Handler ─────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  console.log("[QE SW] Push received");

  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    data = { title: "QuantEdge Pro", body: event.data?.text() || "New notification" };
  }

  const title = data.title || "◈ QuantEdge Pro";
  const options = {
    body: data.body || "Tap to open terminal",
    icon: data.icon || "/quantedge-pro/icons/icon-192.png",
    badge: data.badge || "/quantedge-pro/icons/badge-72.png",
    tag: data.tag || "quantedge-notification",
    renotify: true,
    requireInteraction: false,
    silent: false,
    timestamp: Date.now(),
    data: data.data || { url: "/quantedge-pro/" },
    actions: data.actions || [
      { action: "open", title: "Open Terminal" },
    ],
    // Vibration pattern: short-long-short
    vibrate: [100, 200, 100],
  };

  // Color the notification based on bias/type
  if (data.data?.type === "morning") {
    options.body = `🌅 ${options.body}`;
  } else if (data.data?.type === "eod") {
    options.body = `🌆 ${options.body}`;
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

// ─── Notification Click Handler ────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  console.log("[QE SW] Notification clicked:", event.action);
  event.notification.close();

  const notifData = event.notification.data || {};
  let targetUrl = "https://glosamabinladen.github.io/quantedge-pro/";

  if (event.action === "journal" || notifData.type === "eod") {
    targetUrl = "https://glosamabinladen.github.io/quantedge-pro/journal.html";
  } else if (notifData.url) {
    targetUrl = notifData.url;
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      // Focus existing window if open
      for (const client of windowClients) {
        if (client.url.includes("glosamabinladen.github.io/quantedge-pro") && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Open new window
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// ─── Push Subscription Change ──────────────────────────────────────────────────
self.addEventListener("pushsubscriptionchange", (event) => {
  console.log("[QE SW] Push subscription changed — re-subscribing...");
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: self.__VAPID_PUBLIC_KEY__,
    }).then(async (subscription) => {
      await fetch(`${BACKEND}/.netlify/functions/push-subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription, deviceName: "Auto-renewed" }),
      });
    })
  );
});

// ─── Fetch Handler (Cache First for assets) ────────────────────────────────────
self.addEventListener("fetch", (event) => {
  // Don't intercept API calls or Netlify functions
  if (
    event.request.url.includes("netlify.app") ||
    event.request.url.includes("polygon.io") ||
    event.request.url.includes("alpaca.markets") ||
    event.request.url.includes("anthropic.com")
  ) {
    return;
  }

  // Cache-first for static assets
  if (event.request.method === "GET") {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (!response || response.status !== 200) return response;
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
    );
  }
});
