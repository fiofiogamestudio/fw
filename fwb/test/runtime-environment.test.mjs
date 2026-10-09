import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installRuntimeAddon, validateRuntimeConfig, runtimeHeadScripts, runtimeWebFiles } from '../src/core/runtime-dev.mjs';

const web = fs.readFileSync(new URL('../runtime/web/fwb-web.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('shared browser events include initially-hidden launches, restoration and freezing without SDK', async () => {
  const handlers = {};
  const events = [];
  const context = vm.createContext({ document: { hidden: true, addEventListener: (name, callback) => { handlers[name] = callback; } }, addEventListener: (name, callback) => { handlers[name] = callback; } });
  vm.runInContext(web, context);
  context.FWBWeb.initialize(json => events.push(JSON.parse(json)));
  assert.equal(events.length, 0);
  await tick();
  assert.deepEqual(events.at(-1), { type: 'environment', reason: 'page_hidden', active: true });
  context.document.hidden = false;
  handlers.pageshow();
  assert.equal(events.at(-1).active, false);
  handlers.freeze();
  assert.deepEqual(events.at(-1), { type: 'environment', reason: 'page_frozen', active: true });
  handlers.resume();
  assert.equal(events.at(-1).active, false);
  assert.equal(JSON.parse(context.FWBWeb.storageStatus()).durability, 'unknown');
});

test('runtime config rejects private credentials, unknown capabilities and invalid timeouts', () => {
  validateRuntimeConfig({ taptap: { enabled: true, cloudSave: false }, requestTimeoutMs: 1000 });
  for (const config of [{ taptap: { secret: 'x' } }, { clientSecret: 'x' }, { requestTimeoutMs: 0 }, { taptap: { enabled: 'true' } }]) assert.throws(() => validateRuntimeConfig(config), { code: 'invalid-config' });
  assert.deepEqual(runtimeHeadScripts('taptap-h5'), ['fwb-web.js', 'fwb-taptap.js']);
  assert.ok(runtimeWebFiles('poki').every(file => path.isAbsolute(file.source)));
});

test('development installation is repeatable and rejects edited files before replacing anything', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'project.godot'), '[application]\nconfig/name="test"\n\n[autoload]\nOther="*res://other.gd"\n');
  const installed = installRuntimeAddon(root, { development: true });
  assert.ok(installed.files.some(file => file.path === 'addons/fwb/platform.gd'));
  assert.match(fs.readFileSync(path.join(root, 'project.godot'), 'utf8'), /Other="\*res:\/\/other.gd"/);
  installRuntimeAddon(root, { development: true });
  const runtime = path.join(root, 'addons/fwb/platform.gd');
  fs.appendFileSync(runtime, '\n# local edit');
  assert.throws(() => installRuntimeAddon(root, { development: true, platform: 'poki' }), { code: 'runtime-file-conflict' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'fwb.runtime.json'))).platform, 'web');
  assert.match(fs.readFileSync(runtime, 'utf8'), /local edit/);
});
