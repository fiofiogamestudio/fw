import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { run } from '../bin/fwv.mjs';

const fwePath = process.env.FWV_TEST_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url));
async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'fwv-rig-editor-');
  const root = await fs.mkdtemp(prefix), project = new FwvProject(root);
  let editor;
  t.after(async () => {
    await editor?.close();
    assert.ok(root.startsWith(prefix) && path.dirname(root) === path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await project.init({ name: '立绘骨骼 HTTP 验收' });
  const buffer = await sharp({ create: { width: 120, height: 180, channels: 4, background: '#479da1' } }).png().toBuffer();
  const source = await project.importImage({ name: 'HTTP 部件像素来源', fileName: 'source.png', buffer });
  editor = await startEditor({ projectRoot: root, fwePath, port: 0 });
  const get = async route => {
    const response = await fetch(editor.url + route), body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  const session = await get('/api/fwv/session');
  const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWV-CSRF': session.csrfToken };
  const post = async (type, payload, requestHeaders = headers) => {
    const response = await fetch(editor.url + '/api/fwv/commands', { method: 'POST', headers: requestHeaders, body: JSON.stringify({ type, payload }) });
    return { status: response.status, body: await response.json() };
  };
  const command = async (type, payload) => {
    const result = await post(type, payload); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.result;
  };
  const input = { sourceAssetId: source.id, sourceRevisionId: source.selectedRevisionId, name: '可校正的人形草稿', preset: 'humanoid6' };
  return { root, project, editor, get, post, command, headers, input, source, buffer };
}

test('FWE image-to-rig builds real Spine resources, exports and starts a reskin plan without any generation jobs', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const app = await f.get('/api/app');
  const extension = app.extensions.find(item => item.url.includes('rig-panel.js'));
  assert.ok(extension); assert.equal((await fetch(f.editor.url + extension.url)).status, 200);
  const draft = await f.command('rig.create', f.input);
  assert.equal(draft.asset.kind, 'rig'); assert.equal(draft.revision.metadata.rig.parts.length, 6);
  const args = { assetId: draft.asset.id, revisionId: draft.revision.id };
  const loaded = await f.get('/api/fwv/rig/draft?' + new URLSearchParams(args));
  assert.deepEqual(loaded.document, draft.revision.metadata.rig);
  const built = await f.command('rig.build', args);
  assert.equal(built.asset.kind, 'spine');
  const jsonFile = built.revision.files.find(file => file.role === 'skeleton');
  const jsonBytes = (await f.project.readArtifact({ assetId: built.asset.id, revisionId: built.revision.id, fileName: jsonFile.name })).buffer;
  const skeleton = JSON.parse(jsonBytes);
  assert.equal(skeleton.slots.length, 6); assert.equal(skeleton.bones.length, 7);
  assert.deepEqual(Object.keys(skeleton.animations).sort(), ['idle', 'walk', 'wave']);
  const plan = await f.command('reskin.create', { templateAssetId: built.asset.id, templateRevisionId: built.revision.id, name: '由立绘开始换皮', brief: '保持体型，设计同风格的六部件角色。' });
  assert.equal(plan.parts.length, 6); assert.deepEqual(plan.attempts, []);
  const pkg = await f.command('asset.export', { assetId: built.asset.id, revisionId: built.revision.id });
  assert.deepEqual(await fs.readFile(path.join(f.root, pkg.path, 'resources', jsonFile.name)), jsonBytes);
  assert.deepEqual((await f.project.readArtifact({ assetId: f.source.id, revisionId: f.source.selectedRevisionId, fileName: 'source.png' })).buffer, f.buffer);
  assert.deepEqual((await f.get('/api/fwv/generation/jobs')).jobs, []);
});

test('rig writes require same-origin CSRF and reject unknown fields and malformed queries before persistence', { timeout: 30000 }, async t => {
  const f = await fixture(t), before = await f.project.snapshot();
  const noOrigin = { ...f.headers }; delete noOrigin.Origin;
  const noCsrf = { ...f.headers }; delete noCsrf['X-FWV-CSRF'];
  for (const headers of [noOrigin, noCsrf, { ...f.headers, Origin: 'https://untrusted.example' }]) assert.equal((await f.post('rig.create', f.input, headers)).status, 403);
  for (const [type, payload] of [['rig.create', { ...f.input, extra: true }], ['rig.create', null], ['rig.unknown', {}]]) assert.equal((await f.post(type, payload)).status, 400);
  for (const query of ['', '?assetId=a', '?assetId=a&revisionId=b&assetId=c', '?assetId=a&revisionId=b&extra=c']) assert.equal((await fetch(f.editor.url + '/api/fwv/rig/draft' + query)).status, 400);
  assert.deepEqual(await f.project.snapshot(), before);
});

test('rig HTTP saves preserve earlier annotations and refuse stale concurrent changes', { timeout: 30000 }, async t => {
  const f = await fixture(t), draft = await f.command('rig.create', f.input);
  const original = draft.revision.metadata.rig;
  const input = { assetId: draft.asset.id, revisionId: draft.revision.id, parts: structuredClone(original.parts), motion: original.motion };
  input.parts[0].pivot.x += 1;
  const results = await Promise.all([f.post('rig.save', input), f.post('rig.save', input)]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  const loaded = await f.get('/api/fwv/rig/draft?' + new URLSearchParams({ assetId: draft.asset.id, revisionId: draft.revision.id }));
  assert.deepEqual(loaded.document, original);
  const latest = results.find(item => item.status === 200).body.result;
  assert.equal(latest.revision.metadata.rig.parts[0].pivot.x, original.parts[0].pivot.x + 1);
  const invalid = { ...input, revisionId: latest.revision.id, parts: structuredClone(input.parts) };
  invalid.parts[0].parentId = invalid.parts[0].id;
  const before = await f.project.snapshot();
  assert.equal((await f.post('rig.save', invalid)).status, 400);
  assert.deepEqual(await f.project.snapshot(), before);
});

test('rig HTTP fork copies an exact historical version without selecting or overwriting its source', { timeout: 30000 }, async t => {
  const f = await fixture(t), draft = await f.command('rig.create', f.input);
  const reference = { assetId: draft.asset.id, revisionId: draft.revision.id }, original = draft.revision.metadata.rig;
  const latest = await f.command('rig.save', { ...reference, parts: original.parts, motion: { ...original.motion, wave: false } });
  const before = await f.project.snapshot();
  for (const [payload, headers, status] of [[{ ...reference, source: {} }, f.headers, 400], [reference, { ...f.headers, Origin: 'https://untrusted.example' }, 403], [{ ...reference, parts: [] }, f.headers, 400], [{ ...reference, parts: null }, f.headers, 400], [{ ...reference, motion: null }, f.headers, 400]]) {
    assert.equal((await f.post('rig.fork', payload, headers)).status, status);
  }
  assert.deepEqual(await f.project.snapshot(), before);
  const forked = await f.command('rig.fork', { ...reference, name: '从历史继续制作' });
  assert.notEqual(forked.asset.id, reference.assetId);
  assert.deepEqual(forked.revision.metadata.rig.forkedFrom, reference);
  assert.deepEqual(forked.revision.metadata.rig.parts, original.parts);
  assert.deepEqual(forked.revision.metadata.rig.motion, original.motion);
  assert.equal((await f.project.snapshot()).assets.find(item => item.id === reference.assetId).selectedRevisionId, latest.revision.id);
  const bytes = await f.project.readArtifact({ assetId: forked.asset.id, revisionId: forked.revision.id, fileName: original.source.referenceFile });
  assert.deepEqual(bytes.buffer, f.buffer);
});

test('rig CLI reuses saved annotation operations and rejects source mutation through annotation files', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const draft = await run(['rig-create', '--project', f.root, '--source-asset', f.source.id, '--source-revision', f.source.selectedRevisionId, '--name', 'CLI 拆件草稿']);
  const args = ['--project', f.root, '--asset', draft.asset.id, '--revision', draft.revision.id];
  const loaded = await run(['rig-inspect', ...args]);
  const edits = { parts: loaded.document.parts, motion: { idle: true, walk: false, wave: false } };
  const file = path.join(f.root, 'annotations.json');
  await fs.writeFile(file, JSON.stringify(edits));
  const saved = await run(['rig-save', ...args, '--file', file]);
  const built = await run(['rig-build', '--project', f.root, '--asset', draft.asset.id, '--revision', saved.revision.id]);
  const jsonFile = built.revision.files.find(item => item.role === 'skeleton');
  const json = JSON.parse((await f.project.readArtifact({ assetId: built.asset.id, revisionId: built.revision.id, fileName: jsonFile.name })).buffer);
  assert.deepEqual(Object.keys(json.animations), ['idle']);
  const before = await f.project.snapshot();
  await fs.writeFile(file, JSON.stringify({ ...edits, source: { fileName: 'other.png' } }));
  await assert.rejects(run(['rig-save', ...args, '--file', file]), /exactly parts and motion/);
  assert.deepEqual(await f.project.snapshot(), before);
});
