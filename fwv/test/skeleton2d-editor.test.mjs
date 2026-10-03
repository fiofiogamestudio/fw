import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { createSkeleton2dDemo } from '../tools/create-skeleton2d-demo.mjs';

test('real FWE HTTP protects 2D reads/writes, rejects stale concurrent saves and exports exact revision', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-skeleton2d-http-'));
  const demo = await createSkeleton2dDemo(root), project = new FwvProject(root);
  const editor = await startEditor({ projectRoot: root, fwePath: process.env.FWV_TEST_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url)), port: 0 });
  t.after(async () => { await editor.close(); await fs.rm(root, { recursive: true, force: true }); });
  const { csrfToken } = await fetch(`${editor.url}/api/fwv/session`).then(response => response.json());
  const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWV-CSRF': csrfToken };
  const query = new URLSearchParams({ assetId: demo.assetId, revisionId: demo.revisionId });
  const load = FwvProject.prototype._load; let requestLoads = 0;
  const loadSpy = t.mock.method(FwvProject.prototype, '_load', async function (...args) { if (this.root === root) requestLoads++; return load.apply(this, args); });
  const response = await fetch(`${editor.url}/api/fwv/skeleton2d?${query}`);
  assert.equal(response.status, 200); const detail = await response.json();
  assert.equal(requestLoads, 1, 'one identity-checked manifest load supplies document and every PNG'); loadSpy.mock.restore();
  assert.equal(detail.document.format, 'fwd-skeleton2d'); assert.equal(detail.textureFiles.length, 2);
  assert.deepEqual(Object.keys(detail.textureData).sort(), ['rotor.png', 'tower.png']);
  for (const [fileName, texture] of Object.entries(detail.textureData)) {
    assert.equal(texture.mime, 'image/png');
    assert.deepEqual(Buffer.from(texture.base64, 'base64'), await fs.readFile(path.join(root, 'assets', demo.assetId, demo.revisionId, fileName)), 'embedded bytes match the exact immutable revision');
  }
  assert.equal((await fetch(`${editor.url}/api/fwv/skeleton2d?${query}`, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  const runtime = await fetch(`${editor.url}/api/fwv/skeleton2d-runtime`);
  assert.equal(runtime.status, 200); assert.match(runtime.headers.get('content-type'), /javascript/); assert.equal(runtime.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await runtime.text(), /export function sampleSkeleton2d/);
  assert.equal((await fetch(`${editor.url}/api/fwv/skeleton2d-runtime?module=../../secrets`)).status, 400);
  assert.equal((await fetch(`${editor.url}/api/fwv/skeleton2d?${query}&revisionId=${demo.revisionId}`)).status, 400);
  assert.equal((await fetch(`${editor.url}/api/fwv/skeleton2d?${query}&fileName=../../private`)).status, 400);
  const document = detail.document; document.skinBones = { summer: structuredClone(document.bones) }; document.skinBones.summer[1].y = 48;
  const payload = { assetId: demo.assetId, revisionId: demo.revisionId, expectedRevisionId: demo.revisionId, document };
  const body = JSON.stringify({ type: 'skeleton2d.save', payload });
  for (const override of [{ 'X-FWV-CSRF': '' }, { Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const denied = await fetch(`${editor.url}/api/fwv/commands`, { method: 'POST', headers: { ...headers, ...override }, body }); assert.equal(denied.status, 403);
  }
  assert.equal((await project.snapshot()).assets[0].revisions.length, 1);
  const saves = await Promise.all([1, 2].map(() => fetch(`${editor.url}/api/fwv/commands`, { method: 'POST', headers, body })));
  assert.deepEqual(saves.map(result => result.status).sort(), [200, 409]);
  const saved = (await saves.find(result => result.status === 200).json()).result;
  const original = await fetch(`${editor.url}/api/fwv/skeleton2d?${query}`).then(result => result.json());
  assert.equal(original.document.skinBones, undefined); assert.equal(original.selectedRevisionId, saved.selectedRevisionId);
  const exported = await fetch(`${editor.url}/api/fwv/commands`, { method: 'POST', headers, body: JSON.stringify({ type: 'skeleton2d.export', payload: { assetId: demo.assetId, revisionId: saved.selectedRevisionId } }) });
  assert.equal(exported.status, 200); const pkg = (await exported.json()).result;
  assert.equal(pkg.manifest.revisionId, saved.selectedRevisionId); assert.equal(pkg.manifest.validation.coverage, 'skeleton2d-and-files');
  const output = JSON.parse(await fs.readFile(path.join(root, pkg.path, 'resources', 'skeleton2d.json'), 'utf8')); assert.deepEqual(output, document);
});
