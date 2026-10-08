import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CaptureWorkspace } from '../ui/core/workspace.mjs';
import { validateManifest } from '../ui/core/manifest.mjs';
import { startUiServer, DEFAULT_FWE_PATH } from '../ui/server.mjs';
import { parseUiArguments, runUi } from '../ui/cli.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1z8AAAAASUVORK5CYII=', 'base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const fwePath = process.env.FWV_TEST_FWE_PATH || DEFAULT_FWE_PATH;
async function fixture(t, serve = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-ui-server-'));
  const manifestPath = path.join(root, 'capture.json');
  await fs.mkdir(path.join(root, 'images'));
  await fs.writeFile(path.join(root, 'images', 'first.png'), PNG);
  const manifest = { schemaVersion: 1, title: 'UI test fixture', project: 'synthetic-test',
    run: { id: 'test-run', capturedAt: '2026-10-08T00:00:00Z', evidence: 'Synthetic PNG for backend tests; not GPU evidence.' },
    screenshots: [{ id: 'first', number: 7, title: 'First', category: 'menu', path: 'images/first.png', width: 1, height: 1, sha256: sha(PNG), bytes: PNG.length }],
    coverage: [{ id: 'menu', title: 'Menu', status: 'captured', screenshotIds: ['first'] }, { id: 'missing', title: 'Unreachable', status: 'blocked', screenshotIds: [], reason: 'No runtime in this fixture.' }] };
  const bytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(manifestPath, bytes);
  let editor;
  t.after(async () => {
    await editor?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('fwv-ui-server-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  if (serve) editor = await startUiServer({ manifestPath, fwePath, port: 0 });
  const workspace = editor?.workspace || await CaptureWorkspace.open(manifestPath);
  return { root, manifestPath, manifest, bytes, workspace, editor };
}

test('catalog annotations persist across reopen, reject stale windows and never change evidence', async t => {
  const f = await fixture(t), a = await f.workspace.catalog(), b = await f.workspace.catalog();
  assert.equal(a.data.coverage[0].category, 'menu'); assert.equal(a.data.coverage[1].category, '未分类');
  a.data.screenshots[0].reviewStatus = 'issue'; a.data.screenshots[0].reviewNote = '按钮文字被裁切';
  a.data.screenshots[0].title = 'attempt to rewrite immutable metadata'; a.data.coverage[0].status = 'excluded';
  await f.workspace.saveCatalog({ data: a.data, revision: a.revision });
  await assert.rejects(() => f.workspace.saveCatalog({ data: b.data, revision: b.revision }), { status: 409 });
  const reopened = await CaptureWorkspace.open(f.manifestPath), current = await reopened.catalog();
  assert.equal(current.data.screenshots[0].reviewNote, '按钮文字被裁切');
  assert.equal(current.data.screenshots[0].title, 'First'); assert.equal(current.data.coverage[0].status, 'captured');
  const sidecar = JSON.parse(await fs.readFile(path.join(f.root, 'review.json')));
  assert.deepEqual(Object.keys(sidecar.annotations.first).sort(), ['note', 'status']); assert.equal(sidecar.revision, 1);
  assert.deepEqual(await fs.readFile(f.manifestPath), f.bytes); assert.deepEqual(await fs.readFile(path.join(f.root, 'images/first.png')), PNG);
  await assert.rejects(() => reopened.saveCatalog({ data: { ...current.data, screenshots: [] }, revision: current.revision }), /remove capture/);
  await assert.rejects(() => reopened.review.write({ expectedRevision: 1, annotations: { unknown: { status: 'accepted', note: '' } } }), /Unknown screenshot/);
});

test('cross-process lock and revision conflicts leave the existing review intact', async t => {
  const f = await fixture(t), first = { first: { status: 'accepted', note: 'Reviewed' } };
  await f.workspace.review.write({ expectedRevision: 0, annotations: first });
  const previous = await fs.readFile(path.join(f.root, 'review.json'));
  await fs.writeFile(path.join(f.root, 'review.json.lock'), 'another-process');
  await assert.rejects(() => f.workspace.review.write({ expectedRevision: 1, annotations: {} }), { status: 423 });
  await fs.unlink(path.join(f.root, 'review.json.lock'));
  const secondProcess = await CaptureWorkspace.open(f.manifestPath);
  const results = await Promise.allSettled([f.workspace.review.write({ expectedRevision: 1, annotations: first }), secondProcess.review.write({ expectedRevision: 1, annotations: {} })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok([409, 423].includes(results.find(result => result.status === 'rejected').reason.status));
  assert.equal((await f.workspace.review.read()).revision, 2);
  assert.equal(JSON.parse(previous).revision, 1);
  assert.deepEqual((await fs.readdir(f.root)).filter(name => /\.tmp$|\.lock$/.test(name)), []);
});

test('media is pinned by ID, realpath and hash, including replacement after server startup', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.workspace.media('first')).bytes, PNG);
  await assert.rejects(() => f.workspace.media('../capture.json'), { status: 404 });
  const image = path.join(f.root, 'images/first.png'), altered = Buffer.from(PNG); altered[altered.length - 1] ^= 1;
  await fs.writeFile(image, altered); await assert.rejects(() => f.workspace.media('first'), { status: 409 });
  await fs.writeFile(image, PNG);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'first.png'), PNG);
  await fs.rename(path.join(f.root, 'images'), path.join(f.root, 'original-images'));
  await fs.symlink(outside, path.join(f.root, 'images'), process.platform === 'win32' ? 'junction' : 'dir');
  // An in-root link still refers to the same validated bytes and is allowed.
  assert.deepEqual((await f.workspace.media('first')).bytes, PNG);
  await fs.unlink(path.join(f.root, 'images'));
  const sibling = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-ui-outside-'));
  try {
    await fs.writeFile(path.join(sibling, 'first.png'), PNG); await fs.symlink(sibling, path.join(f.root, 'images'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => f.workspace.media('first'), { status: 403 });
    await fs.unlink(path.join(f.root, 'images'));
  } finally { assert.equal(path.dirname(sibling), path.resolve(os.tmpdir())); assert.ok(path.basename(sibling).startsWith('fwv-ui-outside-')); await fs.rm(sibling, { recursive: true, force: true }); }
});

test('declared hashes and byte counts are verified; changed capture blocks all subsequent saves', async t => {
  const f = await fixture(t);
  f.manifest.screenshots[0].sha256 = '0'.repeat(64); await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(() => validateManifest(f.manifestPath), /SHA-256/);
  await assert.rejects(() => f.workspace.catalog(), { status: 409 });
  f.manifest.screenshots[0].sha256 = sha(PNG); f.manifest.screenshots[0].bytes = PNG.length + 1;
  await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest)); await assert.rejects(() => validateManifest(f.manifestPath), /byte size/);
});

test('real FWE serves catalog, original PNG, durable native saves and self-contained offline download', async t => {
  const f = await fixture(t, true), base = f.editor.url;
  const app = await fetch(base + '/api/app').then(r => r.json());
  assert.equal(app.id, 'fwv-ui-capture'); assert.equal(app.domains[0].source.type, 'fwv-ui-capture');
  for (const extension of app.extensions) assert.equal((await fetch(base + extension.url)).status, 200);
  const route = '/api/domains/fwv-ui-capture/files/catalog.json';
  const resource = await fetch(base + route).then(r => r.json());
  assert.equal(resource.data.screenshots[0].number, 7);
  assert.deepEqual(Buffer.from(await fetch(base + resource.data.screenshots[0].imageUrl).then(r => r.arrayBuffer())), PNG);
  resource.data.screenshots[0].reviewNote = '持续保存的备注'; resource.data.screenshots[0].reviewStatus = 'issue';
  const saveHeaders = { Origin: base, 'Content-Type': 'application/json', 'X-FWE-Session': 'ui-test-session' };
  const save = await fetch(base + route, { method: 'PUT', headers: saveHeaders, body: JSON.stringify({ data: resource.data, revision: resource.revision }) });
  assert.equal(save.status, 200, await save.text());
  const stale = await fetch(base + route, { method: 'PUT', headers: saveHeaders, body: JSON.stringify({ data: resource.data, revision: resource.revision }) });
  assert.equal(stale.status, 409);
  const review = await fetch(base + '/api/fwv/ui-capture/review').then(r => r.json()); assert.equal(review.annotations.first.note, '持续保存的备注');
  const exported = await fetch(base + '/api/fwv/ui-capture/export'); assert.equal(exported.status, 200); assert.match(exported.headers.get('content-disposition'), /attachment/);
  const html = await exported.text(); assert.ok(html.includes('data:image/png;base64,' + PNG.toString('base64'))); assert.ok(html.includes('持续保存的备注'));
  assert.ok(!html.includes('__CAPTURE_DATA_JSON__')); assert.deepEqual(await fs.readFile(f.manifestPath), f.bytes);
});

test('HTTP origin, CSRF, bounded body and fixed routes prevent unintended reads and writes', async t => {
  const f = await fixture(t, true), base = f.editor.url, endpoint = '/api/fwv/ui-capture/review';
  const session = await fetch(base + '/api/fwv/ui-capture/session').then(r => r.json());
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-FWV-CSRF': session.csrfToken };
  const body = JSON.stringify({ expectedRevision: 0, annotations: { first: { status: 'accepted', note: '' } } });
  for (const [change, expected] of [[{ Origin: 'https://example.org' }, 403], [{ 'X-FWV-CSRF': '' }, 403], [{ 'Content-Type': 'text/plain' }, 415], [{ 'Sec-Fetch-Site': 'cross-site' }, 403]]) {
    assert.equal((await fetch(base + endpoint, { method: 'PUT', headers: { ...headers, ...change }, body })).status, expected);
  }
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(base + endpoint, { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
  }); assert.equal(hostStatus, 403);
  for (const route of ['/api/fwv/image?file=secret', '/api/domains/other/files', '/api/fwv/ui-capture/media?id=first&path=../secret'])
    assert.ok([400, 404].includes((await fetch(base + route)).status));
  assert.equal((await fetch(base + '/api/fwv/ui-capture/media?id=unknown')).status, 404);
  assert.equal((await fetch(base + endpoint, { method: 'POST', headers, body })).status, 405);
  const oversized = JSON.stringify({ expectedRevision: 0, annotations: {}, padding: 'x'.repeat(4 * 1024 * 1024) });
  assert.equal((await fetch(base + endpoint, { method: 'PUT', headers, body: oversized })).status, 413);
  assert.equal((await fetch(base + endpoint, { method: 'PUT', headers, body })).status, 200);
  assert.deepEqual(await fs.readFile(f.manifestPath), f.bytes);
});

test('CLI uses the sibling FWE path, validates without runtime, and exports current review', async t => {
  const f = await fixture(t);
  assert.equal(DEFAULT_FWE_PATH.replace(/[\\/]$/, ''), fileURLToPath(new URL('../../fwe', import.meta.url)));
  assert.equal(parseUiArguments(['--manifest', f.manifestPath]).command, 'serve');
  assert.equal((await runUi(['validate', '--manifest', f.manifestPath])).summary.screenshots, 1);
  const initialOut = path.join(f.root, 'initial-offline');
  await runUi(['export', '--manifest', f.manifestPath, '--out', initialOut]);
  const initialReopened = await CaptureWorkspace.open(path.join(initialOut, 'capture.json'));
  assert.equal((await initialReopened.review.read()).revision, 0);
  await initialReopened.review.write({ expectedRevision: 0, annotations: { first: { status: 'accepted', note: 'first exported edit' } } });
  assert.equal((await initialReopened.review.read()).revision, 1);
  await f.workspace.review.write({ expectedRevision: 0, annotations: { first: { status: 'issue', note: 'export this note' } } });
  const sourceReview = await fs.readFile(path.join(f.root, 'review.json'));
  const out = path.join(f.root, 'offline'); await runUi(['export', '--manifest', f.manifestPath, '--out', out]);
  assert.deepEqual(await fs.readFile(path.join(out, 'images/007-first.png')), PNG);
  assert.equal(JSON.parse(await fs.readFile(path.join(out, 'review.json'))).annotations.first.note, 'export this note');
  assert.ok((await fs.readFile(path.join(out, 'index.html'), 'utf8')).includes('export this note'));
  const reopened = await CaptureWorkspace.open(path.join(out, 'capture.json'));
  const exportedReview = await reopened.review.read();
  assert.equal(exportedReview.manifestId, sha(await fs.readFile(path.join(out, 'capture.json'))));
  assert.equal(exportedReview.revision, 1);
  await reopened.review.write({ expectedRevision: 1, annotations: { first: { status: 'accepted', note: 'edit after reimport' } } });
  assert.equal((await reopened.review.read()).revision, 2);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'review.json')), sourceReview);
  assert.deepEqual(await fs.readFile(f.manifestPath), f.bytes);
});
