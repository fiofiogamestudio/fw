import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { FwvProject } from '../src/core/project.mjs';
import { AUTHORING_COLLECTIONS, MAX_AUTHORING_BYTES, readAuthoring, writeAuthoring, validateAuthoringData } from '../src/editor/authoring.mjs';
import { startEditor } from '../src/editor/server.mjs';

const moduleUrl = new URL('../src/editor/authoring.mjs', import.meta.url).href;
const fwePath = process.env.FWV_TEST_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url));
const require = createRequire(import.meta.url);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwv-authoring-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('fwv-authoring-'));
    await rm(root, { recursive: true, force: true });
  });
  const project = new FwvProject(root), snapshot = await project.init({ name: 'FWE 参数草稿测试' });
  const options = { projectRoot: root, expectedProjectId: snapshot.id };
  const resource = await readAuthoring(options);
  return { root, project, snapshot, options, resource, storage: path.join(root, '.fwv', 'editor-drafts.json') };
}

test('virtual authoring starts absent and save changes only authoring bytes with an exact returned revision', async t => {
  const { root, project, snapshot, options, resource, storage } = await fixture(t);
  assert.equal(resource.exists, false);
  assert.equal(resource.data.schemaVersion, 1);
  assert.equal(resource.data.projectId, snapshot.id);
  for (const collection of AUTHORING_COLLECTIONS) assert.deepEqual(resource.data[collection], []);
  assert.deepEqual(await readdir(root), ['fwv.project.json']);
  const originalManifest = await readFile(path.join(root, 'fwv.project.json'));
  const data = structuredClone(resource.data);
  data.reskinDrafts.push({ id: 'new', data: { name: '', brief: '森林游侠', style: '2D 手绘', mode: 'local', selected: ['head'], notes: { head: '橘色' }, transforms: {}, preserveAlpha: true } });
  data.rigDrafts.push({ id: 'new', data: { assetId: '', revisionId: '', document: null, saved: null, candidate: null, drawing: [], mode: 'draw' } });
  data.imageDrafts.push({ id: 'recipe', data: { assetId: 'asset', revisionId: 'rev', processingMode: 'append', recipe: { width: 0, height: 256, padding: 0, trim: true, background: 'transparent' } } });
  data.generationDrafts.push({ id: 'new', data: { prompt: '武器图标', size: '1024x1024', quality: 'auto', name: '', background: 'auto' } });
  data.spineDrafts.push({ id: 'new', data: { assetId: '', revisionId: '', regionName: 'head', transform: { scale: 1.25, offsetX: 2, offsetY: 0, rotation: 0, flipX: false }, animation: 'idle', skin: 'default', playing: true, time: 0 } });
  const saved = await writeAuthoring({ ...options, payload: { createOnly: true, data } });
  assert.match(saved.revision, /^fwv-drafts-sha256:[a-f0-9]{64}$/);
  const reopened = await readAuthoring(options);
  assert.equal(reopened.exists, true);
  assert.equal(reopened.revision, saved.revision);
  assert.deepEqual(reopened.data, data);
  assert.deepEqual(JSON.parse(await readFile(storage, 'utf8')), data);
  assert.deepEqual(await project.snapshot(), snapshot);
  assert.deepEqual(await readFile(path.join(root, 'fwv.project.json')), originalManifest);
  assert.deepEqual(await readdir(path.join(root, '.fwv')), ['editor-drafts.json']);
});

test('legacy five-collection drafts reopen with an empty asset-centre collection without rewriting bytes', async t => {
  const { options, resource, storage } = await fixture(t);
  const legacy = structuredClone(resource.data); delete legacy.changeDrafts;
  legacy.imageDrafts.push({ id: 'existing', data: { assetId: 'asset-old', revisionId: 'rev-old', processingMode: 'append', recipe: { width: 64, height: 64 } } });
  await fs.mkdir(path.dirname(storage), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(legacy)); await fs.writeFile(storage, bytes);
  const reopened = await readAuthoring(options);
  assert.deepEqual(reopened.data.changeDrafts, []); assert.deepEqual(reopened.data.imageDrafts, legacy.imageDrafts);
  assert.deepEqual(await fs.readFile(storage), bytes);
  reopened.data.changeDrafts.push({ id: 'new', data: { title: '可继续制作', region: { x: 1, y: 2, width: 3, height: 4 }, spineRepair: { boneName: 'body', x: 5, weight: .75 } } });
  await writeAuthoring({ ...options, payload: { data: reopened.data, revision: reopened.revision } });
  const saved = await readAuthoring(options);
  assert.equal(saved.data.changeDrafts[0].data.spineRepair.weight, .75); assert.deepEqual(saved.data.imageDrafts, legacy.imageDrafts);
});

test('authoring CAS requires createOnly for missing resources and detects raw byte changes', async t => {
  const { options, resource, storage } = await fixture(t);
  await assert.rejects(writeAuthoring({ ...options, payload: { data: resource.data } }), error => error.status === 409);
  const first = await writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } });
  await assert.rejects(writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } }), error => error.status === 409);
  await assert.rejects(writeAuthoring({ ...options, payload: { data: resource.data } }), error => error.status === 409);
  await writeFile(storage, JSON.stringify(resource.data));
  const reserialized = await readAuthoring(options);
  assert.deepEqual(reserialized.data, resource.data);
  assert.notEqual(reserialized.revision, first.revision);
  await assert.rejects(writeAuthoring({ ...options, payload: { revision: first.revision, data: resource.data } }), error => error.status === 409);
  const next = structuredClone(resource.data);
  next.generationDrafts.push({ id: 'new', data: { prompt: '已核对最新内容' } });
  const saved = await writeAuthoring({ ...options, payload: { revision: reserialized.revision, data: next } });
  assert.equal((await readAuthoring(options)).revision, saved.revision);
});

async function writer(t, options, label) {
  const source = `import { readAuthoring, writeAuthoring } from ${JSON.stringify(moduleUrl)};
    const options = JSON.parse(process.argv[1]);
    const resource = await readAuthoring(options);
    process.send({ ready: true });
    process.once('message', async () => {
      resource.data.generationDrafts = [{ id: 'new', data: { prompt: process.argv[2] } }];
      try { const result = await writeAuthoring({ ...options, payload: { data: resource.data, ...(resource.exists ? { revision: resource.revision } : { createOnly: true }) } }); process.send({ status: 200, revision: result.revision }); }
      catch (error) { process.send({ status: error.status || 500, message: error.message }); }
      process.disconnect();
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(options), label], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let readyResolve, resultResolve, rejectBoth;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; rejectBoth = reject; });
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve;
    child.once('error', error => { rejectBoth(error); reject(error); });
    child.once('exit', code => { if (code) { const error = new Error(`Writer exited ${code}: ${stderr}`); rejectBoth(error); reject(error); } });
  });
  child.on('message', message => { if (message.ready) readyResolve(); else resultResolve(message); });
  await ready;
  return { child, result };
}

for (const initiallyExists of [false, true]) test(`independent processes CAS the same ${initiallyExists ? 'existing' : 'missing'} authoring resource`, { timeout: 15000 }, async t => {
  const { options, resource } = await fixture(t);
  if (initiallyExists) await writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } });
  const workers = await Promise.all(['first writer', 'second writer'].map(label => writer(t, options, label)));
  for (const worker of workers) worker.child.send('save');
  const results = await Promise.all(workers.map(worker => worker.result));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const reopened = await readAuthoring(options), winnerIndex = results.findIndex(result => result.status === 200);
  assert.equal(reopened.revision, results[winnerIndex].revision);
  assert.equal(reopened.data.generationDrafts[0].data.prompt, ['first writer', 'second writer'][winnerIndex]);
});

test('exclusive authoring creation preserves an external process winner that ignores the FWV lock', { timeout: 15000 }, async t => {
  const { root, options, resource, storage } = await fixture(t);
  const externalData = structuredClone(resource.data);
  externalData.generationDrafts.push({ id: 'outside', data: { prompt: 'Created independently by another tool' } });
  const externalBytes = JSON.stringify(externalData), originalLink = fs.link;
  let externalCreated = false;
  fs.link = async (temporary, target) => {
    assert.equal(target, storage);
    assert.equal((await fs.stat(path.join(root, '.fwv.lock'))).isDirectory(), true);
    // Deterministically pause at the actual publication boundary, then let a
    // separate raw filesystem writer create the destination without taking the lock.
    const source = "import fs from 'node:fs/promises'; await fs.writeFile(process.argv[1],process.argv[2],{flag:'wx'});";
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, storage, externalBytes], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`External creator failed ${code}: ${stderr}`)));
    });
    externalCreated = true;
    return originalLink(temporary, target);
  };
  try {
    await assert.rejects(writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } }), error => error.status === 409);
  } finally { fs.link = originalLink; }
  assert.equal(externalCreated, true);
  assert.equal(await readFile(storage, 'utf8'), externalBytes);
  assert.deepEqual((await readAuthoring(options)).data, externalData);
  assert.deepEqual(await readdir(path.join(root, '.fwv')), ['editor-drafts.json']);
});

test('typed fields, collection identity, finite JSON limits and credential fields are enforced', async t => {
  const { options, resource } = await fixture(t);
  const invalid = [
    data => { data.projectId = 'another-project'; },
    data => { data.schemaVersion = 2; },
    data => { data.assets = []; },
    data => { delete data.rigDrafts; },
    data => { data.imageDrafts = [{ id: 'x', data: {} }, { id: 'x', data: {} }]; },
    data => { data.imageDrafts = [{ id: '', data: {} }]; },
    data => { data.generationDrafts = [{ id: 'x', data: { prompt: 12 } }]; },
    data => { data.reskinDrafts = [{ id: 'x', data: { mode: 'other' } }]; },
    data => { data.spineDrafts = [{ id: 'x', data: { transform: { scale: Infinity } } }]; },
    data => { data.rigDrafts = [{ id: 'x', data: { document: { api_key: 'do-not-persist' } } }]; },
    data => { data.rigDrafts = [{ id: 'x', data: { document: { Authorization: 'do-not-persist' } } }]; },
    data => { data.rigDrafts = [{ id: 'x', data: { document: { 'access-token': 'do-not-persist' } } }]; },
    data => { data.rigDrafts = [{ id: 'x', data: { document: JSON.parse('{"__proto__":{"polluted":true}}') } }]; },
    data => { data.imageDrafts = [{ id: 'x', data: { recipe: { width: '256' } } }]; },
    data => { data.imageDrafts = [{ id: 'x', data: { processingMode: 'unknown' } }]; },
    data => { data.generationDrafts = [{ id: 'x', data: { prompt: 'a'.repeat(32769) } }]; },
    data => { data.generationDrafts = Array.from({ length: 101 }, (_, id) => ({ id: String(id), data: {} })); },
    data => { const document = {}; document.self = document; data.rigDrafts = [{ id: 'x', data: { document } }]; },
    data => { data.generationDrafts = Array.from({ length: 100 }, (_, id) => ({ id: String(id), data: { prompt: 'a'.repeat(12000) } })); },
  ];
  for (const mutate of invalid) {
    const data = structuredClone(resource.data); mutate(data);
    assert.throws(() => validateAuthoringData(data, options.expectedProjectId), undefined, mutate.toString());
    await assert.rejects(writeAuthoring({ ...options, payload: { data, createOnly: true } }));
  }
  assert.equal((await readAuthoring(options)).exists, false);
});

test('existing corrupt, oversized or foreign-project drafts are retained and never silently reset', async t => {
  const { root, options, resource, storage } = await fixture(t);
  await writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } });
  for (const bytes of [Buffer.from('{broken'), Buffer.alloc(MAX_AUTHORING_BYTES + 1, 32), Buffer.from(JSON.stringify({ ...resource.data, projectId: 'foreign' }))]) {
    await writeFile(storage, bytes);
    await assert.rejects(readAuthoring(options));
    await assert.rejects(writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } }));
    assert.deepEqual(await readFile(storage), bytes);
  }
  await writeFile(storage, JSON.stringify(resource.data));
  const manifestPath = path.join(root, 'fwv.project.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, id: 'project_11111111111111111111111111111111' }));
  await assert.rejects(readAuthoring(options), error => error.status === 409);
  await assert.rejects(writeAuthoring({ ...options, payload: { revision: 'old', data: resource.data } }), error => error.status === 409);
});

test('rig authoring rejects shapes that cannot reopen but preserves unfinished canvas edits', async t => {
  const { options, resource } = await fixture(t);
  const document = { schemaVersion: 1,
    source: { assetId: 'asset_image', revisionId: 'rev_image', fileName: 'cat.png', referenceFile: 'rig-source.png', width: 400, height: 520 },
    parts: [{ id: 'head', name: '', role: 'head', parentId: null, polygon: [{ x: 10, y: 20 }, { x: 30, y: 10 }], pivot: { x: null, y: 60 } }],
    motion: { idle: true, walk: false, wave: true }, warnings: [] };
  const data = structuredClone(resource.data);
  data.rigDrafts.push({ id: 'rig', data: { assetId: 'rig', revisionId: 'revision', document: structuredClone(document), saved: structuredClone(document), drawing: [{ x: 12, y: 16 }, { x: 20, y: 24 }], mode: 'draw' } });
  const invalid = [
    item => { item.document = {}; },
    item => { delete item.document.parts; },
    item => { item.document.parts = {}; },
    item => { item.document.parts = [null]; },
    item => { item.document.parts[0].polygon = {}; },
    item => { item.document.parts[0].polygon = [null]; },
    item => { item.document.parts[0].polygon[0].x = '10'; },
    item => { item.document.parts[0].pivot = null; },
    item => { item.document.parts[0].pivot.x = ''; },
    item => { delete item.document.source; },
    item => { item.document.source.width = 0; },
    item => { item.document.source.width = '400'; },
    item => { delete item.document.source.referenceFile; },
    item => { delete item.document.motion; },
    item => { item.document.motion.walk = 'yes'; },
    item => { item.document.warnings = {}; },
    item => { item.document.warnings = [null]; },
    item => { item.saved = {}; },
    item => { item.drawing = [null]; },
    item => { item.drawing = [{ x: 1, y: '2' }]; },
  ];
  for (const mutate of invalid) {
    const broken = structuredClone(data); mutate(broken.rigDrafts[0].data);
    await assert.rejects(writeAuthoring({ ...options, payload: { createOnly: true, data: broken } }), undefined, mutate.toString());
  }
  assert.equal((await readAuthoring(options)).exists, false);
  const saved = await writeAuthoring({ ...options, payload: { createOnly: true, data } });
  const reopened = await readAuthoring(options);
  assert.deepEqual(reopened.data, data, 'An unfinished two-point polygon and cleared pivot stay recoverable.');
  const next = structuredClone(data);
  next.rigDrafts[0].data.document.parts = [];
  next.rigDrafts[0].data.drawing = [];
  await writeAuthoring({ ...options, payload: { revision: saved.revision, data: next } });
  assert.deepEqual((await readAuthoring(options)).data.rigDrafts[0].data.document.parts, [], 'An empty editable part list is not production-ready, but must remain saveable.');
});

test('real FWE Source loads typed collections, saves authoring with session lifecycle and preserves readonly asset source', async t => {
  const { root, options, project, snapshot } = await fixture(t);
  const editor = await startEditor({ projectRoot: root, fwePath, port: 0 });
  t.after(() => editor.close());
  const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWE-Session': 'fwv-authoring-test' };
  const route = `${editor.url}/api/domains/fwv-authoring/files/authoring.json`;
  const app = await fetch(`${editor.url}/api/app`).then(response => response.json());
  const domain = app.domains.find(domain => domain.id === 'fwv-authoring');
  assert.equal(domain.source.type, 'fwv-authoring');
  assert.equal(domain.model.root, '$');
  assert.deepEqual(domain.workbench.collections.map(collection => collection.id).sort(), [...AUTHORING_COLLECTIONS].sort());
  assert.deepEqual(domain.view.map(view => [view.title, view.layout]), [['美术工作台', 'fwv-workbench']]);
  const reskinFields = domain.inspector.forms.reskinDrafts.groups[0].fields.find(field => field.path === 'data').fields;
  assert.equal(reskinFields.find(field => field.path === 'brief').type, 'textarea');
  assert.equal(reskinFields.find(field => field.path === 'mode').type, 'select');
  for (const action of ['save', 'undo', 'redo']) assert.equal(domain.actions[action], true);
  for (const action of ['add', 'duplicate', 'delete', 'new']) assert.equal(domain.actions[action], false);
  const resourceResponse = await fetch(route, { headers });
  assert.equal(resourceResponse.status, 200);
  const initial = await resourceResponse.json();
  assert.equal(initial.exists, false);
  const data = initial.data;
  data.generationDrafts.push({ id: 'new', data: { name: '不会调用模型的草稿', prompt: '橘猫骑士' } });
  const response = await fetch(route, { method: 'PUT', headers, body: JSON.stringify({ createOnly: true, data }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.revision, (await readAuthoring(options)).revision);
  assert.deepEqual((await readAuthoring(options)).data, data);
  const conflictResponse = await fetch(route, { method: 'PUT', headers, body: JSON.stringify({ data, revision: initial.revision }) });
  assert.equal(conflictResponse.status, 409);
  for (const [override, expected] of [[{ Origin: 'https://example.com' }, 403], [{ 'X-FWE-Session': '' }, 403], [{ 'Content-Type': 'text/plain' }, 415]]) {
    const blocked = await fetch(route, { method: 'PUT', headers: { ...headers, ...override }, body: JSON.stringify({ data, revision: result.revision }) });
    assert.equal(blocked.status, expected);
  }
  const oldRoute = `${editor.url}/api/domains/fwv-project/files/fwv.project.json`;
  assert.equal((await fetch(oldRoute)).status, 200);
  assert.equal((await fetch(oldRoute, { method: 'PUT', headers, body: JSON.stringify({ data }) })).status, 405);
  assert.deepEqual(await project.snapshot(), snapshot);
  const jobs = await fetch(`${editor.url}/api/fwv/generation/jobs`).then(response => response.json());
  assert.deepEqual(jobs.jobs, []);
});

test('actual FWE client validation permits empty draft collections and still rejects invalid typed edits', async t => {
  const { resource } = await fixture(t);
  const fwe = require(path.join(fwePath, 'src', 'server.js'));
  const domain = fwe.loadAppConfig(fileURLToPath(new URL('../src/editor/app/fwe.app.json', import.meta.url))).domains.find(domain => domain.id === 'fwv-authoring');
  const source = await readFile(path.join(fwePath, 'public', 'app.js'), 'utf8');
  function functionSource(name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.notEqual(start, -1, `Missing FWE shell function ${name}`);
    const remaining = source.slice(start), next = remaining.search(/\n(?:async )?function /);
    return next < 0 ? remaining : remaining.slice(0, next);
  }
  const state = { domain, data: structuredClone(resource.data), serverDiagnostics: [] };
  const context = vm.createContext({ state, getAppLabel: (_key, fallback) => fallback });
  const functions = ['validateCurrent', 'validateObjectRule', 'validateUnique', 'pushDiagnostic', 'matchesType', 'mergeDiagnostics', 'getByPath', 'collectPathValues', 'formatPathParts', 'parsePathParts', 'ensureArray', 'formatAppLabel'];
  vm.runInContext(functions.map(functionSource).join('\n'), context);
  const diagnostics = () => structuredClone(vm.runInContext('validateCurrent()', context));
  assert.deepEqual(diagnostics(), [], 'A new project with five empty collections must be saveable.');
  state.data.reskinDrafts.push({ id: 'new', data: { name: '', brief: '测试草稿 B', style: '', mode: 'local', templateAssetId: '', templateRevisionId: '', selected: [], notes: {}, transforms: {}, attemptId: '', preserveAlpha: true } });
  state.data.generationDrafts.push({ id: 'new', data: { name: '图标草稿', prompt: '仅保存草稿', size: '1024x1024', quality: 'auto', background: 'auto', referenceAssetId: '', referenceRevisionId: '', referenceFileName: '' } });
  assert.deepEqual(diagnostics(), [], 'Other empty collections and optional empty strings must not block Ctrl+S.');
  state.data.rigDrafts.push({ id: 'new', data: { name: '', assetId: '', revisionId: '', document: null, saved: null, candidate: null, drawing: [], mode: 'draw' } });
  state.data.imageDrafts.push({ id: 'image', data: { assetId: '', revisionId: '', recipe: { width: 256, height: 256, padding: 0, trim: true, fit: 'contain', background: 'transparent' } } });
  state.data.spineDrafts.push({ id: 'spine', data: { assetId: '', revisionId: '', transform: { scale: 1, offsetX: 0, offsetY: 0, rotation: 0, flipX: false }, animation: '', skin: '', playing: false, time: 0 } });
  assert.deepEqual(diagnostics(), [], 'All five typed parameter shapes should pass the real client validator.');
  state.data.reskinDrafts[0].data.mode = 'unknown-mode';
  assert.ok(diagnostics().some(issue => issue.path === 'reskinDrafts[0].data.mode'));
  state.data.reskinDrafts[0].data.mode = 'local';
  state.data.imageDrafts[0].data.recipe.width = 'wrong-type';
  assert.ok(diagnostics().some(issue => issue.path === 'imageDrafts[0].data.recipe.width'));
  state.data.imageDrafts[0].data.recipe.width = 256;
  state.data.rigDrafts = Array.from({ length: 101 }, (_, index) => ({ id: String(index), data: {} }));
  assert.ok(diagnostics().some(issue => issue.path === 'rigDrafts'));
});
