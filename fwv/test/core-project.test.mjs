import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import { FwvProject, safeFileName } from '../src/core/project.mjs';
import { inspectImage } from '../src/image/processor.mjs';
import { run } from '../bin/fwv.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/fwv.mjs', import.meta.url));
const coreUrl = new URL('../src/core/project.mjs', import.meta.url).href;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-core-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = new FwvProject(root);
  await project.init({ name: 'Test workshop' });
  return { root, project };
}

async function source() {
  return sharp({ create: { width: 20, height: 12, channels: 4, background: '#ffffff' } })
    .composite([{ input: await sharp({ create: { width: 6, height: 8, channels: 4, background: '#ee2200' } }).png().toBuffer(), left: 7, top: 2 }])
    .png().toBuffer();
}

test('2D image revisions preserve originals and export exact validated bytes', async t => {
  const { root, project } = await fixture(t);
  const original = await source();
  const asset = await project.importImage({ name: 'Potion', fileName: 'potion.png', buffer: original });
  const originalRevision = asset.selectedRevisionId;
  const replacement = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ee4400' } }).png().toBuffer();
  const result = await project.addRevision({ assetId: asset.id, parentRevisionId: originalRevision,
    files: [{ name: 'potion.png', role: 'image', mime: 'image/png', buffer: replacement }], metadata: { image: await inspectImage(replacement) } });
  const revision = result.revisions.at(-1);
  assert.equal(revision.parentId, originalRevision);
  assert.deepEqual((await project.readArtifact({ assetId: asset.id, revisionId: originalRevision, fileName: 'potion.png' })).buffer, original);
  const report = await project.validateRevision({ assetId: asset.id, revisionId: revision.id });
  assert.equal(report.status, 'passed'); assert.equal(report.scope, 'technical');
  const exported = await project.exportAsset({ assetId: asset.id, revisionId: revision.id });
  assert.deepEqual(await fs.readFile(path.join(root, exported.path, 'resources', 'potion.png')), replacement);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, exported.path, 'manifest.json'))).revisionId, revision.id);
  await project.selectRevision({ assetId: asset.id, revisionId: originalRevision });
  assert.equal((await project.snapshot()).assets[0].selectedRevisionId, originalRevision);
  assert.equal((await project.snapshot()).exports.length, 1);
});

test('durable import receipts recover a committed result without changing selection or duplicating assets', async t => {
  const { root, project } = await fixture(t);
  const input = { idempotencyKey: 'import-exact-result', name: 'Recovered result', kind: 'image',
    files: [{ name: 'image.png', role: 'image', mime: 'image/png', buffer: await source() }],
    metadata: { example: { b: 2, a: 1 } }, recipe: { operation: 'fixture' } };
  const save = project._save.bind(project);
  let failOnce = true;
  project._save = async data => { await save(data); if (failOnce) { failOnce = false; throw new Error('Response lost after commit'); } };
  await assert.rejects(project.importAsset(input), /Response lost/);
  const reopened = new FwvProject(root);
  const [a, b] = await Promise.all([reopened.importAsset(input), new FwvProject(root).importAsset({ ...input, metadata: { example: { a: 1, b: 2 } } })]);
  assert.equal(a.id, b.id);
  assert.equal((await reopened.snapshot()).assets.length, 1);
  const importedId = a.importReceipt.revisionId;
  const revised = await reopened.addRevision({ assetId: a.id, parentRevisionId: importedId, files: input.files });
  const recovered = await reopened.importAsset(input);
  assert.equal(recovered.importReceipt.revisionId, importedId);
  assert.equal(recovered.selectedRevisionId, revised.selectedRevisionId, 'Recovery must preserve the user-selected later version.');
  for (const patch of [{ name: 'Different' }, { metadata: { example: { a: 1, b: 3 } } }, { files: [{ ...input.files[0], buffer: Buffer.from('different') }] }]) {
    await assert.rejects(reopened.importAsset({ ...input, ...patch }), error => error.status === 409 && error.code === 'IMPORT_KEY_CONFLICT');
  }
  assert.equal((await reopened.snapshot()).assets.length, 1);
  await fs.writeFile(path.join(root, 'assets', a.id, importedId, 'image.png'), Buffer.from('corrupt'));
  await assert.rejects(reopened.importAsset(input), /mismatch/);
});

test('corrupt artifact cannot be read or exported even after a prior passing validation', async (t) => {
  const { root, project } = await fixture(t);
  const asset = await project.importImage({ fileName: 'source.png', buffer: await source() });
  const args = { assetId: asset.id, revisionId: asset.selectedRevisionId };
  assert.equal((await project.validateRevision(args)).status, 'passed');
  const sourcePath = path.join(root, 'assets', asset.id, asset.selectedRevisionId, 'source.png');
  const bytes = await fs.readFile(sourcePath);
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(sourcePath, bytes);
  await assert.rejects(project.readArtifact({ ...args, fileName: 'source.png' }), /hash mismatch/);
  assert.equal((await project.validateRevision(args)).status, 'failed');
  await assert.rejects(project.exportAsset(args), /validation failed/);
  assert.equal((await project.snapshot()).exports.length, 0);
});

test('unsafe names, IDs and malformed inputs are rejected before creating revisions', async (t) => {
  const { project } = await fixture(t);
  for (const name of ['../bad.png', '..\\bad.png', 'C:\\bad.png', 'CON.png', 'bad:stream.png', '.', 'bad.png ']) {
    assert.throws(() => safeFileName(name), /safe basename/);
  }
  await assert.rejects(project.importImage({ fileName: 'source.png', buffer: Buffer.from('broken') }));
  await assert.rejects(project.importImage({ fileName: '../source.png', buffer: await source() }), /safe basename/);
  await assert.rejects(project.readArtifact({ assetId: '../../outside', revisionId: 'bad', fileName: 'safe.png' }), /Invalid asset ID/);
  assert.equal((await project.snapshot()).assets.length, 0);
});

test('unsupported image formats and empty transparent assets fail the appropriate boundary', async (t) => {
  const { project } = await fixture(t);
  const gif = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).gif().toBuffer();
  await assert.rejects(project.importImage({ fileName: 'image.gif', buffer: gif }), /Only PNG/);
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const asset = await project.importImage({ fileName: 'empty.png', buffer: png });
  const args = { assetId: asset.id, revisionId: asset.selectedRevisionId };
  const report = await project.validateRevision(args);
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.find((check) => check.id === 'visible-content').status, 'failed');
  await assert.rejects(project.exportAsset(args), /validation failed/);
});

test('generic multi-file assets preserve names and use technical artifact checks', async (t) => {
  const { project } = await fixture(t);
  const files = [
    { name: 'hero.json', role: 'skeleton', mime: 'application/json', buffer: Buffer.from('{"skeleton":{}}') },
    { name: 'hero.atlas', role: 'atlas', mime: 'text/plain', buffer: Buffer.from('hero.png\n') },
  ];
  const asset = await project.importAsset({ name: 'Hero', kind: 'custom-art', files, metadata: { source: '2d-host' } });
  const revised = await project.addRevision({ assetId: asset.id, parentRevisionId: asset.selectedRevisionId, files, metadata: { source: '2d-host' }, recipe: { operation: 'replace' } });
  assert.equal(revised.revisions.at(-1).parentId, asset.selectedRevisionId);
  const report = await project.validateRevision({ assetId: asset.id });
  assert.equal(report.status, 'passed');
  assert.ok(report.checks.every((check) => check.id.startsWith('artifact:')));
  const exported = await project.exportAsset({ assetId: asset.id });
  assert.deepEqual(exported.manifest.files.map((file) => file.path), ['resources/hero.json', 'resources/hero.atlas']);
  await assert.rejects(project.addRevision({ assetId: asset.id, files: [files[0], { ...files[0], name: 'HERO.json' }] }), /Duplicate/);
});

test('cross-process writers do not lose imported assets', async (t) => {
  const { root, project } = await fixture(t);
  const script = `import { FwvProject } from ${JSON.stringify(coreUrl)}; const project = new FwvProject(process.argv[1]); await project.importAsset({ name: process.argv[2], kind: 'fixture', files: [{ name: 'fixture.txt', role: 'source', mime: 'text/plain', buffer: Buffer.from(process.argv[2]) }] });`;
  await Promise.all(Array.from({ length: 6 }, (_, index) => exec(process.execPath, ['--input-type=module', '-e', script, root, `asset-${index}`])));
  assert.equal((await project.snapshot()).assets.length, 6);
});

test('storage symlinks and junctions cannot redirect project writes', async (t) => {
  const { root, project } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(project.importImage({ fileName: 'source.png', buffer: await source() }), /Symbolic links|symbolic link/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('init refuses a symlink ancestor before creating directories outside the requested storage', async (t) => {
  const { root } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-outside-init-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const alias = path.join(root, 'alias');
  await fs.symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new FwvProject(path.join(alias, 'new-project')).init({ name: 'Unsafe' }), /symbolic link/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('CLI emits machine-readable JSON and real import/export results', async (t) => {
  const { root } = await fixture(t);
  const input = path.join(root, 'input.png');
  await fs.writeFile(input, await source());
  const imported = JSON.parse((await exec(process.execPath, [cli, 'import', '--project', root, '--file', input])).stdout);
  const result = JSON.parse((await exec(process.execPath, [cli, 'export', '--project', root, '--asset', imported.id])).stdout);
  assert.equal(result.manifest.validation.status, 'passed');
});

test('Windows transient sharing violations retry the same atomic rename under the writer lock', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, project } = await fixture(t);
  const originalManifest = await fs.readFile(path.join(root, 'fwv.project.json'));
  const rename = fs.rename;
  const attempts = [];
  const failures = ['EPERM', 'EACCES', 'EBUSY'];
  t.mock.method(fs, 'rename', async (from, to) => {
    attempts.push({ from, to });
    assert.deepEqual(await fs.readFile(to), originalManifest, 'Readers continue seeing the previous complete manifest until commit.');
    assert.ok((await fs.stat(path.join(root, '.fwv.lock'))).isDirectory(), 'Writer lock remains held throughout retry.');
    assert.equal(JSON.parse(await fs.readFile(from, 'utf8')).assets.length, 1, 'The complete next manifest is already staged.');
    const code = failures.shift();
    if (code) throw Object.assign(new Error(`Injected sharing violation: ${code}`), { code });
    return rename(from, to);
  });
  const asset = await project.importImage({ fileName: 'source.png', buffer: await source() });
  assert.equal(attempts.length, 4);
  assert.ok(attempts.every(attempt => attempt.from === attempts[0].from && attempt.to === attempts[0].to));
  assert.equal((await project.snapshot()).assets[0].id, asset.id);
  assert.equal((await fs.readdir(root)).some(name => name === '.fwv.lock' || /^\.fwv-.*\.tmp$/.test(name)), false);
});

test('Windows permanent sharing violation fails within a bound and preserves the live manifest', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, project } = await fixture(t);
  const asset = await project.importImage({ fileName: 'source.png', buffer: await source() });
  await project.addRevision({ assetId: asset.id, files: [{ name: 'source.png', role: 'source', mime: 'image/png', buffer: await source() }] });
  const originalManifest = await fs.readFile(path.join(root, 'fwv.project.json'));
  const attempts = [];
  const denied = Object.assign(new Error('Injected permanent access denial'), { code: 'EACCES' });
  t.mock.method(fs, 'rename', async (from, to) => { attempts.push({ from, to }); throw denied; });
  const startedAt = Date.now();
  await assert.rejects(project.selectRevision({ assetId: asset.id, revisionId: asset.selectedRevisionId }), error => error === denied);
  const elapsed = Date.now() - startedAt;
  assert.ok(attempts.length > 1 && attempts.length < 20, `Bounded attempts: ${attempts.length}.`);
  assert.ok(elapsed >= 1400 && elapsed < 3000, `Retry elapsed ${elapsed} ms.`);
  assert.ok(attempts.every(attempt => attempt.from === attempts[0].from && attempt.to === attempts[0].to));
  assert.deepEqual(await fs.readFile(path.join(root, 'fwv.project.json')), originalManifest);
  assert.equal((await fs.readdir(root)).some(name => name === '.fwv.lock' || /^\.fwv-.*\.tmp$/.test(name)), false);
});

test('non-sharing rename errors fail immediately without replacing the live manifest', async (t) => {
  const { root, project } = await fixture(t);
  const originalManifest = await fs.readFile(path.join(root, 'fwv.project.json'));
  const failure = Object.assign(new Error('Injected full disk'), { code: 'ENOSPC' });
  let attempts = 0;
  t.mock.method(fs, 'rename', async () => { attempts++; throw failure; });
  await assert.rejects(project.importImage({ fileName: 'source.png', buffer: await source() }), error => error === failure);
  assert.equal(attempts, 1);
  assert.deepEqual(await fs.readFile(path.join(root, 'fwv.project.json')), originalManifest);
  assert.equal((await fs.readdir(root)).some(name => name === '.fwv.lock' || /^\.fwv-.*\.tmp$/.test(name)), false);
});

test('removed CLI features fail before any project writes and are absent from help', async t => {
  const { root, project } = await fixture(t);
  const before = await project.snapshot();
  const help = await run(['help']);
  for (const command of ['process', 'generate', 'provider-check', 'changes', 'change', 'change-prepare', 'local-task', 'local-claim', 'local-dispatch', 'local-complete', 'model', 'model-import', 'model-inspect', 'spine-import', 'spine-replace', 'rig-create', 'rig-save', 'rig-build']) {
    assert.equal(Object.hasOwn(help.commands, command), false);
    await assert.rejects(run([command, '--project', root]), /Unknown command/);
  }
  assert.equal(project.processImage, undefined);
  assert.deepEqual(await project.snapshot(), before);
});

test('historic 3D assets remain readable but cannot pass validation or export', async t => {
  const { root, project } = await fixture(t);
  const asset = await project.importAsset({ name: 'Historic opaque model', kind: 'model3d', files: [{ name: 'old.glb', role: 'model', mime: 'model/gltf-binary', buffer: Buffer.from('historic') }] });
  assert.equal((await project.snapshot()).assets[0].id, asset.id);
  const before = await project.snapshot();
  for (const command of ['select', 'validate', 'export']) await assert.rejects(run([command, '--project', root, '--asset', asset.id, '--revision', asset.selectedRevisionId]), /only supports 2D/);
  assert.deepEqual(await project.snapshot(), before, 'CLI cannot modify or export retired assets.');
  assert.equal((await project.validateRevision({ assetId: asset.id })).status, 'failed');
  await assert.rejects(project.exportAsset({ assetId: asset.id }), /validation failed/);
});
