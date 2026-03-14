/**
 * sw.js – Viron PWA Service Worker
 *
 * Strategy: Cache-first for all static game assets.
 * On install, pre-cache every asset needed to run the game offline.
 * On activate, delete old caches from previous versions.
 * On fetch, serve from cache; fall back to network and update cache.
 */

'use strict';

const CACHE_VERSION = 'viron-v1';

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
  './terrain.js',
  './particles.js',
  './enemies.js',
  './player.js',
  './hud.js',
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
];

// ---------------------------------------------------------------------------
// Install – pre-cache all assets
// ---------------------------------------------------------------------------
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(PRECACHE_ASSETS))
  );
  // Activate the new SW immediately without waiting for old clients to close.
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Activate – remove stale caches from previous versions
// ---------------------------------------------------------------------------
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      )
    )
  );
  // Take control of all open clients right away.
  self.clients.claim();
});

// ---------------------------------------------------------------------------
// Fetch – cache-first, falling back to network
// ---------------------------------------------------------------------------
self.addEventListener('fetch', event => {
  // Only handle same-origin GET requests.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Not in cache – fetch from network and store for next time.
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_VERSION).then(cache =>
          cache.put(event.request, responseToCache)
        );
        return response;
      });
    })
  );
});
