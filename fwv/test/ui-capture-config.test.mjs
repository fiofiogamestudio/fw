import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { CaptureWorkspace } from '../ui/core/workspace.mjs';

const require = createRequire(import.meta.url);
const runtime = process.env.FWE_PATH || fileURLToPath(new URL('../../fwe/', import.meta.url));
const { loadAppConfig } = require(path.join(runtime, 'src/server.js'));
const app = loadAppConfig(fileURLToPath(new URL('../ui/app/fwe.app.json', import.meta.url)));
const domain = app.domains.find(item => item.id === 'fwv-ui-capture');

async function nativeDiagnostics(data) {
  const source = await fs.readFile(path.join(runtime, 'public/app.js'), 'utf8');
  function functionSource(name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.notEqual(start, -1, `Missing FWE validator function ${name}`);
    const rest = source.slice(start), next = rest.search(/\n(?:async )?function /);
    return next < 0 ? rest : rest.slice(0, next);
  }
  const context = vm.createContext({ state: { domain, data, serverDiagnostics: [] }, getAppLabel: (_key, fallback) => fallback });
  const functions = ['validateCurrent', 'validateObjectRule', 'validateUnique', 'pushDiagnostic', 'matchesType', 'mergeDiagnostics', 'getByPath', 'collectPathValues', 'formatPathParts', 'parsePathParts', 'ensureArray', 'formatAppLabel'];
  vm.runInContext(functions.map(functionSource).join('\n'), context);
  return structuredClone(vm.runInContext('validateCurrent()', context));
}

test('FWE compiler preserves catalog default, structured filters and native save history', () => {
  assert.equal(domain.workbench.layout, 'catalog');
  assert.deepEqual(domain.workbench.default, { collection: 'screenshots', list: 'grid', mode: 'review' });
  for (const collection of domain.workbench.collections) {
    assert.ok(collection.list.includes(domain.workbench.default.list), `${collection.id} must keep the global layout reachable after a deep-link reload`);
    assert.ok(collection.list.includes('detail'), `${collection.id} must offer an inspection layout`);
  }
  const [screenshots, coverage] = domain.workbench.collections;
  assert.deepEqual(screenshots.filters.map(filter => filter.id), ['category', 'current', 'reviewStatus']);
  assert.deepEqual(coverage.filters.map(filter => filter.id), ['category', 'status']);
  assert.deepEqual(screenshots.filters.find(filter => filter.id === 'current').default, ['current']);
  assert.equal(screenshots.columns.find(column => column.path === 'reviewStatus').valueMap.unreviewed, '待审阅');
  assert.ok(!screenshots.columns.some(column => column.path === 'title'), 'the native card already renders its title');
  assert.deepEqual(domain.actions.toolbar, ['undo', 'redo', 'save']);
  for (const action of ['add', 'duplicate', 'delete', 'new']) assert.equal(domain.actions[action], false);
});

test('mode-specific review form explicitly supplies native control metadata and permits an empty note', () => {
  const fields = domain.inspector.forms['screenshots:review'].groups.flatMap(group => group.fields);
  const status = fields.find(field => field.path === 'reviewStatus');
  assert.equal(status.type, 'select');
  assert.deepEqual(status.options.map(option => option.value), ['unreviewed', 'issue', 'accepted', 'rejected']);
  assert.equal(fields.find(field => field.path === 'reviewNote').type, 'textarea');
  assert.ok(!domain.validate.some(rule => rule.path === 'screenshots[].reviewNote' && rule.rule === 'required'));
  assert.ok(domain.validate.some(rule => rule.path === 'screenshots[].reviewStatus' && rule.rule === 'enum'));
});

test('real FWE validator allows empty screenshot references on blocked and excluded coverage', async () => {
  const data = {
    schemaVersion: 1, manifestId: 'fixture', project: 'fixture', title: 'Fixture',
    screenshots: [{ id: 'shot', number: 1, title: 'Shot', category: 'Menu', current: 'current', imageUrl: '/image', reference: { id: 'shot' }, width: 1920, height: 1080, reviewStatus: 'unreviewed', reviewNote: '' }],
    coverage: ['blocked', 'excluded'].map(status => ({ id: status, title: status, category: 'Menu', status, reason: 'Fixture has no screenshot for this state.', screenshotIds: [] })),
    categories: [{ id: 'Menu', name: 'Menu' }]
  };
  assert.deepEqual(await nativeDiagnostics(data), []);
  data.coverage[0].screenshotIds = [42];
  assert.ok((await nativeDiagnostics(data)).some(issue => issue.path === 'coverage[0].screenshotIds[0]'));
  data.coverage[0].screenshotIds = [];
  data.screenshots[0].reviewStatus = 'invalid';
  assert.ok((await nativeDiagnostics(data)).some(issue => issue.path === 'screenshots[0].reviewStatus'));
});

test('real supplied capture Source passes native FWE validation before and after a review edit', { skip: !process.env.FWV_UI_CAPTURE_MANIFEST }, async () => {
  const workspace = await CaptureWorkspace.open(process.env.FWV_UI_CAPTURE_MANIFEST);
  const resource = await workspace.catalog();
  assert.ok(resource.data.screenshots.length > 0);
  assert.deepEqual(await nativeDiagnostics(resource.data), []);
  const shot = resource.data.screenshots.find(item => item.number === 60) || resource.data.screenshots[0];
  shot.reviewStatus = 'issue'; shot.reviewNote = 'Native validator review edit fixture.';
  assert.deepEqual(await nativeDiagnostics(resource.data), []);
});
