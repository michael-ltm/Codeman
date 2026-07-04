/**
 * @fileoverview Service worker for PWA install + Web Push notifications.
 *
 * Runtime caching: same-origin static assets are fetched network-first and then
 * cached as a fallback. HTML navigations are never cached; the app shell is
 * content-hashed at build time, and replaying an old cached "/" can pair a stale
 * index with missing CSS/JS after login.
 *
 * Push notifications: receives push events from the Codeman server (via
 * web-push library) and displays OS-level notifications. Handles notification
 * clicks to focus an existing Codeman tab or open a new one.
 *
 * Lifecycle: skipWaiting on install, claim clients on activate -- ensures the
 * latest service worker takes control immediately without waiting for tab
 * refresh.
 *
 * @dependency None (runs in ServiceWorkerGlobalScope, isolated from page scripts)
 * @see src/push-store.ts -- server-side VAPID key management and subscription CRUD
 */

const CACHE_NAME = 'codeman-runtime-v2';

// Keep the install cache tiny and immutable. The built app shell references
// content-hashed JS/CSS filenames that are not known to this source file, so
// runtime fetches cache the exact URLs the current index requests.
const APP_SHELL = [
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
];

// --- Install: precache app shell ---

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(APP_SHELL.map((url) => cache.add(url).catch(() => {})));
    })
  );
  self.skipWaiting();
});

// --- Activate: clean old caches, claim clients ---

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// --- Fetch: network-first with cache fallback ---
// Network-first ensures deploys take effect immediately when online.
// Cache is only used when the network is unavailable (offline/flaky).

function isHtmlNavigation(request) {
  return request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
}

function isHtmlResponse(response) {
  return (response.headers.get('content-type') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, WebSocket upgrades, and SSE streams
  if (request.method !== 'GET') return;
  if (request.headers.get('upgrade') === 'websocket') return;
  if (request.headers.get('accept') === 'text/event-stream') return;
  if (request.url.includes('/api/')) return;
  if (url.pathname === '/sw.js') return;

  if (isHtmlNavigation(request)) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && !isHtmlResponse(response)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// --- Push notifications ---

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  const { title, hostTitle, body, tag, sessionId, urgency, actions } = payload;

  const options = {
    body: body || '',
    tag: tag || 'codeman-default',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { sessionId, url: sessionId ? `/?session=${sessionId}` : '/' },
    renotify: true,
    requireInteraction: urgency === 'critical',
  };

  if (actions && actions.length > 0) {
    options.actions = actions;
  }

  // Match the in-page Notification format: "codeman:<host>: <event title>".
  // hostTitle is sent by servers >= the hostname-aware push payload change;
  // older servers omit it and we fall back to the bare title.
  const displayTitle = hostTitle && title
    ? `${hostTitle}: ${title}`
    : (title || hostTitle || 'Codeman');

  event.waitUntil(
    self.registration.showNotification(displayTitle, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { sessionId, url } = event.notification.data || {};
  const targetUrl = url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Try to find an existing Codeman tab
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({
            type: 'notification-click',
            sessionId,
            action: event.action || null,
          });
          return client.focus();
        }
      }
      // No existing tab -- open a new one
      return self.clients.openWindow(targetUrl);
    })
  );
});
