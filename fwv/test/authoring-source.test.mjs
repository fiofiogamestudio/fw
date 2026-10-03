import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { FwvProject } from '../src/core/project.mjs';
import { AUTHORING_COLLECTIONS, MAX_AUTHORING_BYTES, readAuthoring, writeAuthoring, validateAuthoringData } from '../src/editor/authoring.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { createSkeleton2dDemo } from '../tools/create-skeleton2d-demo.mjs';
import { importSkeleton2d } from '../src/skeleton2d/application.mjs';

const moduleUrl = new URL('../src/editor/authoring.mjs', import.meta.url).href;
const fwePath = process.env.FWV_TEST_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url));
const require = createRequire(import.meta.url);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-authoring-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('fwv-authoring-')); await fs.rm(root, { recursive: true, force: true }); });
  const project = new FwvProject(root), snapshot = await project.init({ name: '2D 草稿测试' });
  const options = { projectRoot: root, expectedProjectId: snapshot.id }, resource = await readAuthoring(options);
  return { root, project, snapshot, options, resource, storage: path.join(root, '.fwv', 'editor-drafts.json') };
}

test('only skeleton drafts are exposed and saves do not change the asset library', async t => {
  const { root, project, snapshot, options, resource, storage } = await fixture(t);
  assert.deepEqual(AUTHORING_COLLECTIONS, ['skeleton2dDrafts']); assert.equal(resource.exists, false);
  for (const key of AUTHORING_COLLECTIONS) assert.deepEqual(resource.data[key], []);
  assert.deepEqual(await fs.readdir(root), ['fwv.project.json']);
  const manifest = await fs.readFile(path.join(root, 'fwv.project.json')), data = structuredClone(resource.data);
  data.skeleton2dDrafts.push({ id: 'actor', data: { assetId: 'asset', revisionId: 'rev', skin: '', animation: '', speed: 1, time: 0 } });
  const saved = await writeAuthoring({ ...options, payload: { createOnly: true, data } });
  assert.match(saved.revision, /^fwv-drafts-sha256:[a-f0-9]{64}$/);
  const reopened = await readAuthoring(options); assert.equal(reopened.revision, saved.revision); assert.deepEqual(reopened.data, data);
  assert.deepEqual(JSON.parse(await fs.readFile(storage, 'utf8')), data); assert.deepEqual(await project.snapshot(), snapshot);
  assert.deepEqual(await fs.readFile(path.join(root, 'fwv.project.json')), manifest);
});

test('legacy workflow data is opaque, unchanged on read and preserved by active saves', async t => {
  const { options, resource, storage } = await fixture(t);
  const retired = { gallery2dDrafts: [{ id: 'view', data: { pageSize: 24, unknownFutureField: ['original gallery state'] } }], reskinDrafts: [{ id: 'retired', data: { brief: 'user notes', unknownFutureField: { keep: 5 } } }], rigDrafts: [{ raw: 'unvalidated historical geometry' }], imageDrafts: [{ recipe: { width: 17 } }], generationDrafts: [{ prompt: 'original user prompt' }], spineDrafts: [{ transforms: [1, 2, 3] }], changeDrafts: [{ reviews: [{ decision: 'accepted' }] }] };
  const disk = { schemaVersion: 1, projectId: resource.data.projectId, ...retired };
  await fs.mkdir(path.dirname(storage), { recursive: true }); const bytes = Buffer.from(JSON.stringify(disk)); await fs.writeFile(storage, bytes);
  const initial = await readAuthoring(options); assert.deepEqual(initial.data, resource.data); assert.deepEqual(await fs.readFile(storage), bytes);
  initial.data.skeleton2dDrafts.push({ id: 'new', data: { speed: 1, time: 0 } });
  await writeAuthoring({ ...options, payload: { data: initial.data, revision: initial.revision } });
  const saved = JSON.parse(await fs.readFile(storage, 'utf8'));
  for (const [key, value] of Object.entries(retired)) assert.deepEqual(saved[key], value, key);
  const current = await readAuthoring(options), stable = await fs.readFile(storage);
  for (const legacyKey of Object.keys(retired)) await assert.rejects(writeAuthoring({ ...options, payload: { data: { ...current.data, [legacyKey]: [] }, revision: current.revision } }), /未知字段/);
  assert.deepEqual(await fs.readFile(storage), stable);
  // A stale client cannot overwrite an independent modification to opaque data.
  saved.generationDrafts.push({ prompt: 'updated by another tool' }); await fs.writeFile(storage, JSON.stringify(saved));
  await assert.rejects(writeAuthoring({ ...options, payload: { data: current.data, revision: current.revision } }), error => error.status === 409);
});

test('opaque historical numbers that cannot round-trip reject saves without changing disk bytes', async t => {
  const { options, resource, storage } = await fixture(t);
  await fs.mkdir(path.dirname(storage), { recursive: true });
  for (const literal of ['1e400', '9007199254740993', '-9007199254740993', '1e-400', '0.10000000000000001', '1.0000000000000001', '-0']) {
    // An escaped top-level key and nested arrays remain opaque legacy fields.
    const bytes = Buffer.from(`{"schemaVersion":1,"projectId":${JSON.stringify(resource.data.projectId)},"gallery2d\\u0044rafts":[{"data":{"nested":[${literal}],"text":"1e400"}}]}`);
    await fs.writeFile(storage, bytes);
    const current = await readAuthoring(options); assert.deepEqual(current.data, resource.data);
    current.data.skeleton2dDrafts.push({ id: 'active', data: { time: 0.1, speed: 1.1 } });
    await assert.rejects(writeAuthoring({ ...options, payload: { data: current.data, revision: current.revision } }), error => error.status === 422 && error.code === 'AUTHORING_LEGACY_LOSSY', literal);
    assert.deepEqual(await fs.readFile(storage), bytes, literal);
  }
});

test('ordinary legacy decimals and equivalent exponent forms preserve active finite fractions', async t => {
  const { options, resource, storage } = await fixture(t);
  await fs.mkdir(path.dirname(storage), { recursive: true });
  const values = '[0.1,1.2300,1e20,1e-20,9007199254740992,0e400]';
  const bytes = Buffer.from(`{"schemaVersion":1,"projectId":${JSON.stringify(resource.data.projectId)},"gallery2dDrafts":[{"data":{"values":${values},"text":"9007199254740993"}}],"skeleton2dDrafts":[{"id":"active","data":{"time":0.10000000000000001,"speed":1.1}}]}`);
  await fs.writeFile(storage, bytes);
  const current = await readAuthoring(options); current.data.skeleton2dDrafts[0].data.time = 1 / 3;
  await writeAuthoring({ ...options, payload: { data: current.data, revision: current.revision } });
  const saved = JSON.parse(await fs.readFile(storage, 'utf8'));
  assert.deepEqual(saved.gallery2dDrafts, JSON.parse(bytes).gallery2dDrafts);
  assert.equal(saved.skeleton2dDrafts[0].data.time, 1 / 3);
});

test('2D drafts preserve valid documents above 1 MiB and enforce the 4 MiB document limit', async t => {
  const { options, resource, project, snapshot } = await fixture(t);
  const document = JSON.parse(await fs.readFile(new URL('../examples/skeleton2d/windmill.json', import.meta.url), 'utf8'));
  document.metadata = { productionNotes: 'a'.repeat(1200 * 1024) };
  const data = structuredClone(resource.data); data.skeleton2dDrafts.push({ id: 'large', data: { document, skin: 'summer', animation: 'turn', speed: 1, time: 0 } });
  await writeAuthoring({ ...options, payload: { createOnly: true, data } });
  assert.deepEqual((await readAuthoring(options)).data, data); assert.deepEqual(await project.snapshot(), snapshot);
  data.skeleton2dDrafts[0].data.document.metadata.productionNotes = 'a'.repeat(4 * 1024 * 1024);
  assert.throws(() => validateAuthoringData(data, snapshot.id), /4 MiB/);
});

test('many weighted character drafts round-trip when indentation alone would exceed 16 MiB', async t => {
  const { options, resource, project, snapshot, storage } = await fixture(t);
  const document = JSON.parse(await fs.readFile(new URL('../examples/skeleton2d/windmill.json', import.meta.url), 'utf8'));
  const mesh = { type: 'mesh', path: 'tower', width: 24, height: 64, uvs: [], vertices: [], triangles: [] };
  const side = 64;
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    mesh.uvs.push(x / (side - 1), y / (side - 1));
    // Both bone-local positions describe the same bind point, with two valid
    // influences per vertex rather than artificial metadata padding.
    mesh.vertices.push(2, 1, x / 4, y, 0.5, 2, x / 4, y - 32, 0.5);
    if (x < side - 1 && y < side - 1) {
      const index = y * side + x;
      mesh.triangles.push(index, index + 1, index + side, index + 1, index + side + 1, index + side);
    }
  }
  document.skins[0].attachments.tower.body = mesh;
  const data = structuredClone(resource.data);
  data.skeleton2dDrafts = Array.from({ length: 18 }, (_, index) => ({
    id: `character-${index}`, data: { document: structuredClone(document), skin: 'summer', animation: 'turn', time: index / 20, speed: 1 },
  }));
  const compactBytes = Buffer.byteLength(`${JSON.stringify(data)}\n`);
  const prettyBytes = Buffer.byteLength(`${JSON.stringify(data, null, 2)}\n`);
  assert.ok(compactBytes < MAX_AUTHORING_BYTES, `actual data must fit: ${compactBytes}`);
  assert.ok(prettyBytes > MAX_AUTHORING_BYTES, `indentation must reproduce the old failure: ${prettyBytes}`);
  const first = await writeAuthoring({ ...options, payload: { createOnly: true, data } });
  assert.equal((await fs.stat(storage)).size, compactBytes);
  const reopened = await readAuthoring(options);
  assert.equal(reopened.revision, first.revision);
  assert.deepEqual(reopened.data, data, 'every mesh weight, UV, triangle and animation survives the save');
  reopened.data.skeleton2dDrafts[17].data.document.bones[1].y = 33;
  const updated = await writeAuthoring({ ...options, payload: { revision: reopened.revision, data: reopened.data } });
  const latest = await readAuthoring(options);
  assert.equal(latest.revision, updated.revision);
  assert.notEqual(updated.revision, first.revision);
  assert.deepEqual(latest.data, reopened.data);
  assert.deepEqual(await project.snapshot(), snapshot, 'draft storage never changes immutable assets');
});

test('authoring CAS requires createOnly and detects even raw byte-only changes', async t => {
  const { options, resource, storage } = await fixture(t);
  await assert.rejects(writeAuthoring({ ...options, payload: { data: resource.data } }), error => error.status === 409);
  const first = await writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } });
  await assert.rejects(writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } }), error => error.status === 409);
  await assert.rejects(writeAuthoring({ ...options, payload: { data: resource.data } }), error => error.status === 409);
  await fs.writeFile(storage, JSON.stringify(resource.data)); const current = await readAuthoring(options);
  assert.deepEqual(current.data, resource.data); assert.notEqual(current.revision, first.revision);
  await assert.rejects(writeAuthoring({ ...options, payload: { revision: first.revision, data: resource.data } }), error => error.status === 409);
  current.data.skeleton2dDrafts.push({ id: 'latest', data: { skin: 'checked latest' } });
  const saved = await writeAuthoring({ ...options, payload: { revision: current.revision, data: current.data } }); assert.equal((await readAuthoring(options)).revision, saved.revision);
});

async function writer(t, options, label) {
  const source = `import { readAuthoring, writeAuthoring } from ${JSON.stringify(moduleUrl)};
    const options = JSON.parse(process.argv[1]); const resource = await readAuthoring(options); process.send({ ready: true });
    process.once('message', async () => { resource.data.skeleton2dDrafts = [{ id: 'actor', data: { skin: process.argv[2] } }];
      try { const result = await writeAuthoring({ ...options, payload: { data: resource.data, ...(resource.exists ? { revision: resource.revision } : { createOnly: true }) } }); process.send({ status: 200, revision: result.revision }); }
      catch (error) { process.send({ status: error.status || 500, message: error.message }); } process.disconnect(); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(options), label], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk); t.after(() => { if (child.exitCode === null) child.kill(); });
  let readyResolve, resultResolve, rejectBoth;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; rejectBoth = reject; });
  const result = new Promise((resolve, reject) => { resultResolve = resolve; child.once('error', error => { rejectBoth(error); reject(error); }); child.once('exit', code => { if (code) { const error = new Error(`Writer exited ${code}: ${stderr}`); rejectBoth(error); reject(error); } }); });
  child.on('message', message => { if (message.ready) readyResolve(); else resultResolve(message); }); await ready; return { child, result };
}
for (const initiallyExists of [false, true]) test(`independent processes CAS the same ${initiallyExists ? 'existing' : 'missing'} authoring resource`, { timeout: 15000 }, async t => {
  const { options, resource } = await fixture(t); if (initiallyExists) await writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } });
  const workers = await Promise.all(['first writer', 'second writer'].map(label => writer(t, options, label))); for (const worker of workers) worker.child.send('save');
  const results = await Promise.all(workers.map(worker => worker.result)); assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const reopened = await readAuthoring(options), winner = results.findIndex(result => result.status === 200);
  assert.equal(reopened.revision, results[winner].revision); assert.equal(reopened.data.skeleton2dDrafts[0].data.skin, ['first writer', 'second writer'][winner]);
});

test('exclusive creation preserves an external filesystem writer ignoring the project lock', async t => {
  const { root, options, resource, storage } = await fixture(t), externalData = structuredClone(resource.data);
  externalData.skeleton2dDrafts.push({ id: 'outside', data: { skin: 'independent writer' } });
  const externalBytes = JSON.stringify(externalData), originalLink = fs.link;
  fs.link = async (temporary, target) => {
    assert.equal(target, storage); assert.equal((await fs.stat(path.join(root, '.fwv.lock'))).isDirectory(), true);
    await fs.writeFile(target, externalBytes, { flag: 'wx' }); return originalLink(temporary, target);
  };
  try { await assert.rejects(writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } }), error => error.status === 409); } finally { fs.link = originalLink; }
  assert.equal(await fs.readFile(storage, 'utf8'), externalBytes); assert.deepEqual((await readAuthoring(options)).data, externalData);
  assert.deepEqual(await fs.readdir(path.join(root, '.fwv')), ['editor-drafts.json']);
});

test('active typed fields, finite data, credentials, ranges and unknown retired fields fail closed', async t => {
  const { options, resource } = await fixture(t);
  const mutations = [d => d.projectId = 'another', d => d.schemaVersion = 2, d => d.assets = [], d => delete d.skeleton2dDrafts,
    d => d.skeleton2dDrafts = [{ id: 'x', data: {} }, { id: 'x', data: {} }], d => d.skeleton2dDrafts = [{ id: '', data: {} }],
    d => d.skeleton2dDrafts = [{ id: 'x', data: { skin: 12 } }], d => d.skeleton2dDrafts = [{ id: 'x', data: { time: -1 } }],
    d => d.skeleton2dDrafts = [{ id: 'x', data: { speed: 5 } }], d => d.skeleton2dDrafts = [{ id: 'x', data: { time: Infinity } }],
    d => d.skeleton2dDrafts = [{ id: 'x', data: { channel: 'unknown' } }], d => d.skeleton2dDrafts = Array.from({ length: 201 }, (_, id) => ({ id: String(id), data: {} })),
    d => d.skeleton2dDrafts = [{ id: 'x', data: { document: { api_key: 'never persist' } } }],
    d => d.skeleton2dDrafts = [{ id: 'x', data: { document: JSON.parse('{"__proto__":{"polluted":true}}') } }],
    d => d.skeleton2dDrafts = [{ id: 'x', data: { speed: 0 } }], d => d.skeleton2dDrafts = [{ id: 'x', data: { channel: 'shear' } }],
    d => d.skeleton2dDrafts = [{ id: 'x', data: { document: {} } }], d => { const document = {}; document.self = document; d.skeleton2dDrafts = [{ id: 'x', data: { document } }]; },
    d => d.gallery2dDrafts = [], d => d.generationDrafts = []];
  for (const mutate of mutations) { const d = structuredClone(resource.data); mutate(d); assert.throws(() => validateAuthoringData(d, options.expectedProjectId)); await assert.rejects(writeAuthoring({ ...options, payload: { createOnly: true, data: d } })); }
  assert.equal((await readAuthoring(options)).exists, false);
});

test('corrupt oversized or foreign drafts are retained rather than reset', async t => {
  const { root, options, resource, storage } = await fixture(t); await writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } });
  for (const bytes of [Buffer.from('{broken'), Buffer.alloc(MAX_AUTHORING_BYTES + 1, 32), Buffer.from(JSON.stringify({ ...resource.data, projectId: 'foreign' })), Buffer.from(JSON.stringify({ ...resource.data, skeleton2dDrafts: null }))]) {
    await fs.writeFile(storage, bytes); await assert.rejects(readAuthoring(options)); await assert.rejects(writeAuthoring({ ...options, payload: { createOnly: true, data: resource.data } })); assert.deepEqual(await fs.readFile(storage), bytes);
  }
  await fs.writeFile(storage, JSON.stringify(resource.data)); const file = path.join(root, 'fwv.project.json'), manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...manifest, id: 'project_11111111111111111111111111111111' }));
  await assert.rejects(readAuthoring(options), error => error.status === 409);
});

test('real FWE Source saves typed skeleton drafts with session protection and no old source', async t => {
  const { root, options, project } = await fixture(t); await createSkeleton2dDemo(root);
  const snapshot = await project.snapshot(), editor = await startEditor({ projectRoot: root, fwePath, port: 0 }); t.after(() => editor.close());
  const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWE-Session': 'fwv-2d-test' }, route = `${editor.url}/api/domains/fwv-authoring/files/authoring.json`;
  const app = await fetch(`${editor.url}/api/app`).then(response => response.json()), domain = app.domains.find(entry => entry.id === 'fwv-authoring');
  assert.equal(app.domains.length, 2); assert.equal(domain.source.type, 'fwv-authoring'); assert.equal(domain.model.root, '$');
  assert.deepEqual(domain.workbench.collections.map(item => item.id), ['skeleton2dDrafts']);
  for (const action of ['save', 'undo', 'redo']) assert.equal(domain.actions[action], true);
  for (const action of ['add', 'duplicate', 'delete', 'new']) assert.equal(domain.actions[action], false);
  const initial = await fetch(route, { headers }).then(response => response.json()), data = initial.data; data.skeleton2dDrafts[0].data.time = 0; data.skeleton2dDrafts[0].data.speed = 1;
  const response = await fetch(route, { method: 'PUT', headers, body: JSON.stringify({ createOnly: true, data }) }), result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.revision, (await readAuthoring(options)).revision);
  assert.deepEqual((await readAuthoring(options)).data, { ...data, skeleton2dDrafts: data.skeleton2dDrafts.map(({ id, data }) => ({ id, data })) });
  assert.equal((await fetch(route, { method: 'PUT', headers, body: JSON.stringify({ data, revision: initial.revision }) })).status, 409);
  for (const [override, expected] of [[{ Origin: 'https://example.com' }, 403], [{ 'X-FWE-Session': '' }, 403], [{ 'Content-Type': 'text/plain' }, 415]]) assert.equal((await fetch(route, { method: 'PUT', headers: { ...headers, ...override }, body: JSON.stringify({ data, revision: result.revision }) })).status, expected);
  assert.equal((await fetch(`${editor.url}/api/domains/fwv-project/files/fwv.project.json`)).status, 404); assert.deepEqual(await project.snapshot(), snapshot);
});

test('real FWE saves drafts above 8 MiB without weakening the 16 MiB semantic limit', async t => {
  const { root, options, project, storage } = await fixture(t), demo = await createSkeleton2dDemo(root);
  const document = JSON.parse(await fs.readFile(new URL('../examples/skeleton2d/windmill.json', import.meta.url), 'utf8'));
  const textures = await Promise.all(['tower.png', 'rotor.png'].map(async name => ({ name, buffer: (await project.readArtifact({ assetId: demo.assetId, revisionId: demo.revisionId, fileName: name })).buffer })));
  for (let i = 0; i < 4; i++) await importSkeleton2d(project, { name: `Body limit example ${i}`, document, textures });
  const snapshot = await project.snapshot(), editor = await startEditor({ projectRoot: root, fwePath, port: 0 }); t.after(() => editor.close());
  const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWE-Session': 'large-draft-test' }, route = `${editor.url}/api/domains/fwv-authoring/files/authoring.json`;
  const initial = await fetch(route, { headers }).then(response => response.json()), data = initial.data;
  for (const row of data.skeleton2dDrafts.slice(0, 3)) row.data.document = { ...document, metadata: { notes: '汉'.repeat(1024 * 1024) } };
  const body = JSON.stringify({ createOnly: true, data }); assert.ok(Buffer.byteLength(body) > 8 * 1024 * 1024);
  const response = await fetch(route, { method: 'PUT', headers, body }), result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const saved = await readAuthoring(options); assert.equal(saved.data.skeleton2dDrafts.length, 3); assert.equal(saved.data.skeleton2dDrafts[0].data.document.metadata.notes, '汉'.repeat(1024 * 1024));
  const stable = await fs.readFile(storage);
  for (const row of data.skeleton2dDrafts) row.data.document = { ...document, metadata: { notes: 'x'.repeat(Math.ceil(3.3 * 1024 * 1024)) } };
  const oversized = JSON.stringify({ revision: result.revision, data });
  assert.ok(Buffer.byteLength(oversized) > MAX_AUTHORING_BYTES); assert.ok(Buffer.byteLength(oversized) < 17 * 1024 * 1024);
  const refused = await fetch(route, { method: 'PUT', headers, body: oversized });
  assert.equal(refused.status, 413); assert.match((await refused.json()).error, /16 MiB/);
  assert.deepEqual(await fs.readFile(storage), stable); assert.deepEqual(await project.snapshot(), snapshot);
});

test('real FWE client validation accepts empty active data and rejects malformed 2D edits', async t => {
  const { resource } = await fixture(t), fwe = require(path.join(fwePath, 'src', 'server.js'));
  const domain = fwe.loadAppConfig(fileURLToPath(new URL('../src/editor/app/fwe.app.json', import.meta.url))).domains.find(entry => entry.id === 'fwv-authoring'), source = await fs.readFile(path.join(fwePath, 'public', 'app.js'), 'utf8');
  function functionSource(name) { const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); assert.notEqual(start, -1); const remaining = source.slice(start), next = remaining.search(/\n(?:async )?function /); return next < 0 ? remaining : remaining.slice(0, next); }
  const state = { domain, data: structuredClone(resource.data), serverDiagnostics: [] }, context = vm.createContext({ state, getAppLabel: (_key, fallback) => fallback });
  vm.runInContext(['validateCurrent', 'validateObjectRule', 'validateUnique', 'pushDiagnostic', 'matchesType', 'mergeDiagnostics', 'getByPath', 'collectPathValues', 'formatPathParts', 'parsePathParts', 'ensureArray', 'formatAppLabel'].map(functionSource).join('\n'), context);
  const diagnostics = () => structuredClone(vm.runInContext('validateCurrent()', context)); assert.deepEqual(diagnostics(), []);
  state.data.skeleton2dDrafts.push({ id: 'actor', data: { time: 0, speed: 1 } }); assert.deepEqual(diagnostics(), []);
  state.data.skeleton2dDrafts[0].data.speed = 'wrong'; assert.ok(diagnostics().some(issue => issue.path === 'skeleton2dDrafts[0].data.speed'));
});
