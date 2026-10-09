import vm from 'node:vm';
import fs from 'node:fs';

// Deliberate deterministic DOM/media boundary fake: tests scheduling and cleanup,
// not browser codecs, GPU composition, or device gesture policy.
export function browserFixture(script) {
  const timers = new Map();
  let timerId = 0;
  const videos = [];
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, fn, options = {}) {
      if (options.signal?.aborted) return;
      const listeners = this.listeners.get(name) || new Set();
      listeners.add(fn); this.listeners.set(name, listeners);
      options.signal?.addEventListener('abort', () => listeners.delete(fn), { once: true });
    }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    emit(name, details = {}) {
      const event = { type: name, prevented: false, stopped: false, immediate: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.immediate = true; }, ...details };
      for (const fn of [...(this.listeners.get(name) || [])]) fn(event);
      return event;
    }
  }
  let document;
  class Element extends Events {
    constructor(tag) { super(); this.tagName = tag; this.style = {}; this.dataset = {}; this.children = []; this.attributes = {}; this.hidden = false; this.parent = null; this.textContent = ''; }
    append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = ''; if (key === 'value' || key === 'max') delete this[key]; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    focus() { document.activeElement = this; }
    contains(value) { return value === this || this.children.some(child => child.contains(value)); }
    getBoundingClientRect() { return this.bounds || { width: 390, height: 844 }; }
  }
  class Video extends Element {
    constructor() { super('video'); this.readyState = 0; this.currentTime = 0; this.duration = 2; this.ended = false; this.plays = []; this.frames = new Map(); this.frameId = 0; this.playCount = 0; this.pauseCount = 0; videos.push(this); }
    load() { this.currentTime = 0; this.readyState = 0; this.ended = false; }
    play() { this.playCount++; return this.plays.length ? this.plays.shift()() : Promise.resolve(); }
    pause() { this.pauseCount++; }
    requestVideoFrameCallback(fn) { this.frames.set(++this.frameId, fn); return this.frameId; }
    cancelVideoFrameCallback(id) { this.frames.delete(id); }
    decoded() { this.readyState = 2; this.emit('loadeddata'); }
    frame() { const callbacks = [...this.frames.values()]; this.frames.clear(); callbacks.forEach(fn => fn()); }
    end() { this.readyState = 2; this.ended = true; this.emit('ended'); }
  }
  document = new Events();
  document.hidden = false;
  document.baseURI = 'https://game.example/path/index.html';
  document.documentElement = new Element('html');
  document.body = new Element('body');
  document.activeElement = document.body;
  const ids = new Map();
  for (const id of ['safe-viewport', 'game-screen', 'canvas', 'status', 'status-progress', 'status-notice', 'status-retry']) { const el = new Element(id === 'canvas' ? 'canvas' : 'div'); ids.set(id, el); document.body.append(el); }
  document.getElementById = id => ids.get(id) || null;
  document.createElement = tag => tag === 'video' ? new Video() : new Element(tag);
  const window = new Events();
  window.devicePixelRatio = 2;
  window.visualViewport = new Events();
  window.matchMedia = () => new Events();
  window.location = { reload() { window.reloads = (window.reloads || 0) + 1; } };
  const schedule = fn => { timers.set(++timerId, fn); return timerId; };
  const context = vm.createContext({ window, document, URL, AbortController, console: { error() {} }, setTimeout: schedule, clearTimeout: id => timers.delete(id), requestAnimationFrame: schedule, cancelAnimationFrame: id => timers.delete(id), ResizeObserver: class { observe() {} disconnect() {} } });
  vm.runInContext(fs.readFileSync(script, 'utf8'), context);
  return { window, document, videos, ids, timers, async flush() { await Promise.resolve(); await Promise.resolve(); }, tick() { const entry = timers.entries().next().value; if (!entry) throw new Error('No pending timer.'); timers.delete(entry[0]); entry[1](); } };
}
