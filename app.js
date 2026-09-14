'use strict';
const E = PlannerEngine;
const Feedback = RitmFeedback, Reminders = RitmReminders;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const delay = ms => new Promise(resolve => setTimeout(resolve, reducedMotion() ? 0 : ms));
const uid = () => crypto.randomUUID();
const tabs = ['Сегодня','Привычки','История','Аналитика'];
const colors = ['#a8ff35','#79c6ff','#c19bff','#ffbb79','#ff8eb2','#b4bbc7'];
const colorNames = ['Лайм','Голубой','Сиреневый','Персиковый','Розовый','Серый'];
let state, db, stats, today = E.key(new Date()), tab = 'Сегодня', plan = 'today';
let busy = false, interacting = false, lastView = '', viewDirection = 'forward';
let toastTimer, closeTimer, confettiFrame, blockClicksUntil = 0;
let doneOpen = false, removedOpen = false, pendingNavigation = null;

const paths = {
  today:'<rect x="4" y="4" width="16" height="16" rx="5"/><path d="m8 12 3 3 5-6"/>',
  habits:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  history:'<path d="M3 11a9 9 0 1 1 2.6 7.4M3 5v6h6"/><path d="M12 7v5l3 2"/>',
  analytics:'<path d="M4 20h16M6 15v-4M12 15V4M18 15V8"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  check:'<path class="tick" d="m5 12 4 4L19 6"/>',
  cross:'<path d="m7 7 10 10M17 7 7 17"/>',
  minus:'<path d="M6 12h12"/>',
  dots:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chevron:'<path d="m8 5 7 7-7 7"/>',
  down:'<path d="m6 9 6 6 6-6"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  edit:'<path d="m14 4 6 6M4 20l5-1L20 8a2 2 0 0 0-4-4L5 15l-1 5Z"/>',
  move:'<path d="M4 12h16m-5-5 5 5-5 5"/>',
  undo:'<path d="M4 5v6h6M4 11a8 8 0 1 1 1 7"/>',
  trophy:'<path d="M8 3h8v6a4 4 0 0 1-8 0V3ZM8 5H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4M12 13v5M8 21h8M9 18h6"/>',
  ice:'<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 3 3-3M9 20l3-3 3 3"/>',
  rest:'<path d="M20 15a8 8 0 0 1-11-11 8 8 0 1 0 11 11Z"/>',
  circle:'<circle cx="12" cy="12" r="8"/>',
  settings:'<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  sound:'<path d="M11 4 6 8H3v8h3l5 4V4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/>'
};
function icon(name, extra = '') {
  return `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.today}</svg>`;
}
function plural(number) {
  return number % 10 === 1 && number % 100 !== 11 ? 'день' : number % 10 >= 2 && number % 10 <= 4 && (number % 100 < 12 || number % 100 > 14) ? 'дня' : 'дней';
}
const dateLabel = key => new Date(key + 'T12:00:00').toLocaleDateString('ru', {day:'numeric',month:'long'});
const safeColor = color => /^#[0-9a-f]{6}$/i.test(color) ? color : colors[0];
const findItem = (date, id) => state.days[date]?.items.find(item => item.id === id);
const rowElement = id => [...document.querySelectorAll('[data-row]')].find(element => element.dataset.row === id);

function toast(message, undo) {
  clearTimeout(toastTimer);
  const element = $('#toast');
  element.innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button">Отменить</button>' : ''}`;
  element.hidden = false;
  if (undo) element.querySelector('button').onclick = async () => { element.hidden = true; await undo(); };
  toastTimer = setTimeout(() => { element.hidden = true; }, undo ? 6500 : 3400);
}
function haptic(pattern = 12) {
  Feedback.vibrate(pattern);
}
function normalizeSettings() {
  const value = state.settings || {};
  state.settings = {feedbackEnabled:value.feedbackEnabled !== false, reminderEnabled:value.reminderEnabled === true};
}
function save() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('data','readwrite');
    transaction.objectStore('data').put(state,'state');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
async function commit(change, options = {}) {
  if (busy) return {ok:false};
  busy = true;
  const previous = structuredClone(state);
  const before = E.calculate(state,today);
  const wasIdeal = state.days[today]?.outcome === 'ideal';
  try {
    change();
    stats = E.calculate(state,today);
    await save();
    Feedback.changed();
    Reminders.stateChanged();
    const result = {ok:true, celebrate:!wasIdeal && state.days[today]?.outcome === 'ideal', iceEarned:stats.ice > before.ice};
    if (options.render !== false) render();
    if (options.reward !== false) presentReward(result);
    return result;
  } catch (error) {
    state = previous;
    stats = E.calculate(state,today);
    render();
    toast('Не удалось сохранить. Попробуй ещё раз.');
    return {ok:false};
  } finally {
    busy = false;
    flushNavigation();
  }
}
function closeSheet(immediate = false) {
  clearTimeout(closeTimer);
  const dialog = $('#sheet');
  if (!dialog.open) return;
  if (immediate || reducedMotion()) { dialog.close(); dialog.classList.remove('closing'); return; }
  dialog.classList.add('closing');
  closeTimer = setTimeout(() => { dialog.close(); dialog.classList.remove('closing'); },170);
}
function modal(title, contents, submit) {
  closeSheet(true);
  $('#form').innerHTML = `<div class="sheet-heading"><h2 id="sheetTitle">${esc(title)}</h2><button class="sheet-close" id="cancel" type="button" aria-label="Закрыть">${icon('cross')}</button></div>${contents}`;
  $('#cancel').onclick = () => closeSheet();
  $('#form').onsubmit = event => { event.preventDefault(); if (!busy && !interacting) submit?.(); };
  $('#sheet').showModal();
}
function settingsForm() {
  const settings = state.settings, status = Reminders.status();
  modal('Настройки', `<div class="settings-list">
    <label class="setting-row" for="feedbackSwitch"><span class="setting-symbol">${icon('sound')}</span><span class="setting-copy"><strong>Звуки и вибрация</strong><small>Тихий отклик на твой прогресс</small></span><span class="switch"><input id="feedbackSwitch" type="checkbox" role="switch" ${settings.feedbackEnabled ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span></span></label>
    <button id="testSound" class="setting-test" type="button">${icon('sound')} Послушать звук</button>
    <div class="setting-divider"></div>
    <label class="setting-row" for="reminderSwitch"><span class="setting-symbol">${icon('bell')}</span><span class="setting-copy"><strong>Вечернее напоминание</strong><small>В 21:00, если привычки без отметки</small></span><span class="switch"><input id="reminderSwitch" type="checkbox" role="switch" ${settings.reminderEnabled ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span></span></label>
    <p id="reminderMode" class="helper" role="status"></p>
    <div class="notification-preview"><span class="notification-logo">${icon('habits')}</span><div><div class="notification-meta"><span>РИТМ</span><span>21:00</span></div><strong>Вечерняя отметка</strong><p>Пара касаний — и сегодняшний план обновлён.</p></div></div>
    ${status.configured ? '<div id="connectionGroup"><label class="connection-label" for="connectionCode">Код подключения</label><input id="connectionCode" type="password" autocomplete="off" maxlength="128" placeholder="Код для этого устройства"><p class="helper">Нужен один раз для напоминаний при закрытом Ритме.</p></div>' : ''}
    <button id="testReminder" class="setting-test" type="button">${icon('bell')} Проверить уведомление</button>
  </div>`);
  $('#feedbackSwitch').onchange = async event => {
    const input = event.target, enabled = input.checked;
    input.disabled = true;
    const result = await commit(()=>{state.settings.feedbackEnabled = enabled;},{reward:false});
    input.disabled = false;
    input.checked = state.settings.feedbackEnabled;
    if (result.ok && enabled) Feedback.unlock();
    updateSettingsStatus();
  };
  $('#testSound').onclick = () => {Feedback.unlock();Feedback.play('task');haptic(10);};
  $('#reminderSwitch').onchange = async event => {
    const input = event.target;
    input.dataset.pending = 'true';
    input.disabled = true;
    try {
      if (input.checked) await Reminders.enable($('#connectionCode')?.value);
      else await Reminders.disable();
      toast(input.checked ? 'Вечернее напоминание включено' : 'Напоминание выключено');
    } catch (error) { toast(error.message); }
    finally { delete input.dataset.pending; input.checked = state.settings.reminderEnabled; updateSettingsStatus(); }
  };
  $('#testReminder').onclick = async event => {
    const button = event.currentTarget;
    button.dataset.pending = 'true'; button.disabled = true;
    try { await Reminders.test(); toast('Проверь уведомления телефона'); }
    catch (error) { toast(error.message); }
    finally { delete button.dataset.pending; updateSettingsStatus(); }
  };
  updateSettingsStatus();
}
function updateSettingsStatus() {
  if (!$('#reminderMode')) return;
  const status = Reminders.status();
  const message = !status.supported ? 'Для системных уведомлений открой HTTPS-сайт в Chrome.'
    : status.error ? status.error
    : !status.ready ? 'Подготавливаем уведомления…'
    : status.permission === 'denied' ? 'Уведомления запрещены в настройках сайта в Chrome.'
    : status.enabled && status.permission !== 'granted' ? 'Выключи и снова включи напоминание, чтобы разрешить уведомления.'
    : (status.pushActive ? 'Придёт и при закрытом Ритме. Утренних напоминаний нет.'
    : status.configured ? (status.canReconnect ? 'Телефон подключён. Напоминание можно снова включить без кода.' : 'Подключи этот телефон кодом, чтобы получать напоминания при закрытом Ритме.')
    : 'Работает, пока Ритм открыт. Утренних напоминаний нет.');
  $('#reminderMode').textContent = message;
  $('#reminderSwitch').disabled = Boolean($('#reminderSwitch').dataset.pending) || !status.ready || !status.supported;
  $('#testSound').disabled = !state.settings.feedbackEnabled;
  $('#testReminder').disabled = Boolean($('#testReminder').dataset.pending) || !state.settings.reminderEnabled || status.permission !== 'granted';
  if ($('#connectionGroup')) $('#connectionGroup').hidden = status.pushActive || status.canReconnect;
}
function checkContent(status) {
  return status === 'done' ? icon('check') : status === 'missed' ? icon('cross') : status === 'rest' ? icon('minus') : '';
}
function itemRow(item,date,habit = false) {
  const subtitle = item.removed ? 'Удалено · сохранено в плане дня' : item.status === 'done' ? 'Выполнено' : item.status === 'rest' ? 'Выходной' : item.status === 'missed' ? 'Не выполнено' : habit ? 'Отметь действие' : date === today ? 'На сегодня' : 'На завтра';
  return `<div class="swipe-row ${item.status}" data-row="${esc(item.id)}" data-date="${date}">
    <div class="swipe-background" aria-hidden="true"><span class="complete-side">${icon('check')} Выполнено</span><span class="delete-side">Удалить ${icon('trash')}</span></div>
    <div class="item ${item.status}"><button class="check" data-toggle="${esc(item.id)}" data-date="${date}" aria-label="${item.status === 'done' ? 'Убрать отметку' : 'Выполнить'}: ${esc(item.title)}" aria-pressed="${item.status === 'done'}">${checkContent(item.status)}</button><div class="row-copy"><div class="name"><span class="title-text">${habit ? 'Сегодня' : esc(item.title)}</span></div><div class="row-subtitle">${!habit ? icon('today') : ''}${subtitle}</div></div><button class="dots" data-item="${esc(item.id)}" data-date="${date}" aria-label="Действия: ${esc(item.title)}">${icon('dots')}</button></div>
  </div>`;
}
function emblemMarkup(value) {
  const assets={'📖':'emoji-reading.svg','🏃':'emoji-run.svg','💪':'emoji-workout.svg','🎯':'emoji-goal.svg','💼':'emoji-work.svg','☀️':'emoji-sun.svg','🔥':'fire.svg','🧊':'ice.svg'};
  return assets[value]?`<img class="emblem-image" src="${assets[value]}" alt="">`:esc(value);
}
function pageHead(title,subtitle,eyebrow = '') {
  return `<div class="page-head">${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}<h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>`;
}
function dayProgress(date) {
  const day = E.ensure(state,date), required = day.items.filter(item => item.status !== 'rest');
  const done = required.filter(item => item.status === 'done').length;
  return {day,required,done,percent:required.length ? Math.round(done / required.length * 100) : 0};
}
function todayView() {
  const date = plan === 'today' ? today : E.next(today);
  const {day,required,done,percent} = dayProgress(date);
  const tasks = day.items.filter(item => !item.habit);
  const active = tasks.filter(item => item.status !== 'done' && !item.removed);
  const complete = tasks.filter(item => item.status === 'done' && !item.removed);
  const removed = tasks.filter(item => item.removed);
  const habits = day.items.filter(item => item.habit && !item.removed);
  const habitLeft = habits.filter(item => !['done','rest'].includes(item.status)).length;
  let html = pageHead(dateLabel(date),new Date(date+'T12:00:00').toLocaleDateString('ru',{weekday:'long'}),plan === 'today' ? 'Сегодня' : 'Завтра');
  html += `<div class="stats"><div class="card stat-card"><span class="stat-symbol" aria-hidden="true"><img src="fire.svg" alt=""></span><div class="stat-copy"><div class="stat-value" id="streakValue">${stats.streak}</div><div class="label">серия дней</div></div></div><div class="card stat-card stat-ice"><span class="stat-symbol" aria-hidden="true"><img src="ice.svg" alt=""></span><div class="stat-copy"><div class="stat-value"><span id="iceValue">${stats.ice}</span><small>/2</small></div><div class="label">заморозки</div></div></div></div>`;
  html += `<div class="segments"><button id="todayBtn" class="${plan === 'today' ? 'selected' : ''}" aria-pressed="${plan === 'today'}">Сегодня</button><button id="tomorrowBtn" class="${plan === 'tomorrow' ? 'selected' : ''}" aria-pressed="${plan === 'tomorrow'}">Завтра</button></div>`;
  html += `<div class="card progress-card"><div class="progress-top"><span class="progress-title">План дня</span><span class="progress-count"><span id="doneCount">${done}</span> <small>/ <span id="requiredCount">${required.length}</span></small></span></div><div class="progress-track" role="progressbar" aria-label="Выполнение плана" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="progress-fill" style="width:${percent}%"></div></div><div class="progress-caption"><span id="progressCaption">${day.outcome === 'ideal' ? 'Идеальный день. Всё выполнено.' : required.length ? 'Задачи + запланированные привычки' : 'Добавь первый пункт'}</span><span class="progress-percent">${percent}%</span></div></div>`;
  html += `<div class="section"><div class="section-heading">${icon('today')}<h2>Задачи</h2></div><button id="addTask">${icon('plus')} Добавить</button></div><div class="task-list">${active.map(item => itemRow(item,date)).join('')}</div>`;
  if (!active.length && !complete.length) html += '<div class="empty"><div class="empty-icon">'+icon('today')+'</div>Добавь задачу на этот день</div>';
  if (!active.length && complete.length) html += '<div class="empty">'+icon('check')+' Все задачи выполнены</div>';
  if (complete.length) html += `<details class="task-group" id="doneGroup" ${doneOpen ? 'open' : ''}><summary><span>Выполнено</span><span>${complete.length} ${icon('down')}</span></summary><div>${complete.map(item => itemRow(item,date)).join('')}</div></details>`;
  if (removed.length) html += `<details class="task-group" id="removedGroup" ${removedOpen ? 'open' : ''}><summary><span>Удалённые</span><span>${removed.length} ${icon('down')}</span></summary><div>${removed.map(item => itemRow(item,date)).join('')}</div></details>`;
  html += `<button id="openHabits" class="habit-link"><span class="habit-link-left">${icon('habits')} Привычки</span><span class="habit-link-right">${habitLeft ? 'Осталось '+habitLeft : habits.length ? 'Всё отмечено' : 'Настроить'} ${icon('chevron')}</span></button>`;
  return html;
}
function habitStreak(habit) {
  let series = 0;
  for (let date = today; date >= habit.start; date = E.next(date,-1)) {
    const item = state.days[date]?.items.find(item => item.habit === habit.id);
    if (!item || item.status === 'rest') continue;
    if (item.status === 'done') series++; else if (date !== today) break;
  }
  return series;
}
function habitsView() {
  const habits = state.habits.filter(habit => (!habit.end || habit.end > today) && !state.days[today]?.items.some(item => item.habit === habit.id && item.removed));
  let html = pageHead('Привычки','Твой ритм, день за днём');
  html += `<div class="section"><span class="label">${habits.length ? 'Привычек: '+habits.length : 'Начни с одного действия'}</span><button id="addHabit">${icon('plus')} Добавить</button></div>`;
  for (const habit of habits) {
    const series = habitStreak(habit);
    const current = state.days[today]?.items.find(item => item.habit === habit.id);
    html += `<div class="card habit-card" style="--habit-color:${safeColor(habit.color)}"><div class="habit-head"><span class="habit-emblem">${emblemMarkup(habit.icon || '📖')}</span><div class="habit-identity"><h2>${esc(habit.title)}</h2><div class="label">${emblemMarkup('🔥')} ${series} ${plural(series)}${habit.end ? ' · изменения с завтра' : ''}</div></div><button class="dots" data-edit-habit="${esc(habit.id)}" aria-label="Изменить привычку: ${esc(habit.title)}">${icon('dots')}</button></div><div class="habit-today">${current ? itemRow(current,today,true) : '<div class="label">Сегодня не запланировано</div>'}</div>`;
    html += '<div class="calendar-caption"><span>Последние 28 дней</span><span>Белая рамка — сегодня</span></div><div class="calendar-weekdays" aria-hidden="true">'+['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map(day=>'<span>'+day+'</span>').join('')+'</div><div class="calendar">';
    const start = E.next(today,-27), padding = (new Date(start+'T12:00:00').getDay()+6)%7;
    html += '<span></span>'.repeat(padding);
    for (let number = 27; number >= 0; number--) {
      const date = E.next(today,-number), item = state.days[date]?.items.find(item => item.habit === habit.id);
      html += `<button class="${item?.status || ''} ${date === today ? 'today' : ''}" ${item ? `data-item="${esc(item.id)}" data-date="${date}"` : 'disabled'} aria-label="${dateLabel(date)}: ${item?.status === 'done' ? 'выполнено' : item?.status === 'missed' ? 'не выполнено' : item?.status === 'rest' ? 'выходной' : 'нет отметки'}">${new Date(date+'T12:00:00').getDate()}</button>`;
    }
    html += '</div></div>';
  }
  if (!habits.length) html += '<div class="empty"><div class="empty-icon">'+icon('habits')+'</div>Создай привычку и выбери дни недели</div>';
  return html;
}
function historyView() {
  const outcomes = {ideal:['🔥','Идеальный день'],frozen:['🧊','Использована заморозка'],broken:['','Серия прервана'],neutral:['','Без обязательных действий'],open:['','День продолжается']};
  let html = pageHead('История','Каждый день оставляет след')+'<div class="history-list">';
  for (const date of Object.keys(state.days).filter(date => date <= today).sort().reverse()) {
    const day = state.days[date], outcome = outcomes[day.outcome] || outcomes.open;
    html += `<details class="card history-card"><summary><span><span class="history-date">${dateLabel(date)}</span><span class="outcome ${day.outcome}">${emblemMarkup(outcome[0])} ${outcome[1]}</span></span>${icon('down')}</summary><div class="history-items">`;
    for (const item of day.items) html += `<div class="history-item ${item.status}">${icon(item.status === 'done' ? 'check' : item.status === 'rest' ? 'rest' : date < today || item.status === 'missed' ? 'cross' : 'circle')}<span>${esc(item.title)}${item.removed ? '<span class="label"> · удалено</span>' : ''}</span></div>`;
    if (!day.items.length) html += '<div class="label">Нет запланированных действий</div>';
    html += '</div></details>';
  }
  return html+'</div>';
}
function analyticsView() {
  const all = Object.entries(state.days).filter(([date]) => date <= today).flatMap(([date,day]) => day.items.map(item => ({...item,date})));
  const percent = days => {
    const items = all.filter(item => item.date >= E.next(today,1-days) && item.status !== 'rest');
    return items.length ? Math.round(items.filter(item => item.status === 'done').length / items.length * 100) : 0;
  };
  const values = [[stats.streak,'Текущая серия','today',true],[stats.record,'Рекорд серии','trophy'],[stats.ice+'/2','Заморозки','ice'],[stats.ideal,'Идеальные дни','check'],[percent(7)+'%','За 7 дней','analytics',true],[percent(30)+'%','За 30 дней','analytics'],[all.filter(item => !item.habit && item.status === 'done').length,'Выполнено задач','check'],[all.filter(item => !item.habit && (item.status === 'missed' || item.date < today && item.status === 'pending')).length,'Пропущено задач','cross']];
  let html = pageHead('Аналитика','Прогресс в цифрах')+'<div class="metrics">';
  for (const [value,label,symbol,highlight] of values) html += `<div class="card metric-card ${highlight ? 'highlight' : ''}">${icon(symbol,'metric-icon')}<div class="metric-value">${value}</div><div class="label">${label}</div></div>`;
  html += '</div><h2>Привычки</h2>';
  for (const habit of state.habits) {
    const items = all.filter(item => item.habit === habit.id && item.status !== 'rest');
    html += `<div class="card habit-stat"><span>${emblemMarkup(habit.icon)} ${esc(habit.title)}</span><span class="label">${items.filter(item => item.status === 'done').length} / ${items.length}</span></div>`;
  }
  html += `<button id="restore" class="restore-button">${icon('undo')} Восстановить резервную копию</button><input id="import" type="file" accept="application/json,.json" hidden>`;
  return html;
}
function render() {
  const previousRows=new Set([...document.querySelectorAll('#app [data-row]')].map(element=>element.dataset.row));
  const previousHabits=new Set([...document.querySelectorAll('#app [data-edit-habit]')].map(element=>element.dataset.editHabit));
  $('#app').innerHTML = ({'Сегодня':todayView,'Привычки':habitsView,'История':historyView,'Аналитика':analyticsView})[tab]();
  const view = tab+'-'+plan;
  if (view !== lastView) {
    $('#app').classList.remove('view-enter');
    $('#app').dataset.direction = viewDirection === 'back' ? 'back' : 'forward';
    void $('#app').offsetWidth;
    $('#app').classList.add('view-enter');
    [...document.querySelectorAll('#app>.card,#app>.stats>.card,#app>.habit-card,#app>.task-list>.swipe-row,#app>.metrics>.card,#app>.history-list>.card')].forEach((element,index) => {
      element.classList.add('card-enter');
      element.style.setProperty('--entry-delay',Math.min(index*45,225)+'ms');
    });
    lastView = view;
  } else {
    [...document.querySelectorAll('.task-list>.swipe-row')].filter(element=>!previousRows.has(element.dataset.row)).forEach((element,index)=>{element.classList.add('card-enter');element.style.setProperty('--entry-delay',Math.min(index*45,180)+'ms');});
    [...document.querySelectorAll('.habit-card')].filter(element=>!previousHabits.has(element.querySelector('[data-edit-habit]').dataset.editHabit)).forEach(element=>element.classList.add('card-enter'));
  }
  $('#nav').innerHTML = tabs.map((name,index)=>`<button class="${tab === name ? 'active' : ''}" data-tab="${name}" ${tab === name ? 'aria-current="page"' : ''}>${icon(['today','habits','history','analytics'][index])}<span>${name}</span></button>`).join('');
  document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => switchTab(button.dataset.tab));
  $('#openHabits')?.addEventListener('click',()=>switchTab('Привычки'));
  $('#addTask')?.addEventListener('click',()=>taskForm());
  $('#addHabit')?.addEventListener('click',()=>habitForm());
  $('#todayBtn')?.addEventListener('click',()=>switchPlan('today'));
  $('#tomorrowBtn')?.addEventListener('click',()=>switchPlan('tomorrow'));
  document.querySelectorAll('[data-toggle]').forEach(button => button.onclick = () => {
    const item = findItem(button.dataset.date,button.dataset.toggle);
    if (item) setStatus(button.dataset.date,item.id,item.status === 'done' ? 'pending' : 'done');
  });
  document.querySelectorAll('[data-item]').forEach(button => button.onclick = () => itemMenu(button.dataset.date,button.dataset.item));
  document.querySelectorAll('[data-edit-habit]').forEach(button => button.onclick = () => habitForm(state.habits.find(habit => habit.id === button.dataset.editHabit)));
  $('#doneGroup')?.addEventListener('toggle',event=>{doneOpen = event.target.open;});
  $('#removedGroup')?.addEventListener('toggle',event=>{removedOpen = event.target.open;});
  document.querySelectorAll('.history-card').forEach(details => details.addEventListener('toggle',()=>{
    if (details.open && !reducedMotion()) details.querySelector('.history-items').animate([{opacity:0,transform:'translateY(-5px)'},{opacity:1,transform:'none'}],{duration:230,easing:'ease-out'});
  }));
  $('#restore')?.addEventListener('click',()=>$('#import').click());
  $('#import')?.addEventListener('change',importBackup);
  installSwipes();
}
function switchTab(next) {
  if (interacting || busy) {pendingNavigation = {tab:next};return;}
  if (tab === next) return;
  viewDirection = tabs.indexOf(next) < tabs.indexOf(tab) ? 'back' : 'forward';
  tab = next;
  render();
  window.scrollTo({top:0,behavior:'instant'});
}
function switchPlan(next) {
  if (interacting || busy) {pendingNavigation = {plan:next};return;}
  if (plan === next) return;
  viewDirection = next === 'today' ? 'back' : 'forward';
  plan = next;
  render();
}
function flushNavigation() {
  if (busy || interacting || !pendingNavigation) return;
  const navigation=pendingNavigation;pendingNavigation=null;
  if(navigation.tab) switchTab(navigation.tab);else switchPlan(navigation.plan);
}
function paintProgress() {
  const date = plan === 'today' ? today : E.next(today), progress = dayProgress(date);
  if ($('#streakValue')) $('#streakValue').textContent = stats.streak;
  if ($('#iceValue')) $('#iceValue').textContent = stats.ice;
  if ($('#doneCount')) $('#doneCount').textContent = progress.done;
  const track = $('.progress-track');
  if (track) {
    track.setAttribute('aria-valuenow',progress.percent);
    $('.progress-fill').style.width = progress.percent+'%';
    $('.progress-percent').textContent = progress.percent+'%';
    $('#progressCaption').textContent = progress.day.outcome === 'ideal' ? 'Идеальный день. Всё выполнено.' : 'Задачи + запланированные привычки';
  }
}
async function setStatus(date,id,status) {
  if (date !== today) return toast('Отмечать можно в день выполнения');
  if (busy || interacting) return;
  const item = findItem(date,id);
  if (!item || item.status === status) return;
  interacting = true;
  const row = rowElement(id);
  row?.classList.add('anticipating');
  await delay(130);
  const result = await commit(()=>{item.status = status;},{render:false,reward:false});
  if (result.ok) {
    if (status === 'done') { Feedback.play(item.habit ? 'habit' : 'task'); haptic(10); }
    else if (status === 'missed') { Feedback.play('missed'); haptic(5); }
    if (row) {
      row.classList.remove('anticipating','pending','done','missed','rest');
      row.classList.add(status,status === 'done' ? 'completing' : status === 'missed' ? 'flash-missed' : 'resetting');
      const content = row.querySelector('.item');
      content.classList.remove('pending','done','missed','rest');
      content.classList.add(status);
      row.querySelector('.check').innerHTML = checkContent(status);
      row.querySelector('.check').setAttribute('aria-pressed',status === 'done');
      row.querySelector('.row-subtitle').textContent = status === 'done' ? 'Выполнено' : status === 'missed' ? 'Не выполнено' : status === 'rest' ? 'Выходной' : 'Не отмечено';
    }
    const cell = [...document.querySelectorAll('.calendar [data-item]')].find(button=>button.dataset.item === id);
    if (cell) { cell.classList.remove('pending','done','missed','rest'); cell.classList.add(status,status === 'done' ? 'flash-done' : 'flash-missed'); }
    paintProgress();
    await delay(420);
    if (row && !item.habit && status === 'done' && !item.removed) { row.classList.add('leaving'); await delay(220); }
    render();
    presentReward(result);
  }
  interacting = false;
  flushNavigation();
}
async function deleteTask(date,id) {
  if (busy || interacting || date < today) return;
  const item = findItem(date,id);
  if (!item) return;
  interacting = true;
  const previous = structuredClone(item), row = rowElement(id);
  const result = await commit(()=>{
    if (date === today) { item.removed = true; if (item.status !== 'done') item.status = 'missed'; }
    else state.days[date].items = state.days[date].items.filter(item=>item.id !== id);
  },{render:false,reward:false});
  if (result.ok) {
    haptic(7);
    row?.classList.add('leaving-delete');
    await delay(220);
    render();
    toast(date === today ? 'Удалено · осталось в истории' : 'Задача удалена',async()=>{
      if (date < today) return toast('Этот день уже завершён');
      await commit(()=>{
        const existing = findItem(date,id);
        if (existing) Object.assign(existing,previous,{removed:Boolean(previous.removed)}); else E.ensure(state,date).items.push(previous);
      });
    });
  }
  interacting = false;
  flushNavigation();
}
function installSwipes() {
  document.querySelectorAll('.swipe-row').forEach(row=>{
    let gesture;
    const content = row.querySelector('.item');
    const reset = () => {
      content.style.transform = '';
      content.style.transition = '';
      row.classList.remove('swiping-left','swiping-right');
      gesture = null;
    };
    row.addEventListener('pointerdown',event=>{
      if (busy || interacting || !event.isPrimary || event.button !== 0 || event.target.closest('button')) return;
      gesture = {id:event.pointerId,x:event.clientX,y:event.clientY,locked:false,dx:0};
    });
    row.addEventListener('pointermove',event=>{
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = event.clientX-gesture.x, dy = event.clientY-gesture.y;
      if (!gesture.locked) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { gesture = null; return; }
        if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy)*1.3) return;
        gesture.locked = true;
        row.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      gesture.dx = Math.max(-155,Math.min(155,dx));
      content.style.transition = 'none';
      content.style.transform = `translateX(${gesture.dx}px)`;
      row.classList.toggle('swiping-right',dx > 0);
      row.classList.toggle('swiping-left',dx < 0);
    });
    row.addEventListener('pointerup',event=>{
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = gesture.dx, locked = gesture.locked;
      if (row.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
      if (locked) blockClicksUntil = performance.now()+350;
      reset();
      if (!locked || Math.abs(dx) < 76) return;
      const date = row.dataset.date, id = row.dataset.row, item = findItem(date,id);
      if (!item) return;
      if ((dx > 0 && date === today && item.status !== 'done') || (dx < 0 && date >= today)) {
        Feedback.play('swipe'); haptic(6);
      }
      if (dx > 0) setStatus(date,id,'done');
      else if (!item.habit) deleteTask(date,id);
      else confirmDeleteHabit(state.habits.find(habit=>habit.id === item.habit));
    });
    row.addEventListener('pointercancel',reset);
  });
}
function taskForm(item,date) {
  if (busy || interacting) return;
  modal(item ? 'Изменить задачу' : 'Новая задача',`<label for="title">Название</label><input id="title" required maxlength="160" value="${esc(item?.title)}" placeholder="Например, сделать ролик" autocomplete="off"><label for="when">Когда</label><select id="when"><option value="${today}">Сегодня</option><option value="${E.next(today)}">Завтра</option></select><button class="primary-button" type="submit">Сохранить</button>`,async()=>{
    const title = $('#title').value.trim(), target = $('#when').value;
    if (!title || ![today,E.next(today)].includes(target)) return;
    closeSheet();
    await commit(()=>{
      if (item && target === date) item.title = title;
      else {
        if (item && date === today) { item.status = 'missed'; item.moved = true; }
        else if (item) state.days[date].items = state.days[date].items.filter(existing=>existing.id !== item.id);
        E.ensure(state,target).items.push({id:uid(),title,status:'pending'});
      }
    });
  });
  $('#when').value = date || (plan === 'tomorrow' ? E.next(today) : today);
}
function habitForm(habit) {
  if (busy || interacting) return;
  let week = habit ? [...habit.week] : [0,1,2,3,4,5,6];
  let color = safeColor(habit?.color), emblem = habit?.icon || '📖';
  const swatches = colors.includes(color) ? colors : [...colors.slice(0,5),color];
  modal(habit ? 'Изменить привычку' : 'Новая привычка',`<label for="title">Название</label><input id="title" required maxlength="160" value="${esc(habit?.title)}" placeholder="Например, чтение" autocomplete="off"><span class="field-label">Иконка</span><div class="icon-picker">${['📖','🏃','💪','🎯','💼','☀️'].map(value=>`<button type="button" data-emblem="${value}" class="${emblem === value ? 'selected' : ''}" aria-label="Иконка ${value}" aria-pressed="${emblem === value}">${emblemMarkup(value)}</button>`).join('')}</div><details class="custom-icon-field" ${['📖','🏃','💪','🎯','💼','☀️'].includes(emblem)?'':'open'}><summary>Другая иконка ${icon('down')}</summary><input id="customIcon" value="${esc(emblem)}" maxlength="8" aria-label="Своя иконка привычки"></details><span class="field-label">Цвет</span><div class="palette">${swatches.map((value,index)=>`<button type="button" class="swatch ${color === value ? 'chosen' : ''}" data-color="${value}" style="--swatch:${value}" aria-label="${colors.includes(value) ? colorNames[colors.indexOf(value)] : 'Текущий цвет'}" aria-pressed="${color === value}">${color === value ? icon('check') : ''}</button>`).join('')}</div><span class="field-label">Дни недели</span><div class="week">${[1,2,3,4,5,6,0].map((day,index)=>`<button type="button" data-week="${day}" class="${week.includes(day) ? 'selected' : ''}" aria-pressed="${week.includes(day)}">${['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'][index]}</button>`).join('')}</div>${habit ? '<div class="helper">Изменения начнут действовать завтра. Сегодняшний план сохранится.</div>' : ''}<button class="primary-button" type="submit">Сохранить</button>${habit ? `<button id="deleteHabit" class="danger delete-habit" type="button">${icon('trash')} Удалить привычку</button>` : ''}`,async()=>{
    const title = $('#title').value.trim(), customIcon = $('#customIcon').value.trim() || '📖';
    if (!title || !week.length) return toast('Выбери название и хотя бы один день');
    closeSheet();
    await commit(()=>{
      if (habit) {
        habit.end = E.next(today);
        for (const [date,day] of Object.entries(state.days)) if (date > today) day.items = day.items.filter(item=>item.habit !== habit.id);
      }
      state.habits.push({id:uid(),title,icon:customIcon,color,week,start:habit ? E.next(today) : today});
      for (const date of Object.keys(state.days)) E.ensure(state,date);
    });
    if (habit) toast('Изменения сохранены на завтра');
  });
  document.querySelectorAll('[data-color]').forEach(button=>button.onclick=()=>{
    color = button.dataset.color;
    document.querySelectorAll('[data-color]').forEach(other=>{
      const selected = other === button;
      other.classList.toggle('chosen',selected);
      other.setAttribute('aria-pressed',selected);
      other.innerHTML = selected ? icon('check') : '';
    });
  });
  document.querySelectorAll('[data-emblem]').forEach(button=>button.onclick=()=>{
    $('#customIcon').value = button.dataset.emblem;
    document.querySelectorAll('[data-emblem]').forEach(other=>{ other.classList.toggle('selected',other === button); other.setAttribute('aria-pressed',other === button); });
  });
  document.querySelectorAll('[data-week]').forEach(button=>button.onclick=()=>{
    const day = Number(button.dataset.week);
    week = week.includes(day) ? week.filter(value=>value !== day) : [...week,day];
    button.classList.toggle('selected',week.includes(day));
    button.setAttribute('aria-pressed',week.includes(day));
  });
  $('#deleteHabit')?.addEventListener('click',()=>confirmDeleteHabit(habit));
}
function confirmDeleteHabit(habit) {
  if (!habit || busy || interacting) return;
  modal('Удалить привычку?',`<p>${esc(habit.title)} сразу исчезнет из списка привычек. Сегодняшняя отметка останется в истории и учёте серии.</p><button id="confirmDelete" class="danger restore-button" type="button">${icon('trash')} Удалить</button><button id="keepHabit" class="primary-button" type="button">Оставить</button>`);
  $('#keepHabit').onclick = () => closeSheet();
  $('#confirmDelete').onclick = async()=>{
    const end = habit.end, future = Object.fromEntries(Object.entries(state.days).filter(([date])=>date > today).map(([date,day])=>[date,structuredClone(day.items.filter(item=>item.habit === habit.id))]));
    closeSheet();
    const result = await commit(()=>{
      habit.end = today;
      for (const [date,day] of Object.entries(state.days)) {
        if (date > today) day.items = day.items.filter(item=>item.habit !== habit.id);
        if (date === today) day.items.filter(item=>item.habit === habit.id).forEach(item=>item.removed = true);
      }
    });
    if (!result.ok) return;
    toast('Привычка удалена',async()=>{
      await commit(()=>{
        const current = state.habits.find(current=>current.id === habit.id);
        if (!current) return;
        current.end = end;
        state.days[today].items.filter(item=>item.habit === habit.id).forEach(item=>item.removed = false);
        for (const [date,items] of Object.entries(future)) {
          const day = E.ensure(state,date);
          for (const item of items) {
            const index = day.items.findIndex(current=>current.id === item.id);
            if (index < 0) day.items.push(item); else day.items[index] = item;
          }
        }
      });
    });
  };
}
function itemMenu(date,id) {
  if (busy || interacting) return;
  const item = findItem(date,id);
  if (!item) return;
  if (date < today) return modal(item.title,`<p>${item.status === 'done' ? 'Выполнено.' : item.status === 'rest' ? 'Выходной.' : 'Не выполнено.'} История завершённого дня сохранена.</p>`);
  const actions = [];
  if (date === today) {
    actions.push(`<button type="button" class="positive" data-status="done">${icon('check')} Выполнил</button><button type="button" class="negative" data-status="missed">${icon('cross')} Не выполнил</button>`);
    if (item.habit) actions.push(`<button type="button" data-status="rest">${icon('rest')} Выходной</button>`);
    actions.push(`<button type="button" data-status="pending">${icon('undo')} Убрать отметку</button>`);
  }
  if (!item.habit) {
    if (actions.length) actions.push('<div class="action-divider"></div>');
    if (item.removed) actions.push(`<button id="restoreTask" type="button">${icon('undo')} Вернуть задачу</button>`);
    else actions.push(`<button id="editTask" type="button">${icon('edit')} Изменить</button>${date === today && !item.moved ? `<button id="move" type="button">${icon('move')} Перенести на завтра</button>` : ''}<button id="deleteTask" class="danger" type="button">${icon('trash')} Удалить</button>`);
  }
  modal(item.title,'<div class="action-list">'+actions.join('')+'</div>');
  document.querySelectorAll('[data-status]').forEach(button=>button.onclick=async()=>{
    document.querySelectorAll('[data-status]').forEach(other=>other.disabled = true);
    button.classList.add('status-anticipation');
    const status = button.dataset.status;
    closeSheet();
    await setStatus(date,id,status);
  });
  $('#editTask')?.addEventListener('click',()=>taskForm(item,date));
  $('#deleteTask')?.addEventListener('click',async()=>{closeSheet();await deleteTask(date,id);});
  $('#restoreTask')?.addEventListener('click',async()=>{closeSheet();await commit(()=>{item.removed=false;item.status='pending';});});
  $('#move')?.addEventListener('click',async()=>{
    closeSheet();
    await commit(()=>{item.status='missed';item.moved=true;E.ensure(state,E.next(today)).items.push({id:uid(),title:item.title,status:'pending'});});
    toast('Создана копия на завтра');
  });
}
function presentReward(result) {
  if (!result.ok || document.hidden) return;
  if (result.celebrate) {
    closeSheet(true);
    $('#rewardTitle').textContent = 'Серия — '+stats.streak+' '+plural(stats.streak);
    $('#rewardBonus').hidden = !result.iceEarned;
    $('#rewardBonus').innerHTML = emblemMarkup('🧊')+' +1 заморозка';
    $('#reward').showModal();
    Feedback.reward();
    startConfetti();
  } else if (result.iceEarned) toast('🧊 +1 заморозка');
}
function startConfetti() {
  cancelAnimationFrame(confettiFrame);
  const canvas = $('#confetti'), context = canvas.getContext('2d');
  if (!context || reducedMotion()) return;
  const width = innerWidth, height = innerHeight, ratio = Math.min(devicePixelRatio || 1,2);
  canvas.width = width*ratio; canvas.height = height*ratio;
  context.scale(ratio,ratio);
  const palette = ['#a8ff35','#e6ffd3','#7bac3d','#e8f8d9','#86ccff'];
  const particles = Array.from({length:104},(_,index)=>({x:index%2 ? width*.25 : width*.75,y:height*.38,vx:(Math.random()-.5)*12,vy:-3-Math.random()*9,size:3+Math.random()*4,rotation:Math.random()*6,spin:(Math.random()-.5)*.2,color:palette[index%palette.length]}));
  const start = performance.now(); let previous = start;
  function draw(now) {
    const time = now-start, step = Math.min((now-previous)/16.67,2); previous = now;
    context.clearRect(0,0,width,height);
    for (const particle of particles) {
      particle.vy += .12*step; particle.x += particle.vx*step; particle.y += particle.vy*step; particle.rotation += particle.spin*step;
      context.save(); context.globalAlpha = Math.max(0,1-time/2700); context.translate(particle.x,particle.y); context.rotate(particle.rotation); context.fillStyle = particle.color; context.fillRect(-particle.size/2,-particle.size,particle.size,particle.size*1.8); context.restore();
    }
    if (time < 2700 && $('#reward').open) confettiFrame = requestAnimationFrame(draw); else context.clearRect(0,0,width,height);
  }
  confettiFrame = requestAnimationFrame(draw);
}
async function importBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const candidate = JSON.parse(await file.text());
    const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && E.key(new Date(value+'T12:00:00')) === value;
    if (candidate.version !== 1 || !validDate(candidate.start) || candidate.start > today || candidate.start < E.next(today,-36500) || !candidate.days || Array.isArray(candidate.days) || !Array.isArray(candidate.habits)) throw Error('format');
    for (const [date,day] of Object.entries(candidate.days)) {
      if (!validDate(date) || !Array.isArray(day.items) || day.items.some(item=>typeof item.id !== 'string' || typeof item.title !== 'string' || !['pending','done','missed','rest'].includes(item.status))) throw Error('day');
    }
    for (const habit of candidate.habits) if (typeof habit.id !== 'string' || typeof habit.title !== 'string' || !validDate(habit.start) || !Array.isArray(habit.week) || habit.week.some(day=>!Number.isInteger(day) || day < 0 || day > 6) || (habit.end && !validDate(habit.end))) throw Error('habit');
    modal('Восстановить копию?','<p>Текущие задачи, привычки и история будут заменены данными из файла.</p><button id="confirmImport" class="primary-button" type="button">Восстановить</button>');
    $('#confirmImport').onclick = async()=>{ closeSheet(); const result=await commit(()=>{state=candidate;normalizeSettings();E.ensure(state,today);},{reward:false});if(result.ok)toast('Копия восстановлена'); };
  } catch (error) { toast('Не удалось прочитать резервную копию'); }
}
async function rollover() {
  const localDate = E.key(new Date());
  if (localDate !== today && !busy && !interacting) {
    today = localDate;
    closeSheet(true);
    await commit(()=>E.ensure(state,today),{reward:false});
  }
}
function openHabitNotification() {
  closeSheet(true);
  if ($('#reward').open) $('#reward').close();
  switchTab('Привычки');
}
$('#backup').innerHTML = icon('download')+'<span>Копия</span>';
$('#settings').innerHTML = icon('settings');
$('#settings').onclick = () => { if (state && !busy && !interacting) settingsForm(); };
$('#backup').onclick = () => {
  if (!state) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));
  const anchor = document.createElement('a');
  anchor.href=url;anchor.download='ritm-backup-'+today+'.json';anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('.brand').onclick = event => { event.preventDefault(); if (state) {plan='today';switchTab('Сегодня');if(tab==='Сегодня')render();} };
$('#sheet').addEventListener('cancel',event=>{event.preventDefault();closeSheet();});
$('#sheet').addEventListener('click',event=>{
  if (event.target !== $('#sheet')) return;
  const rect = $('#sheet').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeSheet();
});
$('#rewardClose').onclick = () => $('#reward').close();
$('#reward').addEventListener('close',()=>{cancelAnimationFrame(confettiFrame);const canvas=$('#confetti');canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);});
document.addEventListener('click',event=>{if(performance.now()<blockClicksUntil && event.target.closest('.swipe-row')){event.preventDefault();event.stopImmediatePropagation();}},true);
document.addEventListener('pointerdown',event=>{
  const button=event.target.closest('button');
  if (!button || button.disabled || button.classList.contains('check') || reducedMotion()) return;
  const bounds=button.getBoundingClientRect(), ripple=document.createElement('span');
  ripple.className='ripple';ripple.style.left=(event.clientX-bounds.left-6)+'px';ripple.style.top=(event.clientY-bounds.top-6)+'px';button.append(ripple);setTimeout(()=>ripple.remove(),600);
});
(async()=>{
  try {
    db=await new Promise((resolve,reject)=>{const request=indexedDB.open('ritm-planner',1);request.onupgradeneeded=()=>request.result.createObjectStore('data');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    state=await new Promise((resolve,reject)=>{const request=db.transaction('data').objectStore('data').get('state');request.onsuccess=()=>resolve(request.result || E.fresh(today));request.onerror=()=>reject(request.error);});
    normalizeSettings();
    Feedback.init(() => state.settings);
    E.ensure(state,today);stats=E.calculate(state,today);await save();render();
    if (location.hash === '#habits') openHabitNotification();
    window.addEventListener('hashchange',()=>{if(location.hash === '#habits') openHabitNotification();});
    setInterval(rollover,15000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)rollover();});
    window.addEventListener('focus',rollover);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(() => {
      Reminders.init({db, getState:() => state,
        persistSettings:patch => commit(()=>Object.assign(state.settings,patch),{reward:false}),
        announce:message => toast(message), changed:updateSettingsStatus,
        openHabits:openHabitNotification
      }).catch(Reminders.failed);
    }).catch(()=>{Reminders.failed();updateSettingsStatus();});
  } catch (error) {
    $('#app').innerHTML=pageHead('Не удалось открыть хранилище','Открой сайт в обычной вкладке Chrome и разреши сохранение данных.');
  }
})();
