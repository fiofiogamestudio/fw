import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { MAX_BODY_BYTES } from '../src/editor/api.mjs';

const fwePath = process.env.FWV_TEST_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url));
async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'fwv-editor-');
  const root = await mkdtemp(prefix);
  const project = new FwvProject(root);
  await project.init({ name: '编辑器验收项目' });
  const editor = await startEditor({ projectRoot: root, fwePath, port: 0 });
  t.after(async () => {
    await editor.close();
    assert.ok(root.startsWith(prefix) && path.dirname(root) === path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const sessionResponse = await fetch(`${editor.url}/api/fwv/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWV-CSRF': session.csrfToken };
  const command = async (type, payload) => {
    const response = await fetch(`${editor.url}/api/fwv/commands`, { method: 'POST', headers, body: JSON.stringify({ type, payload }) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value.result;
  };
  return { root, project, editor, session, headers, command };
}

test('real FWE serves registered workbench and only fixed project resources', async t => {
  const { editor, session } = await fixture(t);
  assert.equal(session.protocol, 'fwv-workbench-v1');
  const html = await fetch(editor.url).then(response => response.text());
  assert.match(html, /documentTree/);
  const app = await fetch(`${editor.url}/api/app`).then(response => response.json());
  assert.equal(app.id, 'fwv-workbench');
  assert.equal(app.domains[0].source.type, 'fwv-project');
  const uiResponse = await fetch(`${editor.url}/api/fwv/ui`);
  assert.equal(uiResponse.status, 200);
  const ui = await uiResponse.json();
  assert.deepEqual(Object.keys(ui).sort(), ['assets', 'generation', 'image', 'model3d', 'preview', 'reskin', 'rig', 'spine', 'spineRepair', 'workbench']);
  assert.equal(ui.generation.fields.prompt.schemaPath, 'generationDrafts[].data.prompt');
  assert.equal(ui.generation.fields.prompt.maxLength, undefined);
  assert.equal(ui.image.fields.fit.schemaPath, 'imageDrafts[].data.recipe.fit');
  for (const extension of app.extensions) {
    const response = await fetch(editor.url + extension.url);
    assert.equal(response.status, 200, extension.url);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.ok((await response.text()).length > 50);
  }
  const resources = await fetch(`${editor.url}/api/domains/fwv-project/files`).then(response => response.json());
  assert.equal(resources.files.length, 1);
  assert.equal(resources.files[0].name, 'fwv.project.json');
  const fixed = await fetch(`${editor.url}/api/domains/fwv-project/files/fwv.project.json`);
  assert.equal(fixed.status, 200);
  for (const route of ['/api/domains/fwv-project/files/package.json', '/api/domains/other/files', '/api/extensions/unknown/secret.js', '/api/fwv/artifact?path=C%3A%5CWindows%5Cwin.ini']) {
    const response = await fetch(editor.url + route);
    assert.ok([400, 404].includes(response.status), `${route}: ${response.status}`);
  }
});

test('image import, process, validate, export and historical selection persist through reopening', async t => {
  const { editor, project, root, command } = await fixture(t);
  const buffer = await sharp({ create: { width: 12, height: 10, channels: 4, background: '#ff7733' } }).png().toBuffer();
  const imported = await command('image.import', { fileName: 'sample.png', name: '测试图标', base64: buffer.toString('base64') });
  const originalId = imported.selectedRevisionId;
  const processed = await command('image.process', { assetId: imported.id, revisionId: originalId,
    recipe: { width: 64, height: 64, padding: 8, trim: true, fit: 'contain', background: 'transparent' } });
  const processedId = processed.selectedRevisionId;
  assert.equal(processed.revisions.length, 2);
  assert.equal(processed.revisions[1].parentId, originalId);
  const query = new URLSearchParams({ assetId: imported.id, revisionId: processedId, fileName: 'image.png' });
  const response = await fetch(`${editor.url}/api/fwv/artifact?${query}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const resultImage = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.equal(resultImage.width, 64); assert.equal(resultImage.height, 64);
  const validation = await command('revision.validate', { assetId: imported.id, revisionId: processedId });
  assert.equal(validation.status, 'passed'); assert.equal(validation.scope, 'technical');
  assert.equal(validation.humanAcceptance, 'not-reviewed');
  const exported = await command('asset.export', { assetId: imported.id, revisionId: processedId });
  const manifest = JSON.parse(await readFile(path.join(root, exported.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.revisionId, processedId);
  assert.equal(manifest.validation.humanAcceptance, 'not-reviewed');
  assert.equal((await sharp(await readFile(path.join(root, exported.path, 'resources', 'image.png'))).metadata()).width, 64);
  await command('revision.select', { assetId: imported.id, revisionId: originalId });
  const reopened = await new FwvProject(root).snapshot();
  assert.equal(reopened.assets[0].selectedRevisionId, originalId);
  assert.equal(reopened.assets[0].revisions.length, 2);
  assert.deepEqual(await project.readArtifact({ assetId: imported.id, revisionId: originalId, fileName: 'sample.png' }).then(item => item.buffer), buffer);
  await editor.close();
  const restarted = await startEditor({ projectRoot: root, fwePath, port: 0 });
  try {
    const snapshot = await fetch(`${restarted.url}/api/fwv/snapshot`).then(res => res.json());
    assert.equal(snapshot.assets[0].selectedRevisionId, originalId);
    assert.equal(snapshot.exports.length, 1);
  } finally { await restarted.close(); }
});

test('host, origin, CSRF, generic writes and invalid commands fail before mutations', async t => {
  const { editor, headers, project } = await fixture(t);
  const body = JSON.stringify({ type: 'image.import', payload: { fileName: 'bad.png', base64: 'ZmFrZQ==' } });
  for (const [overrides, expected] of [
    [{ Origin: 'https://example.com' }, 403], [{ 'X-FWV-CSRF': '' }, 403],
    [{ Origin: '' }, 403], [{ 'Content-Type': 'text/plain' }, 415], [{ 'Sec-Fetch-Site': 'cross-site' }, 403]
  ]) {
    const response = await fetch(`${editor.url}/api/fwv/commands`, { method: 'POST', headers: { ...headers, ...overrides }, body });
    assert.equal(response.status, expected, JSON.stringify(overrides));
  }
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${editor.url}/api/fwv/snapshot`, { headers: { Host: 'attacker.invalid' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  for (const [route, method] of [['/api/domains/fwv-project/files', 'POST'], ['/api/domains/fwv-project/files/fwv.project.json', 'PUT'], ['/api/domains/fwv-project/files/fwv.project.json', 'DELETE'], ['/api/app/stop', 'POST']]) {
    const response = await fetch(editor.url + route, { method, headers, body: '{}' });
    assert.equal(response.status, 405, route);
  }
  for (const invalidBody of [
    '{', JSON.stringify({ type: 'image.import', payload: { fileName: 'a.png', base64: '!!!!' } }),
    JSON.stringify({ type: 'image.import', payload: { fileName: '../escape.png', base64: 'ZmFrZQ==' } }),
    JSON.stringify({ type: 'image.import', payload: { fileName: 'a.png', base64: 'ZmFrZQ==', projectRoot: 'elsewhere' } }),
    JSON.stringify({ type: 'file.write', payload: { path: 'secret.txt' } })
  ]) {
    const response = await fetch(`${editor.url}/api/fwv/commands`, { method: 'POST', headers, body: invalidBody });
    assert.equal(response.status, 400);
  }
  assert.equal((await project.snapshot()).assets.length, 0);
});

test('oversized command is rejected by content length without allocating the upload', async t => {
  const { editor, headers } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${editor.url}/api/fwv/commands`, { method: 'POST',
      headers: { ...headers, 'Content-Length': MAX_BODY_BYTES + 1 } }, res => {
      res.resume(); res.on('end', () => { resolve(res.statusCode); req.destroy(); });
    });
    req.on('error', reject); req.write('{}');
  });
  assert.equal(status, 413);
});

test('artifact tampering fails closed and project identity change stops commands', async t => {
  const { project, root, editor, command, headers } = await fixture(t);
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#44aa88' } }).png().toBuffer();
  const asset = await command('image.import', { fileName: 'sample.png', base64: buffer.toString('base64') });
  await writeFile(path.join(root, 'assets', asset.id, asset.selectedRevisionId, 'sample.png'), Buffer.alloc(buffer.length));
  const query = new URLSearchParams({ assetId: asset.id, revisionId: asset.selectedRevisionId, fileName: 'sample.png' });
  assert.equal((await fetch(`${editor.url}/api/fwv/artifact?${query}`)).status, 400);
  const snapshot = await project.snapshot(); snapshot.id = `project_${'0'.repeat(32)}`;
  await writeFile(path.join(root, 'fwv.project.json'), JSON.stringify(snapshot));
  const response = await fetch(`${editor.url}/api/fwv/commands`, { method: 'POST', headers,
    body: JSON.stringify({ type: 'revision.select', payload: { assetId: asset.id, revisionId: asset.selectedRevisionId } }) });
  assert.equal(response.status, 409);
});

test('editor requires explicit compatible FWE and a valid port', async () => {
  await assert.rejects(startEditor({ projectRoot: '.', fwePath: 'fwe' }), /绝对路径/);
  await assert.rejects(startEditor({ projectRoot: '.', fwePath, port: -1 }), /端口/);
});
