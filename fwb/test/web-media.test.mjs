import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './fixtures/browser-dom.mjs';

const script = new URL('../runtime/web/fwb-media.js', import.meta.url);
const fixture = () => browserFixture(script);

test('media rejects unsafe sources with one explicit error', () => {
  const f = fixture(); const events = [];
  f.window.FWBMedia.play('javascript:alert(1)', (...event) => events.push(event));
  assert.equal(events.length, 1); assert.equal(events[0][0], 'error');
  assert.equal(events[0][1].reason, 'invalid-request'); assert.equal(f.videos.length, 0);
});

test('two decoders preserve the last frame until the next frame, then recycle and clean up', async () => {
  const f = fixture(); const api = f.window.FWBMedia; const events = [];
  api.playSequence(['one.mp4', 'two.mp4', 'three.mp4'], status => events.push(status));
  assert.equal(f.videos.length, 2);
  const [first, second] = f.videos;
  first.decoded(); assert.deepEqual(events, []); first.frame();
  assert.deepEqual(events, ['ready']); assert.equal(first.style.opacity, '1');
  first.currentTime = 1; assert.equal(api.getProgress(), 0.5);
  first.end(); assert.equal(api.getProgress(), 1); assert.equal(first.style.opacity, '1');
  assert.match(first.src, /one\.mp4$/);
  second.decoded(); assert.equal(first.style.opacity, '1'); second.frame();
  assert.equal(first.style.opacity, '0'); assert.equal(second.style.opacity, '1');
  assert.match(first.src, /three\.mp4$/); assert.equal(api.getProgress(), 1);
  second.end(); first.decoded(); first.frame(); first.end();
  await f.flush();
  assert.deepEqual(events, ['ready', 'ended']);
  assert.equal(f.ids.get('game-screen').children.length, 0);
  assert.equal(f.timers.size, 0); assert.ok(f.videos.every(video => video.src === ''));
  first.end(); api.stop(); assert.deepEqual(events, ['ready', 'ended']);
});

test('decode errors try the next explicit encoding and ignore a prior play rejection', async () => {
  const f = fixture(); const events = [];
  let reject;
  const create = f.document.createElement;
  f.document.createElement = tag => { const el = create(tag); if (tag === 'video') el.plays.push(() => new Promise((_, fail) => { reject = fail; })); return el; };
  f.window.FWBMedia.playSequence([{ sources: ['clip.webm', { src: 'clip.mp4', type: 'video/mp4' }] }], status => events.push(status));
  const video = f.videos[0];
  video.emit('error'); assert.match(video.src, /clip\.mp4$/);
  reject(new Error('old source')); await f.flush(); assert.deepEqual(events, []);
  video.decoded(); video.frame(); video.end(); await f.flush();
  assert.deepEqual(events, ['ready', 'ended']);
});

test('optional final-frame hold retains progress and input until host commits, then stop releases once', () => {
  const f = fixture(); const events = []; const api = f.window.FWBMedia;
  api.play('clip.mp4', status => events.push(status), { holdLastFrame: true });
  f.videos[0].decoded(); f.videos[0].frame(); f.videos[0].end();
  assert.equal(api.getProgress(), 1); assert.equal(f.ids.get('game-screen').children.length, 2);
  assert.equal(f.document.emit('keydown', { key: 'Enter' }).prevented, true);
  api.stop(); api.stop(); assert.deepEqual(events, ['ready', 'ended']);
  assert.equal(f.ids.get('game-screen').children.length, 0); assert.equal(api.getProgress(), 0);
  assert.equal(f.document.emit('keydown', { key: 'Enter' }).prevented, false);
});

test('fallback without video frame callbacks reveals loaded media and preserves canvas style', async () => {
  const f = fixture(); const events = []; const canvas = f.ids.get('canvas'); canvas.style.opacity = '0.7';
  const create = f.document.createElement;
  f.document.createElement = tag => { const el = create(tag); if (tag === 'video') el.requestVideoFrameCallback = undefined; return el; };
  f.window.FWBMedia.play('one.mp4', status => events.push(status));
  f.videos[0].decoded(); assert.deepEqual(events, ['ready']);
  f.videos[0].end(); await f.flush(); assert.deepEqual(events, ['ready', 'ended']); assert.equal(canvas.style.opacity, '0.7');
});

test('progress is read-only media time, clamps invalid metadata and resets on replacement', () => {
  const f = fixture(); const api = f.window.FWBMedia;
  api.play('one.mp4', () => {}); const video = f.videos[0]; video.decoded(); video.frame();
  video.currentTime = 1;
  for (const duration of [NaN, Infinity, 0]) { video.duration = duration; assert.equal(api.getProgress(), 0); }
  video.duration = 4; video.currentTime = -1; assert.equal(api.getProgress(), 0);
  video.currentTime = 8; assert.equal(api.getProgress(), 1);
  video.currentTime = 2; const before = [video.playCount, video.pauseCount, f.timers.size];
  for (let i = 0; i < 100; i++) assert.equal(api.getProgress(), 0.5);
  assert.deepEqual([video.playCount, video.pauseCount, f.timers.size], before);
  api.play('two.mp4', () => {}); assert.equal(api.getProgress(), 0); api.stop();
});

test('playback remains normal speed; video under transparent canvas and overlay blocks skip inputs', () => {
  const f = fixture(); const create = f.document.createElement;
  f.document.createElement = tag => { const el = create(tag); if (tag === 'video') { const load = el.load.bind(el); el.load = () => { load(); el.playbackRate = 4; el.defaultPlaybackRate = 4; }; } return el; };
  f.window.FWBMedia.playSequence(['one.mp4', 'two.mp4', 'three.mp4'], () => {});
  const [backdrop, overlay] = f.ids.get('game-screen').children;
  assert.match(backdrop.style.cssText, /z-index:0/); assert.match(overlay.style.cssText, /z-index:50/);
  for (const name of ['pointerdown', 'click', 'touchstart', 'wheel']) assert.equal(overlay.emit(name).stopped, true);
  for (const key of ['Escape', 'Enter', ' ', 'ArrowRight']) assert.equal(f.document.emit('keydown', { key }).immediate, true);
  for (const video of [f.videos[0], f.videos[1], f.videos[0]]) {
    assert.equal(video.playbackRate, 1); assert.equal(video.defaultPlaybackRate, 1); assert.equal(video.controls, false); assert.equal(video.muted, true);
    video.decoded(); video.frame(); video.end();
  }
});

test('recycled decoder and delayed ended-before-frame cannot advance stale generations', () => {
  const f = fixture(); const events = [];
  f.window.FWBMedia.playSequence(['one.mp4', 'two.mp4', 'three.mp4'], status => events.push(status));
  const [first, second] = f.videos;
  first.decoded(); const oldFrame = [...first.frames.values()][0]; const oldEnded = [...first.listeners.get('ended')][0]; const oldError = [...first.listeners.get('error')][0];
  first.frame(); first.end(); second.decoded(); const delayedSecondFrame = [...second.frames.values()][0];
  second.end(); assert.match(first.src, /three\.mp4$/); assert.equal(first.playCount, 2);
  oldFrame(); oldEnded(); oldError(); delayedSecondFrame(); assert.deepEqual(events, ['ready']);
  first.decoded(); first.frame(); first.end(); assert.deepEqual(events, ['ready', 'ended']);
});

test('gesture rejection remains pending without watchdog and retries synchronously from the button', async () => {
  const f = fixture(); const events = [];
  // Override the first play through a source load hook before creating a video.
  const create = f.document.createElement;
  f.document.createElement = tag => { const el = create(tag); if (tag === 'video') el.plays.push(() => Promise.reject(Object.assign(new Error('gesture'), { name: 'NotAllowedError' }))); return el; };
  f.window.FWBMedia.play('clip.mp4', status => events.push(status));
  await f.flush(); assert.deepEqual(events, ['blocked']); assert.equal(f.timers.size, 0);
  const button = f.ids.get('game-screen').children[1].children[0];
  assert.equal(button.hidden, false); button.emit('click');
  assert.equal(f.videos[0].playCount, 2); await f.flush();
  assert.deepEqual(events, ['blocked', 'playing']); assert.equal(button.hidden, true);
  f.videos[0].decoded(); f.videos[0].frame(); f.videos[0].end();
  assert.deepEqual(events, ['blocked', 'playing', 'ready', 'ended']);
});

test('preloaded candidate exhaustion does not terminate the playing clip early', () => {
  const f = fixture(); const events = [];
  f.window.FWBMedia.playSequence(['one.mp4', 'two.mp4'], (status, detail) => events.push([status, detail.reason]));
  f.videos[1].emit('error'); assert.deepEqual(events, []);
  f.videos[0].decoded(); f.videos[0].frame(); f.videos[0].end();
  assert.deepEqual(events.map(event => event[0]), ['ready', 'error']);
  assert.equal(events[1][1], 'decode-error'); assert.equal(f.timers.size, 0);
});

test('stall timeout falls back, then reports error without claiming completion', () => {
  const f = fixture(); const events = [];
  f.window.FWBMedia.playSequence([{ sources: ['one.webm', 'one.mp4'] }], (status, detail) => events.push([status, detail.reason]));
  f.tick(); assert.match(f.videos[0].src, /one\.mp4$/);
  f.tick(); assert.deepEqual(events, [['error', 'timeout']]); assert.equal(f.timers.size, 0);
});

test('obsolete watchdog cannot consume a replacement codec attempt', () => {
  const f = fixture(); const events = [];
  f.window.FWBMedia.playSequence([{ sources: ['one.webm', 'one.mp4'] }], status => events.push(status));
  const oldTimer = [...f.timers.values()][0];
  f.videos[0].emit('error'); oldTimer(); assert.deepEqual(events, []);
  f.videos[0].decoded(); f.videos[0].frame(); f.videos[0].end(); assert.deepEqual(events, ['ready', 'ended']);
});

test('reentrant cancellation listener does not leak superseded session DOM', () => {
  const f = fixture(); const api = f.window.FWBMedia; const events = [];
  api.play('one.mp4', status => { if (status === 'cancelled') api.play('newest.mp4', () => {}); });
  api.play('superseded.mp4', (status, detail) => events.push([status, detail.reason]));
  assert.deepEqual(events, [['cancelled', 'superseded']]);
  assert.equal(f.ids.get('game-screen').children.length, 2); assert.match(f.videos.at(-1).src, /newest\.mp4$/);
  api.stop(); assert.equal(f.ids.get('game-screen').children.length, 0);
});

test('stop guards late promise/frame callbacks and background exit never completes a clip', async () => {
  const f = fixture(); const events = [];
  let reject;
  const create = f.document.createElement;
  f.document.createElement = tag => { const el = create(tag); if (tag === 'video') el.plays.push(() => new Promise((_, fail) => { reject = fail; })); return el; };
  f.window.FWBMedia.play('one.mp4', status => events.push(status));
  const old = f.videos[0]; old.decoded(); const lateFrame = [...old.frames.values()][0];
  f.window.FWBMedia.stop(); lateFrame(); reject(new Error('late')); await f.flush();
  assert.deepEqual(events, ['cancelled']);
  f.window.FWBMedia.play('two.mp4', (status, detail) => events.push(`${status}:${detail.reason}`));
  f.document.hidden = true; f.videos[1].end();
  assert.deepEqual(events, ['cancelled', 'cancelled:background']);
  f.window.emit('pagehide'); assert.equal(events.length, 2); assert.equal(f.timers.size, 0);
});

test('rect uses finite normalized coordinates; hidden documents cancel without a decoder start', () => {
  const f = fixture();
  f.window.FWBMedia.play('one.mp4', () => {}, { rect: [NaN, -2, 8, 9] });
  const layer = f.ids.get('game-screen').children[0];
  assert.equal(layer.style.left, '0%'); assert.equal(layer.style.width, '100%');
  f.document.hidden = true; f.document.emit('visibilitychange');
  const events = [];
  f.window.FWBMedia.play('two.mp4', (status, detail) => events.push([status, detail.reason]));
  assert.deepEqual(events, [['cancelled', 'background']]); assert.equal(f.videos[1].playCount, 0);
});
