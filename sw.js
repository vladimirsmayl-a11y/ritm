'use strict';
const SCOPE = self.registration.scope;
const PREFIX = 'ritm:' + new URL(SCOPE).pathname + ':';
const CACHE = PREFIX + 'neon-v6';
const FILES = ['./','index.html','style.css','engine.js','app.js','feedback.js','reminders.js','reminder-config.js','manifest.json','icon.svg','fire.svg','ice.svg','emoji-reading.svg','emoji-run.svg','emoji-workout.svg','emoji-goal.svg','emoji-work.svg','emoji-sun.svg','icon-192.png','icon-512.png','notification-badge.png','manrope-cyrillic-wght-normal.woff2','manrope-latin-wght-normal.woff2','sound-task.wav','sound-habit.wav','sound-missed.wav','sound-streak.wav','sound-complete.wav','sound-swipe.wav'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(file => new URL(file,SCOPE).href))).then(() => self.skipWaiting()));
});

function localDate(date) {
  return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
}
function openData() {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open('ritm-planner',1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function showEveningPush(payload) {
  const now = new Date(), date = localDate(now);
  if (payload?.kind !== 'ritm-evening' || payload.date !== date || now.getHours() !== 21 || !Number.isFinite(payload.expires) || payload.expires <= now.getTime()) return;
  const db = await openData();
  try {
    const state = await new Promise((resolve,reject) => {
      const request = db.transaction('data').objectStore('data').get('state');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (!state?.settings?.reminderEnabled) return;
    const items = state.days[date]?.items;
    const pending = items ? items.filter(item => item.habit && !item.removed && item.status === 'pending').length
      : state.habits.filter(habit => habit.start <= date && (!habit.end || habit.end > date) && habit.week.includes(now.getDay())).length;
    if (!pending) return;
    const acquired = await new Promise((resolve,reject) => {
      let claim = false;
      const transaction = db.transaction('data','readwrite'), store = transaction.objectStore('data'), request = store.get('reminder-last-date');
      request.onsuccess = () => { if (request.result !== date) {store.put(date,'reminder-last-date');claim = true;} };
      transaction.oncomplete = () => resolve(claim);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    if (!acquired) return;
    try {
      await self.registration.showNotification('Ритм · вечерняя отметка', {
        body:'Есть привычки без отметки. Пара касаний — и сегодняшний план обновлён.',
        icon:new URL('icon-192.png',SCOPE).href, badge:new URL('notification-badge.png',SCOPE).href,
        tag:'ritm-evening-'+date, silent:true,
        data:{kind:'ritm-evening',date,url:new URL('#habits',SCOPE).href},
        actions:[{action:'habits',title:'Отметить привычки'}]
      });
    } catch (error) {
      await new Promise(resolve => {
        const transaction = db.transaction('data','readwrite');
        transaction.objectStore('data').delete('reminder-last-date');
        transaction.oncomplete = transaction.onerror = transaction.onabort = resolve;
      });
      throw error;
    }
  } finally { db.close(); }
}
self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch (_) { return; }
  event.waitUntil(showEveningPush(payload));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const current = windows.find(client => client.url.startsWith(SCOPE));
    if (current) { await current.focus(); current.postMessage({kind:'open-habits'}); }
    else await self.clients.openWindow(new URL('#habits',SCOPE).href);
  })());
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
