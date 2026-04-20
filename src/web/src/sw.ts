/**
 * Yoke service worker — minimal push-notification handler.
 *
 * No asset caching. This is a localhost dev tool, not an offline PWA.
 *
 * Uses explicit `any` casts for ServiceWorker-specific types because
 * TypeScript's webworker lib conflicts with the DOM lib included by the
 * main tsconfig. The service worker logic is straightforward enough that
 * `any` casts carry no meaningful risk here.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

// `self` in service worker scope is ServiceWorkerGlobalScope.
// eslint-disable-next-line no-restricted-globals
const sw: any = self;

sw.addEventListener('install', () => {
  sw.skipWaiting();
});

sw.addEventListener('activate', (event: any) => {
  event.waitUntil(sw.clients.claim());
});

// No fetch handler — no caching. Requests fall through to the network.

sw.addEventListener('message', (event: any) => {
  const data: Record<string, unknown> = event.data ?? {};
  if (data['type'] !== 'SHOW_NOTIFICATION') return;

  const title = String(data['title'] ?? 'Yoke');
  const body = String(data['body'] ?? '');
  const url = String(data['url'] ?? '/');

  event.waitUntil(
    sw.registration.showNotification(title, {
      body,
      tag: url,
      data: { url },
    }),
  );
});

sw.addEventListener('notificationclick', (event: any) => {
  event.notification.close();
  const targetUrl = String(
    (event.notification.data as Record<string, unknown>)?.['url'] ?? '/',
  );

  event.waitUntil(
    sw.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList: any[]) => {
        for (const client of clientList) {
          if (
            (client.url as string).startsWith(sw.location.origin as string) &&
            'focus' in client
          ) {
            client.postMessage({ type: 'NAVIGATE', url: targetUrl });
            return client.focus();
          }
        }
        return sw.clients.openWindow(targetUrl);
      }),
  );
});
