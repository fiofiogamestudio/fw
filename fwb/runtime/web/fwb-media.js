(function () {
  'use strict';
  let active = null;
  let nextId = 0;
  const minimumFraction = 0.000001;

  function notify(session, status, detail = {}) {
    try { session.callback?.(status, { sessionId: session.id, index: session.current?.index ?? 0, ...detail }); }
    catch (error) { console.error('[FWB media callback]', error); }
  }
  function live(session, clip) {
    return active === session && !session.settled && (!clip || session.clips.includes(clip));
  }
  function cancelFrame(clip) {
    if (clip.frame !== null) clip.video.cancelVideoFrameCallback?.(clip.frame);
    clip.frame = null;
  }
  function clearClip(clip) {
    clip.abort.abort();
    cancelFrame(clip);
    clip.video.pause();
  }
  function release(session) {
    if (active === session) active = null;
    clearTimeout(session.timeout);
    session.abort.abort();
    for (const clip of session.clips) {
      clearClip(clip);
      clip.video.removeAttribute('src');
      clip.video.load();
    }
    const restoreFocus = session.overlay.contains(document.activeElement) || document.activeElement === document.body;
    session.backdrop.remove();
    session.overlay.remove();
    if (restoreFocus) document.getElementById(session.options.canvasId)?.focus({ preventScroll: true });
  }
  function finish(session, status, detail) {
    if (!live(session)) return;
    if (status === 'ended' && document.hidden) { status = 'cancelled'; detail = { reason: 'background' }; }
    session.settled = true;
    clearTimeout(session.timeout);
    for (const clip of session.clips) clearClip(clip);
    if (status !== 'ended' || !session.options.holdLastFrame) release(session);
    notify(session, status, detail);
  }
  function stop() {
    if (!active) return;
    if (active.settled) release(active);
    else finish(active, 'cancelled', { reason: 'stopped' });
  }
  function getProgress() {
    const clip = active?.visible;
    if (!clip?.revealed) return 0;
    const video = clip.video;
    if (video.ended) return clip.index + 1;
    const fraction = Number.isFinite(video.duration) && video.duration > 0 && Number.isFinite(video.currentTime) ? Math.min(1, Math.max(0, video.currentTime / video.duration)) : 0;
    return clip.index + fraction;
  }
  function setRect(left = 0, top = 0, width = 1, height = 1) {
    if (!active) return false;
    const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const x = clamp(finite(left, 0), 0, 1 - minimumFraction);
    const y = clamp(finite(top, 0), 0, 1 - minimumFraction);
    const w = clamp(finite(width, 1), minimumFraction, 1 - x);
    const h = clamp(finite(height, 1), minimumFraction, 1 - y);
    for (const layer of [active.backdrop, active.overlay]) Object.assign(layer.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
    return true;
  }
  function normalizeSequence(value) {
    const sequence = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(sequence) || !sequence.length || sequence.length > 256) throw new Error('Expected 1..256 clips.');
    return sequence.map(item => {
      const candidates = typeof item === 'string' ? [item] : item?.sources;
      if (!Array.isArray(candidates) || !candidates.length || candidates.length > 8) throw new Error('Expected 1..8 source candidates per clip.');
      return candidates.map(candidate => {
        const src = typeof candidate === 'string' ? candidate : candidate?.src;
        const type = typeof candidate === 'string' ? '' : candidate?.type || '';
        if (typeof src !== 'string' || !src || src.length > 8192 || /[\x00-\x1f]/.test(src) || typeof type !== 'string') throw new Error('Invalid media source.');
        const url = new URL(src, document.baseURI);
        if (!['http:', 'https:', 'blob:'].includes(url.protocol) || url.username || url.password) throw new Error('Media requires an HTTP(S) or blob URL without credentials.');
        return { src: url.href, type };
      });
    });
  }
  function play(source, callback, options) { return playSequence([typeof source === 'string' ? source : { sources: [source] }], callback, options); }
  function playSequence(value, callback, options = {}) {
    const id = ++nextId;
    stop();
    // A cancellation listener may synchronously start a newer session.
    if (id !== nextId) { notify({ id, callback }, 'cancelled', { reason: 'superseded' }); return id; }
    const settings = { containerId: 'game-screen', canvasId: 'canvas', timeoutMs: 15000, label: 'Video', retryLabel: 'Tap to play', muted: true, blockInput: true, holdLastFrame: false, ...options };
    let sequence;
    const screen = document.getElementById(settings.containerId);
    try {
      sequence = normalizeSequence(value);
      if (!screen || !Number.isFinite(settings.timeoutMs) || settings.timeoutMs < 100 || settings.timeoutMs > 600000) throw new Error('Invalid media container or timeout.');
    } catch (error) {
      notify({ id, callback }, 'error', { reason: 'invalid-request', message: error.message });
      return id;
    }
    const backdrop = document.createElement('div');
    backdrop.className = 'fwb-media-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.style.cssText = 'position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none;';
    const overlay = document.createElement('div');
    overlay.className = 'fwb-media-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', settings.label);
    if (settings.blockInput) overlay.setAttribute('aria-modal', 'true');
    overlay.tabIndex = -1;
    overlay.style.cssText = `position:absolute;inset:0;z-index:50;overflow:hidden;outline:none;${settings.blockInput ? 'touch-action:none;' : 'pointer-events:none;'}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = settings.retryLabel;
    button.hidden = true;
    button.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:16px 24px;min-height:44px;font:inherit;pointer-events:auto;';
    overlay.append(button);
    const session = { id, callback, options: settings, sequence, backdrop, overlay, button, clips: [], current: null, visible: null, abort: new AbortController(), timeout: null, watchdog: 0, ready: false, settled: false };
    active = session;
    const videos = Array.from({ length: Math.min(2, sequence.length) }, () => {
      const video = document.createElement('video');
      video.style.cssText = 'display:block;position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;pointer-events:none;';
      video.style.opacity = '0';
      video.muted = !!settings.muted;
      video.defaultMuted = !!settings.muted;
      video.playsInline = true;
      video.preload = 'auto';
      video.controls = false;
      video.disablePictureInPicture = true;
      video.setAttribute('playsinline', '');
      if (settings.muted) video.setAttribute('muted', '');
      video.setAttribute('aria-hidden', 'true');
      backdrop.append(video);
      return video;
    });
    screen.append(backdrop, overlay);
    setRect(...(Array.isArray(settings.rect) ? settings.rect : []));
    function watchdog(clip) {
      clearTimeout(session.timeout);
      const ticket = ++session.watchdog;
      const generation = clip.generation;
      session.timeout = setTimeout(() => {
        if (!live(session, clip) || session.current !== clip || ticket !== session.watchdog || generation !== clip.generation) return;
        if (!clip.blocked) nextSource(clip, 'timeout');
      }, settings.timeoutMs);
    }
    function reveal(clip) {
      if (!live(session, clip) || session.current !== clip || clip.revealed || clip.video.readyState < 2) return;
      if (document.hidden) { finish(session, 'cancelled', { reason: 'background' }); return; }
      cancelFrame(clip);
      clip.revealed = true;
      const previous = session.visible;
      clip.video.style.opacity = '1';
      session.visible = clip;
      if (previous && previous !== clip) previous.video.style.opacity = '0';
      watchdog(clip);
      if (!session.ready) { session.ready = true; notify(session, 'ready'); }
      if (!live(session, clip)) return;
      // Reuse the old decoder only after the next decoded frame covers it.
      if (previous && previous !== clip && clip.index + 1 < sequence.length) prepare(previous.video, clip.index + 1);
    }
    function awaitFrame(clip) {
      if (!live(session, clip) || session.current !== clip || clip.revealed || clip.frame !== null || clip.video.readyState < 2) return;
      if (typeof clip.video.requestVideoFrameCallback === 'function') {
        const generation = clip.generation;
        clip.frame = clip.video.requestVideoFrameCallback(() => { if (generation === clip.generation) reveal(clip); });
      } else reveal(clip);
    }
    function attemptPlay(clip) {
      if (!live(session, clip) || session.current !== clip || clip.failed) return;
      const generation = clip.generation;
      const wasBlocked = clip.blocked;
      clip.blocked = false;
      session.button.hidden = true;
      watchdog(clip);
      function rejected(error) {
        if (!live(session, clip) || clip.generation !== generation || session.current !== clip) return;
        if (error?.name === 'NotAllowedError') {
          clip.blocked = true;
          session.button.hidden = false;
          session.button.focus({ preventScroll: true });
          clearTimeout(session.timeout);
          notify(session, 'blocked', { reason: 'user-gesture-required' });
        } else nextSource(clip, 'playback-error');
      }
      try {
        const pending = clip.video.play();
        Promise.resolve(pending).then(() => {
          if (!live(session, clip) || clip.generation !== generation || session.current !== clip) return;
          awaitFrame(clip);
          if (wasBlocked) notify(session, 'playing');
        }, rejected);
      } catch (error) { rejected(error); }
    }
    function loadSource(clip) {
      clip.abort.abort();
      clip.abort = new AbortController();
      cancelFrame(clip);
      clip.generation++;
      const generation = clip.generation;
      clip.revealed = false;
      clip.blocked = false;
      clip.lastTime = -1;
      clip.video.pause();
      const eventOptions = { signal: clip.abort.signal };
      const current = () => live(session, clip) && clip.generation === generation;
      clip.video.addEventListener('loadeddata', () => { if (current()) awaitFrame(clip); }, eventOptions);
      clip.video.addEventListener('timeupdate', () => {
        if (!current() || session.current !== clip || !clip.revealed || clip.blocked) return;
        if (clip.video.currentTime !== clip.lastTime) { clip.lastTime = clip.video.currentTime; watchdog(clip); }
      }, eventOptions);
      clip.video.addEventListener('ended', () => {
        if (!current() || session.current !== clip) return;
        if (document.hidden) { finish(session, 'cancelled', { reason: 'background' }); return; }
        if (!clip.revealed) reveal(clip);
        if (!current()) return;
        if (clip.index === sequence.length - 1) finish(session, 'ended', { reason: 'completed' });
        else begin(session.clips.find(item => item.index === clip.index + 1));
      }, eventOptions);
      clip.video.addEventListener('error', () => { if (current()) nextSource(clip, 'decode-error'); }, eventOptions);
      clip.video.src = sequence[clip.index][clip.candidate].src;
      clip.video.load();
      clip.video.defaultPlaybackRate = 1;
      clip.video.playbackRate = 1;
      if (session.current === clip) attemptPlay(clip);
    }
    function nextSource(clip, reason) {
      if (!live(session, clip) || clip.failed) return;
      if (++clip.candidate < sequence[clip.index].length) loadSource(clip);
      else {
        clip.failed = reason;
        clearClip(clip);
        if (session.current === clip) finish(session, 'error', { reason, attempts: sequence[clip.index].length });
      }
    }
    function prepare(video, index) {
      const previous = session.clips.find(clip => clip.video === video);
      if (previous) { clearClip(previous); session.clips.splice(session.clips.indexOf(previous), 1); }
      const clip = { video, index, candidate: 0, abort: new AbortController(), generation: 0, frame: null, revealed: false, blocked: false, failed: null, lastTime: -1 };
      session.clips.push(clip);
      loadSource(clip);
      return clip;
    }
    function begin(clip) {
      if (!live(session)) return;
      if (!clip) { finish(session, 'error', { reason: 'missing-next-clip' }); return; }
      session.current = clip;
      if (clip.failed) { finish(session, 'error', { reason: clip.failed }); return; }
      attemptPlay(clip);
    }
    session.retry = () => {
      const clip = session.current;
      if (!live(session, clip) || !clip?.blocked) return false;
      attemptPlay(clip); // Deliberately synchronous within the trusted input event.
      return true;
    };
    button.addEventListener('click', event => { event.stopPropagation(); session.retry(); }, { signal: session.abort.signal });
    const leave = () => { if (session.settled) release(session); else finish(session, 'cancelled', { reason: 'background' }); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) leave(); }, { signal: session.abort.signal });
    window.addEventListener('pagehide', leave, { signal: session.abort.signal });
    if (settings.blockInput) {
      for (const name of ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'click', 'dblclick', 'wheel', 'contextmenu']) {
        overlay.addEventListener(name, event => {
          event.stopPropagation();
          if (['touchmove', 'wheel', 'contextmenu'].includes(name)) event.preventDefault();
        }, { signal: session.abort.signal, passive: false });
      }
      for (const name of ['keydown', 'keyup']) document.addEventListener(name, event => {
        // Keep the retry button's keyboard activation native and accessible.
        if (document.activeElement === button && ['Enter', ' ', 'Tab'].includes(event.key)) return;
        event.preventDefault(); event.stopImmediatePropagation();
      }, { signal: session.abort.signal, capture: true });
      overlay.focus({ preventScroll: true });
    }
    if (document.hidden) { finish(session, 'cancelled', { reason: 'background' }); return id; }
    const first = prepare(videos[0], 0);
    if (videos.length > 1) prepare(videos[1], 1);
    begin(first);
    return id;
  }
  function retry() { return active?.retry() ?? false; }
  window.FWBMedia = Object.freeze({ play, playSequence, stop, retry, setRect, getProgress });
}());
