import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWebShell, validateWebShell, prepareWebShell, copyWebShellOutput } from '../src/core/web-shell.mjs';
import { browserFixture } from './fixtures/browser-dom.mjs';

const script = new URL('../runtime/web/fwb-shell.js', import.meta.url);

test('shell is opt in, browser only, target options override defaults and reject invalid values', () => {
  assert.equal(resolveWebShell({ targets: {} }, 'web'), null);
  const config = { webShell: { enabled: true, maxWidth: 540 }, targets: { poki: { webShell: { maxWidth: 900 } } } };
  assert.equal(resolveWebShell(config, 'poki').maxWidth, 900);
  assert.equal(resolveWebShell(config, 'google-play'), null);
  assert.throws(() => validateWebShell({ webShell: { surprise: true } }), /Unknown/);
  assert.throws(() => validateWebShell({ webShell: { maxDevicePixelRatio: Infinity } }), /must be/);
  assert.throws(() => validateWebShell({ targets: { 'google-play': { webShell: { enabled: true } } } }), /not supported/);
});

test('staged shell preserves Godot placeholders and escapes config without editing host', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage'); const out = path.join(root, 'out');
  const project = { root, config: { webShell: { enabled: true, label: '</script><script>alert(1)</script>', locale: 'zh-CN' } } };
  const result = prepareWebShell({ project, stage, target: 'taptap-h5' });
  const html = fs.readFileSync(path.join(stage, result.customShell.slice(6)), 'utf8');
  assert.ok(html.includes('$GODOT_CONFIG')); assert.ok(html.includes('$GODOT_URL'));
  assert.ok(!html.includes('</script><script>alert')); assert.ok(html.includes('\\u003c/script'));
  const frozenScript = path.join(stage, 'addons/fwb_web/fwb-shell.js');
  fs.appendFileSync(frozenScript, '\n// frozen snapshot marker\n');
  assert.equal(copyWebShellOutput({ project, stage, out, target: 'web' }).length, 2);
  assert.ok(fs.readFileSync(path.join(out, 'fwb-shell.js'), 'utf8').includes('frozen snapshot marker'));
  assert.throws(() => prepareWebShell({ project, stage: root, target: 'web' }), /isolated/);
  assert.equal(prepareWebShell({ project: { root, config: {} }, stage, target: 'web' }), null);
});

test('viewport sizes backing pixels once, caps DPR, updates dimensions, and detaches listeners', () => {
  const f = browserFixture(script); f.window.devicePixelRatio = 4;
  const detach = f.window.FWBShell.attachViewport({ maxWidth: 540, maxDevicePixelRatio: 2, safeArea: false, label: 'Title' });
  const canvas = f.ids.get('canvas');
  assert.equal(canvas.width, 780); assert.equal(canvas.height, 1688);
  assert.equal(f.ids.get('game-screen').style.maxWidth, '540px'); assert.equal(f.ids.get('safe-viewport').style.inset, '0px');
  f.ids.get('game-screen').bounds = { width: 320, height: 568 };
  f.window.visualViewport.emit('resize'); f.tick(); assert.equal(canvas.width, 640);
  detach(); f.window.emit('resize'); assert.equal(f.timers.size, 0);
});

test('startup reports determinate progress then hides loader without claiming gameplay ready', async () => {
  const f = browserFixture(script); let done;
  class Engine { static getMissingFeatures() { return []; } startGame({ onProgress }) { onProgress(30, 100); return new Promise(resolve => { done = resolve; }); } }
  f.window.FWBShell.boot({ config: {}, Engine });
  assert.equal(f.ids.get('status-progress').value, 30);
  done(); await f.flush(); assert.equal(f.ids.get('status').hidden, true); assert.equal(f.timers.size, 0);
});

test('unsupported, network, and timeout startup failures are distinct; retry reloads once', async () => {
  const f = browserFixture(script);
  class Unsupported { static getMissingFeatures() { return ['WebGL2']; } }
  f.window.FWBShell.boot({ config: {}, Engine: Unsupported });
  assert.equal(f.ids.get('status-notice').dataset.reason, 'unsupported'); assert.equal(f.ids.get('status-retry').hidden, true);
  f.window.FWBShell.boot({ config: {}, engineUrl: 'index.js' });
  const loader = f.document.body.children.find(el => el.tagName === 'script'); loader.onerror();
  assert.equal(f.ids.get('status-notice').dataset.reason, 'network'); assert.equal(f.ids.get('status-retry').hidden, false);
  f.ids.get('status-retry').emit('click'); assert.equal(f.window.reloads, 1);
  let resolve;
  class Stalled { static getMissingFeatures() { return []; } startGame() { return new Promise(done => { resolve = done; }); } }
  f.window.FWBShell.boot({ config: {}, Engine: Stalled }); f.tick();
  assert.equal(f.ids.get('status-notice').dataset.reason, 'timeout');
  resolve(); await f.flush(); assert.equal(f.ids.get('status').hidden, false);
});
