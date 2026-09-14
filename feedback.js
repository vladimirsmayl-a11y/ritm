'use strict';
// Replace any sound-*.wav with your own file, or change this map to .mp3.
window.RitmFeedback = (() => {
  const files = {
    streak:'sound-streak.wav', task:'sound-task.wav', missed:'sound-missed.wav',
    habit:'sound-habit.wav', complete:'sound-complete.wav', swipe:'sound-swipe.wav'
  };
  const volume = 0.30;
  let settings = () => ({}), context, gain, loading, revision = 0;
  const buffers = new Map(), sources = new Set(), timers = new Set();
  const allowed = () => settings().feedbackEnabled !== false && !document.hidden;
  function stop() {
    revision++;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const source of sources) { try { source.stop(); } catch (_) {} }
    sources.clear();
    if (context?.state === 'running') context.suspend().catch(() => {});
    if (typeof navigator.vibrate === 'function') navigator.vibrate(0);
  }
  async function preload() {
    if (!context || loading) return loading;
    loading = Promise.allSettled(Object.entries(files).map(async ([name, file]) => {
      const response = await fetch(file);
      if (!response.ok) throw Error('Sound unavailable');
      buffers.set(name, await context.decodeAudioData(await response.arrayBuffer()));
    })).then(() => { loading = null; });
    return loading;
  }
  function prepare() {
    try {
      if (!context) {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!Audio) return;
        context = new Audio();
        gain = context.createGain();
        gain.gain.value = volume;
        gain.connect(context.destination);
      }
      if (buffers.size < Object.keys(files).length) preload();
    } catch (_) { /* Audio is optional; every action still works. */ }
  }
  function unlock() {
    if (!allowed()) return;
    prepare();
    if (context?.state === 'suspended') context.resume().catch(() => {});
  }
  function play(name) {
    if (!allowed() || !context || context.state !== 'running') return;
    const buffer = buffers.get(name);
    if (!buffer) return; // Never replay a late download after the action.
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      sources.add(source);
      source.onended = () => { sources.delete(source); source.disconnect(); };
      source.start();
    } catch (_) {}
  }
  function vibrate(pattern) {
    if (allowed() && !matchMedia('(prefers-reduced-motion: reduce)').matches && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  }
  function reward() {
    if (!allowed()) return;
    play('streak');
    vibrate([10, 65, 10]);
    const token = revision;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (token === revision && allowed()) play('complete');
    }, 430);
    timers.add(timer);
  }
  function init(getSettings) {
    settings = getSettings;
    // Decode quietly in advance. Playback is unlocked by an actual user gesture.
    if (allowed()) prepare();
    document.addEventListener('pointerdown', unlock, {capture:true, passive:true});
    document.addEventListener('keydown', unlock, {capture:true});
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    window.addEventListener('pagehide', stop);
  }
  return {init, play, vibrate, reward, stop, unlock, changed:() => { if (!allowed()) stop(); }};
})();
