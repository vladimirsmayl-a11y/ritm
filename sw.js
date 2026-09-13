'use strict';
const SCOPE = self.registration.scope;
const PREFIX = 'ritm:' + new URL(SCOPE).pathname + ':';
const CACHE = PREFIX + 'neon-v4';
const FILES = ['./','index.html','style.css','engine.js','app.js','manifest.json','icon.svg','fire.svg','ice.svg','emoji-reading.svg','emoji-run.svg','emoji-workout.svg','emoji-goal.svg','emoji-work.svg','emoji-sun.svg','icon-192.png','icon-512.png','manrope-cyrillic-wght-normal.woff2','manrope-latin-wght-normal.woff2'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(file => new URL(file,SCOPE).href))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request,copy)));
    }
    return response;
  }).catch(async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(event.request) || (event.request.mode === 'navigate' ? await cache.match(new URL('index.html',SCOPE).href) : undefined) || Response.error();
  }));
});
