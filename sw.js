/**
 * sw.js – Viron PWA Service Worker
 *
 * Strategy: Cache-first for all static game assets.
 * On install, pre-cache every asset needed to run the game offline.
 * On activate, delete old caches from previous versions.
 * On fetch, serve from cache; fall back to network and update cache.
 *
 * Update flow:
 *   1. Bump CACHE_VERSION whenever game files change.
 *   2. The browser detects the changed sw.js and installs the new SW.
 *   3. The new SW pre-caches all assets but does NOT call skipWaiting()
 *      automatically – it waits so the currently-running page is never
 *      served by a mismatched SW/asset combination.
 *   4. The page receives an 'updatefound' event, shows an update banner,
 *      and sends a SKIP_WAITING message here when the user taps "Update".
 *   5. This SW calls skipWaiting(), takes control, and the page reloads
 *      via the 'controllerchange' listener in index.html.
 */

'use strict';

const CACHE_VERSION = 'viron-v7.5';

/** Every static asset the game needs to run offline. */
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './p5.js',
  './p5.sound.min.js',
  './sfx.js',
  './constants.js',
  './shipDesigns.js',
  './terrainShaders.js',
  './buildingGeometry.js',
  './terrain.js',
  './particles.js',
  './enemies.js',
  './player.js',
  './hudCore.js',
  './hudComponents.js',
  './hudScreens.js',
  './aimAssist.js',
  './mobileControls.js',
  './gameState.js',
  './gameRenderer.js',
  './gameLoop.js',

  './sketch.js',
  './Impact.ttf',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/apple-touch-icon-152.png',
  './icons/apple-touch-icon-167.png',
  './icons/icon.svg',
  './icons/icon-1024.png',
];

// ---------------------------------------------------------------------------
// Install – pre-cache all assets.
// Do NOT call skipWaiting() here; the page will request activation via a
// postMessage({type:'SKIP_WAITING'}) once the user confirms the update.
// This prevents the running page from being served by a mismatched SW.
// ---------------------------------------------------------------------------
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .catch(err => {
        console.error('[SW] Pre-cache failed:', err);
        throw err; // Rethrow so the install fails and the browser retries.
      })
  );
});

// ---------------------------------------------------------------------------
// Message – allow the client page to trigger activation when ready.
// ---------------------------------------------------------------------------
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

// ---------------------------------------------------------------------------
// Activate – remove stale caches from previous versions, then claim clients.
// ---------------------------------------------------------------------------
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_VERSION)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch – cache-first, falling back to network.
// ---------------------------------------------------------------------------
self.addEventListener('fetch', event => {
  // Only handle same-origin GET requests.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;

      // Not in cache – fetch from network and store for next time.
      return fetch(event.request)
        .then(response => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          const responseToCache = response.clone();
          caches.open(CACHE_VERSION).then(cache =>
            cache.put(event.request, responseToCache)
          );
          return response;
        })
        .catch(() => {
          // Network failed and no cache entry – return a minimal offline response.
          return new Response('Viron is offline. Please reconnect and reload.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          });
        });
    })
  );
});
