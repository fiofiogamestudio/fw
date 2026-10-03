import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { targetCategories, targets, getTarget } from '../src/platforms.mjs';
import { initProject, readProject } from '../src/core/project.mjs';
import { createWorkbenchState } from '../src/editor/state.mjs';

test('delivery categories share Web technology without changing execution families or validation status', () => {
  assert.deepEqual(targetCategories.map(item => [item.id, item.label, item.technology]), [
    ['static-web', '静态网页', 'web'], ['h5', 'H5 平台', 'web'], ['minigame', '小游戏', 'web'],
    ['android', 'Android', 'native'], ['ios', 'iOS', 'native'],
  ]);
  const expected = [
    ['web', 'static-web', 'web', 'web'], ['poki', 'h5', 'web', 'web'], ['taptap-h5', 'h5', 'web', 'web'],
    ['wechat-minigame', 'minigame', 'web', 'minigame'], ['douyin-minigame', 'minigame', 'web', 'minigame'],
    ['google-play', 'android', 'native', 'android'], ['app-store', 'ios', 'native', 'ios'],
  ];
  assert.deepEqual(targets.map(item => [item.id, item.category, item.technology, item.family]), expected);
  assert.equal(getTarget('web').label, '静态网页（浏览器）');
  assert.equal(getTarget('wechat-minigame').status, 'unverified');
  assert.equal(getTarget('wechat-minigame').platform, null);
  assert.throws(() => targetCategories.push({}), TypeError);
  assert.throws(() => { targetCategories[0].technology = 'native'; }, TypeError);
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.textContent = ''; this.value = ''; this.isConnected = true; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type) { for (const handler of this.listeners[type] || []) handler({ target: this }); }
  get firstChild() { return this.children[0]; }
  get options() { return this.querySelectorAll('option'); }
  querySelectorAll(selector) { const names = selector.split(','); return this.children.flatMap(child => [ ...(names.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector) ]); }
  remove() { this.isConnected = false; }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const flush = () => new Promise(resolve => setImmediate(resolve));

test('workbench snapshot and both real selectors expose category groups and preserve selected target settings', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwb-category-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'project.godot'), '[application]\nconfig/name="Category fixture"\n');
  initProject(root);
  const state = await createWorkbenchState(root, { readProject, listArtifacts: () => [], environmentFile: path.join(root, 'environment.json') });
  const snapshot = await state.snapshot();
  assert.deepEqual(snapshot.targetCategories, targetCategories);
  for (const descriptor of targets) {
    const item = snapshot.platforms.find(item => item.target === descriptor.id);
    assert.equal(item.category, descriptor.category); assert.equal(item.technology, descriptor.technology);
    assert.equal(item.label, descriptor.label);
  }
  const config = structuredClone(readProject(root).config);
  config.resourcePipelines = { web: { prepareScript: 'tools/prepare.mjs' }, mobile: { prepareScript: 'tools/mobile.mjs' } };
  config.targets['wechat-minigame'].resourcePipeline = false;
  const commands = []; let layout;
  const document = { createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }) };
  const context = vm.createContext({ document, setInterval: () => 0, clearInterval() {}, window: { fwe: { session: { headers: value => value }, registerWorkbenchLayout: (name, value) => { layout = value; } } },
    fetch: async (url, options) => {
      const bodies = { '/api/fwb/session': { csrfToken: 'test-token' }, '/api/fwb/snapshot': snapshot, '/api/fwb/config': { config, revision: 'fixture' }, '/api/fwb/environment': { config: { godot: {}, android: {} }, file: 'fixture' } };
      if (url === '/api/fwb/commands') { commands.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ job: {} }) }; }
      assert.ok(Object.hasOwn(bodies, url), url); return { ok: true, json: async () => bodies[url] };
    },
  });
  vm.runInContext(await fs.readFile(new URL('../src/editor/app/workbench.js', import.meta.url), 'utf8'), context);
  const host = new Element('div'); layout.render({ hosts: { documentTree: host }, showView() {} }); await flush();
  const find = predicate => descendants(host).find(predicate);
  const select = name => find(node => node.attributes['aria-label'] === name);
  const assertGroups = node => {
    assert.deepEqual(node.children.map(group => group.tagName), Array(5).fill('optgroup'));
    assert.deepEqual(node.children.map(group => group.label), ['静态网页 · Web 技术', 'H5 平台 · Web 技术', '小游戏 · Web 技术', 'Android · 原生', 'iOS · 原生']);
    assert.deepEqual(node.options.map(option => option.value), targets.map(target => target.id));
  };
  assertGroups(select('构建目标')); assertGroups(select('设置平台'));
  select('构建目标').value = 'wechat-minigame'; select('构建目标').dispatch('change');
  find(node => node.tagName === 'button' && node.textContent === '平台设置').dispatch('click'); await flush();
  assert.equal(select('设置平台').value, 'wechat-minigame');
  assert.equal(select('共享资源流水线').value, 'disabled');
  assert.ok(find(node => node.textContent.includes('需平台适配器生成专用小游戏工程')));
  assert.ok(select('Web → 微信转换脚本（可选）'));
  select('共享资源流水线').value = 'pipeline:mobile'; select('共享资源流水线').dispatch('change');
  assert.equal(config.targets['wechat-minigame'].resourcePipeline, 'mobile');
  select('共享资源流水线').value = 'disabled'; select('共享资源流水线').dispatch('change');
  find(node => node.tagName === 'button' && node.textContent === '保存平台设置').dispatch('click'); await flush();
  assert.equal(commands[0].type, 'settings.save');
  assert.equal(commands[0].payload.config.targets['wechat-minigame'].resourcePipeline, false);
  select('共享资源流水线').value = 'inherit'; select('共享资源流水线').dispatch('change');
  assert.equal(Object.hasOwn(config.targets['wechat-minigame'], 'resourcePipeline'), false);
  assert.equal(config.targets.web.resourcePipeline, undefined);
});
