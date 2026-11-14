/*
 * KnightWatch service worker.
 *
 * The precache list and version are injected at build time by the
 * `knightwatch-pwa` plugin in vite.config.ts. The app shell, hashed bundles,
 * demo reports, icons, and the Stockfish WASM engine are cached on install so
 * saved reports, the review board, exports, and PGN analysis keep working
 * without a network connection.
 *
 * Requests to lichess.org and api.chess.com are never intercepted: scan data
 * must always come from the network, and nothing about a scan is cached here.
 */

const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;

const CACHE = `knightwatch-${VERSION}`;
const APP_SHELL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Add files individually: one stale URL should not disable offline mode.
      const results = await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed) console.warn(`[knightwatch] ${failed} precache request(s) failed`);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("knightwatch-") && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  if (event.data === "PING") {
    event.waitUntil(
      caches.keys().then((keys) =>
        event.source?.postMessage({
          type: "PONG",
          version: VERSION,
          cache: CACHE,
          keys,
        }),
      ),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: prefer fresh HTML, fall back to the cached shell offline.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            await cache.put(APP_SHELL, fresh.clone());
            return fresh;
          }
          // Server unreachable through a gateway/proxy: keep the app usable.
          if (fresh.status >= 500) return (await cache.match(APP_SHELL, { ignoreVary: true })) || fresh;
          return fresh;
        } catch {
          return (
            (await cache.match(APP_SHELL, { ignoreVary: true })) ||
            (await cache.match(request, { ignoreVary: true })) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Same-origin assets: cache-first, fill the cache on first use.
  // The worker script itself is never cached, so update checks stay fresh.
  if (url.pathname === "/sw.js") return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
      if (hit) return hit;
      const fresh = await fetch(request);
      if (fresh.ok) await cache.put(request, fresh.clone());
      return fresh;
    })(),
  );
});
