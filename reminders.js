'use strict';
window.RitmReminders = (() => {
  let db, getState, persistSettings, announce = () => {}, changed = () => {};
  let device = null, timer, syncTimer, checking = false, syncing = false, syncAgain = false, lastSummary = '';
  let pushActive = false, errorMessage = '';
  let initialized = false;
  let disconnecting = null;
  const metaKey = 'reminder-device', dateKey = 'reminder-last-date';
  const service = (() => {
    try {
      if (!window.RITM_REMINDER_SERVICE) return '';
      const url = new URL(window.RITM_REMINDER_SERVICE);
      if (url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname)) return '';
      url.search = ''; url.hash = '';
      return url.href.replace(/\/$/, '');
    } catch (_) { return ''; }
  })();
  const supported = () => isSecureContext && 'Notification' in window && 'serviceWorker' in navigator;
  const enabled = () => getState?.().settings?.reminderEnabled === true;
  const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  async function registrationReady() {
    let timeout;
    try {
      return await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject) => {
        timeout = setTimeout(() => reject(Error('Обнови Ритм с интернетом, чтобы подготовить уведомления.')),8000);
      })]);
    } finally {clearTimeout(timeout);}
  }
  function read(key) {
    return new Promise((resolve, reject) => {
      const request = db.transaction('data').objectStore('data').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function write(key, value) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('data','readwrite');
      const store = transaction.objectStore('data');
      if (value === undefined) store.delete(key); else store.put(value,key);
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }
  function claim(date) {
    return new Promise((resolve, reject) => {
      let acquired = false;
      const transaction = db.transaction('data','readwrite'), store = transaction.objectStore('data');
      const request = store.get(dateKey);
      request.onsuccess = () => {
        if (request.result !== date) { store.put(date,dateKey); acquired = true; }
      };
      transaction.oncomplete = () => resolve(acquired);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }
  function summary() {
    const state = getState(), date = PlannerEngine.key(new Date());
    const day = state.days[date];
    return {
      timeZone:timeZone(), day:date,
      pending:(day?.items || []).filter(item => item.habit && item.status === 'pending').length,
      schedules:state.habits.filter(habit => !habit.end || habit.end > date).map(habit => ({
        start:habit.start, end:habit.end || null, week:habit.week
      }))
    };
  }
  async function request(path, method = 'GET', body, token, registrationCode) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),8000);
    try {
      const response = await fetch(service + path, {
        method, mode:'cors', credentials:'omit', cache:'no-store', signal:controller.signal,
        headers:{...(body ? {'Content-Type':'application/json'} : {}),
          ...(token ? {Authorization:'Bearer '+token} : {}),
          ...(registrationCode ? {'X-Registration-Code':registrationCode} : {})},
        ...(body ? {body:JSON.stringify(body)} : {})
      });
      if (!response.ok) {
        const error = Error(response.status === 401 || response.status === 403 ? 'Проверь код подключения.' : 'Сервис напоминаний пока недоступен.');
        error.status = response.status;
        throw error;
      }
      return response.status === 204 ? null : response.json();
    } finally { clearTimeout(timeout); }
  }
  function decodeKey(key) {
    const data = atob(key.replace(/-/g,'+').replace(/_/g,'/'));
    return Uint8Array.from(data, character => character.charCodeAt(0));
  }
  async function connect(code) {
    if (!service || !('PushManager' in window)) throw Error('Фоновые уведомления здесь недоступны.');
    const previous = device;
    const reconnect = device?.service === service;
    if (!reconnect && !code?.trim()) throw Error('Введи код подключения для этого устройства.');
    const registration = await registrationReady();
    const {publicKey} = await request('/public-key');
    const key = decodeKey(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription?.options.applicationServerKey && !equalKeys(new Uint8Array(subscription.options.applicationServerKey),key)) {
      await subscription.unsubscribe(); subscription = null;
    }
    const created = !subscription;
    subscription ||= await registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:key});
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    let candidate = reconnect ? {...device,active:true} : {id:crypto.randomUUID(), token:Array.from(tokenBytes, value => value.toString(16).padStart(2,'0')).join(''), service, active:true};
    try {
      const status = {subscription:subscription.toJSON(),...summary()};
      let reconnected = false;
      if (reconnect) {
        try {await request('/devices/'+encodeURIComponent(candidate.id),'PUT',status,candidate.token);reconnected = true;}
        catch (error) {
          if (error.status !== 401 && error.status !== 404) throw error;
          device = null; await write(metaKey,undefined); changed();
          if (!code?.trim()) throw Error('Для повторного подключения нужен код. Введи его ниже.');
          candidate = {id:crypto.randomUUID(),token:Array.from(tokenBytes,value => value.toString(16).padStart(2,'0')).join(''),service,active:true};
        }
      }
      if (!reconnected) await request('/devices','POST',{id:candidate.id,token:candidate.token,
        clientUrl:registration.scope,notifiedDate:await read(dateKey) || null,...status},null,code.trim());
      if (previous && (previous.id !== candidate.id || previous.service !== candidate.service)) await removeRemote(previous);
      device = candidate;
      await write(metaKey,device);
      pushActive = true; errorMessage = ''; lastSummary = '';
    } catch (error) {
      if (created) await subscription.unsubscribe().catch(() => {});
      throw error;
    }
  }
  function equalKeys(a,b) { return a.length === b.length && a.every((value,index) => value === b[index]); }
  async function removeRemote(previous) {
    // Unsubscribing locally takes effect even when this request is offline.
    if (!previous?.service) return;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),8000);
    try {
      await fetch(previous.service+'/devices/'+encodeURIComponent(previous.id), {
        method:'DELETE', credentials:'omit', headers:{Authorization:'Bearer '+previous.token}, signal:controller.signal
      });
    } catch (_) {} finally { clearTimeout(timeout); }
  }
  async function deactivateRemote(previous) {
    if (!previous?.service) return;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),8000);
    try {
      await fetch(previous.service+'/devices/'+encodeURIComponent(previous.id), {
        method:'PUT',credentials:'omit',headers:{Authorization:'Bearer '+previous.token,'Content-Type':'application/json'},
        body:JSON.stringify({enabled:false}),signal:controller.signal
      });
    } catch (_) {} finally {clearTimeout(timeout);}
  }
  async function enable(code) {
    if (!initialized) throw Error('Уведомления ещё подготавливаются. Попробуй через секунду.');
    if (!supported()) throw Error('Открой HTTPS-сайт в Chrome: здесь системные уведомления недоступны.');
    // This call happens directly after the settings tap, never on page load.
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') throw Error('Уведомления запрещены. Разреши их в настройках сайта в Chrome.');
    if (service && !pushActive) await connect(code);
    const result = await persistSettings({reminderEnabled:true});
    if (!result.ok) {
      await disconnect();
      throw Error('Не удалось сохранить настройку.');
    }
    changed(); schedule(); await check();
  }
  async function disconnect() {
    if (disconnecting) return disconnecting;
    disconnecting = disconnectDevice();
    try { await disconnecting; } finally { disconnecting = null; }
  }
  async function disconnectDevice() {
    pushActive = false;
    const previous = device;
    if (device) { device.active = false; await write(metaKey,device); }
    if (supported()) {
      const registration = await navigator.serviceWorker.getRegistration('./');
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) await subscription.unsubscribe().catch(() => {});
      const notifications = await registration?.getNotifications();
      notifications?.forEach(notification => notification.close());
    }
    await deactivateRemote(previous);
  }
  async function disable() {
    const result = await persistSettings({reminderEnabled:false});
    if (!result.ok) throw Error('Не удалось сохранить настройку.');
    await disconnect(); errorMessage = ''; changed(); schedule();
  }
  async function check() {
    if (!db || checking || !enabled() || !supported() || Notification.permission !== 'granted' || pushActive) return;
    const now = new Date();
    // No morning replay; an open app can remind only during the 21:00 hour.
    if (now.getHours() !== 21 || summary().pending === 0) return;
    checking = true;
    const date = PlannerEngine.key(now);
    let acquired = false;
    try {
      const registration = await registrationReady();
      acquired = await claim(date);
      if (!acquired) return;
      // Recheck after asynchronous registration/DB work: completion wins.
      if (!enabled() || new Date().getHours() !== 21 || summary().pending === 0) {
        await write(dateKey,undefined); return;
      }
      await registration.showNotification('Ритм · вечерняя отметка', {
        body:'Есть привычки без отметки. Пара касаний — и сегодняшний план обновлён.',
        icon:new URL('icon-192.png',registration.scope).href,
        badge:new URL('notification-badge.png',registration.scope).href,
        tag:'ritm-evening-'+date, silent:true,
        data:{kind:'ritm-evening', date, url:new URL('#habits',registration.scope).href},
        actions:[{action:'habits',title:'Отметить привычки'}]
      });
      announce('Вечерняя отметка: загляни в привычки.');
    } catch (_) { if (acquired) await write(dateKey,undefined).catch(() => {}); }
    finally { checking = false; }
  }
  function schedule() {
    clearTimeout(timer);
    if (!enabled()) return;
    timer = setTimeout(() => { check(); schedule(); },30000);
  }
  async function sync() {
    if (!db || !service || !device?.active || !pushActive || !enabled() || !navigator.onLine) return;
    if (syncing) { syncAgain = true; return; }
    const current = summary(), encoded = JSON.stringify(current);
    if (encoded === lastSummary) return;
    syncing = true;
    try {
      const registration = await registrationReady();
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) { pushActive = false; errorMessage = 'Нужно снова включить уведомления.'; changed(); return; }
      await request('/devices/'+encodeURIComponent(device.id),'PUT',{...current, subscription:subscription.toJSON()},device.token);
      lastSummary = encoded; errorMessage = ''; changed();
    } catch (error) {
      errorMessage = 'Подключись к интернету, чтобы обновить вечернее напоминание.';
      if (error.status === 401 || error.status === 404) { pushActive = false; device.active = false; await write(metaKey,device); }
      changed();
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; sync(); }
    }
  }
  function stateChanged() {
    if (!initialized) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { sync(); check(); },250);
    schedule();
    if (!enabled() && device?.active) disconnect().catch(() => {});
  }
  function status() {
    return {ready:initialized, supported:supported(), permission:supported() ? Notification.permission : 'unavailable',
      configured:Boolean(service), canReconnect:Boolean(device?.service === service), pushActive, enabled:enabled(), error:errorMessage};
  }
  async function test() {
    if (!supported() || !enabled() || Notification.permission !== 'granted') throw Error('Сначала включи вечернее напоминание.');
    const registration = await registrationReady();
    await registration.showNotification('Ритм · уведомления работают', {
      body:'Вечером напомним о привычках без отметки. Утренних уведомлений нет.',
      icon:new URL('icon-192.png',registration.scope).href,
      badge:new URL('notification-badge.png',registration.scope).href,
      tag:'ritm-test', silent:true,
      data:{kind:'ritm-test',url:new URL('#habits',registration.scope).href}
    });
  }
  async function init(options) {
    db = options.db; getState = options.getState; persistSettings = options.persistSettings;
    announce = options.announce; changed = options.changed || (() => {});
    device = await read(metaKey) || null;
    if (device?.active && supported() && device.service === service && enabled()) {
      const registration = await registrationReady();
      pushActive = Boolean(await registration.pushManager?.getSubscription());
    } else if (device?.active) await disconnect();
    initialized = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastSummary = ''; stateChanged(); } });
    window.addEventListener('online', () => { lastSummary = ''; stateChanged(); if (device && !enabled()) deactivateRemote(device); });
    window.addEventListener('focus', () => { check(); });
    navigator.serviceWorker?.addEventListener('message', event => {
      if (event.data?.kind === 'open-habits') options.openHabits();
    });
    schedule(); stateChanged(); changed();
  }
  function failed() {errorMessage = 'Обнови Ритм с интернетом, чтобы подготовить уведомления.';changed();}
  return {init, enable, disable, status, stateChanged, test, failed};
})();
