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
import { processImageBuffer, normalizeRecipe } from '../src/image/processor.mjs';

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

test('image workflow preserves original, derives a padded revision, validates and exports exact bytes', async (t) => {
  const { root, project } = await fixture(t);
  const original = await source();
  const asset = await project.importImage({ name: 'Potion', fileName: 'potion.png', buffer: original });
  const originalRevision = asset.selectedRevisionId;
  const result = await project.processImage({ assetId: asset.id, revisionId: originalRevision, recipe: {
    width: 64, height: 64, padding: 8, trim: true, background: 'transparent', removeBackground: { color: '#ffffff', tolerance: 0 },
  } });
  const processed = result.revisions.at(-1);
  assert.equal(processed.parentId, originalRevision);
  assert.deepEqual(processed.metadata.image.alpha.bounds, { x: 14, y: 8, width: 36, height: 48 });
  assert.equal(processed.metadata.image.hasAlpha, true);
  assert.deepEqual((await project.readArtifact({ assetId: asset.id, revisionId: originalRevision, fileName: 'potion.png' })).buffer, original);
  const report = await project.validateRevision({ assetId: asset.id, revisionId: processed.id });
  assert.equal(report.status, 'passed');
  assert.equal(report.scope, 'technical');
  assert.equal(report.humanAcceptance, 'not-reviewed');
  assert.equal(report.checks.find((check) => check.id === 'alpha-padding').status, 'passed');
  const exported = await project.exportAsset({ assetId: asset.id, revisionId: processed.id });
  const output = await project.readArtifact({ assetId: asset.id, revisionId: processed.id, fileName: 'image.png' });
  assert.deepEqual(await fs.readFile(path.join(root, exported.path, 'resources', 'image.png')), output.buffer);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, exported.path, 'manifest.json'))).revisionId, processed.id);
  await project.selectRevision({ assetId: asset.id, revisionId: originalRevision });
  assert.equal((await project.snapshot()).assets[0].selectedRevisionId, originalRevision);
  assert.equal((await project.snapshot()).exports.length, 1);
});

test('same source and recipe yield deterministic bytes while revisions remain distinct', async (t) => {
  const { project } = await fixture(t);
  const asset = await project.importImage({ fileName: 'source.png', buffer: await source() });
  const params = { assetId: asset.id, revisionId: asset.selectedRevisionId, recipe: { width: 32, height: 24, padding: 2 } };
  const first = (await project.processImage(params)).revisions.at(-1);
  const second = (await project.processImage(params)).revisions.at(-1);
  assert.notEqual(first.id, second.id);
  assert.equal(first.files[0].sha256, second.files[0].sha256);
  assert.equal((await project.snapshot()).assets[0].revisions.length, 3);
});

test('configured contain, cover and fill modes preserve aspect, crop or stretch pixels as labelled', async () => {
  const buffer = await sharp({ create: { width: 80, height: 40, channels: 4, background: '#ff0000' } })
    .composite([{ input: await sharp({ create: { width: 40, height: 40, channels: 4, background: '#00ff00' } }).png().toBuffer(), left: 20, top: 0 }]).png().toBuffer();
  const results = {};
  for (const fit of ['contain', 'cover', 'fill']) {
    const result = await processImageBuffer(buffer, { width: 60, height: 60, padding: 10, fit });
    results[fit] = result;
    assert.equal(result.metadata.image.width, 60); assert.equal(result.metadata.image.height, 60);
    assert.equal(result.recipe.fit, fit);
  }
  assert.deepEqual(results.contain.metadata.image.alpha.bounds, { x: 10, y: 20, width: 40, height: 20 });
  for (const fit of ['cover', 'fill']) assert.deepEqual(results[fit].metadata.image.alpha.bounds, { x: 10, y: 10, width: 40, height: 40 });
  const pixel = async (fit, left, top) => [...await sharp(results[fit].buffer).extract({ left, top, width: 1, height: 1 }).raw().toBuffer()];
  assert.deepEqual(await pixel('cover', 15, 30), [0, 255, 0, 255], 'Centered cover crops the red side strips.');
  assert.deepEqual(await pixel('fill', 15, 30), [255, 0, 0, 255], 'Stretch retains the red side strips.');
  assert.deepEqual(await pixel('contain', 15, 12), [0, 0, 0, 0], 'Contain leaves transparent space above the image.');
  for (const fit of ['contain', 'cover', 'fill']) assert.equal((await pixel(fit, 2, 30))[3], 0);
});

test('revising a recipe keeps its input fixed across edits; appending deliberately processes current pixels', async t => {
  const { root, project } = await fixture(t);
  const buffer = await sharp({ create: { width: 100, height: 100, channels: 4, background: '#ff0000' } }).png().toBuffer();
  let asset = await project.importImage({ name: 'Fixed input', fileName: 'source.png', buffer });
  const original = asset.selectedRevisionId, recipe = { width: 100, height: 100, padding: 10, trim: false };
  asset = await project.processImage({ assetId: asset.id, revisionId: original, recipe });
  const first = asset.revisions.at(-1);
  assert.deepEqual(first.metadata.image.alpha.bounds, { x: 10, y: 10, width: 80, height: 80 });
  // Old saved projects have only parentId and recipe, with no processing metadata.
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'fwv.project.json'), 'utf8'));
  delete manifest.assets[0].revisions.at(-1).metadata.processing;
  await fs.writeFile(path.join(root, 'fwv.project.json'), JSON.stringify(manifest));
  asset = await project.processImage({ assetId: asset.id, revisionId: first.id, recipe, mode: 'revise' });
  const revised = asset.revisions.at(-1);
  assert.equal(revised.parentId, first.id);
  assert.equal(revised.metadata.processing.inputRevisionId, original);
  assert.equal(revised.files[0].sha256, first.files[0].sha256);
  asset = await project.processImage({ assetId: asset.id, revisionId: revised.id, recipe: { ...recipe, padding: 20 }, mode: 'revise' });
  assert.deepEqual(asset.revisions.at(-1).metadata.image.alpha.bounds, { x: 20, y: 20, width: 60, height: 60 });
  assert.equal(asset.revisions.at(-1).metadata.processing.inputRevisionId, original);
  asset = await project.processImage({ assetId: asset.id, revisionId: first.id, recipe, mode: 'append' });
  assert.deepEqual(asset.revisions.at(-1).metadata.image.alpha.bounds, { x: 17, y: 17, width: 66, height: 66 });
  assert.equal(asset.revisions.at(-1).metadata.processing.inputRevisionId, first.id);
  assert.deepEqual((await project.readArtifact({ assetId: asset.id, revisionId: original, fileName: 'source.png' })).buffer, buffer);
  const count = asset.revisions.length;
  await assert.rejects(project.processImage({ assetId: asset.id, revisionId: original, recipe, mode: 'revise' }), /no image processing recipe/);
  await assert.rejects(project.processImage({ assetId: asset.id, revisionId: first.id, recipe, mode: 'invalid' }), /processing mode/);
  assert.equal((await project.snapshot()).assets[0].revisions.length, count);
});

test('durable import receipts recover a committed result without changing selection or duplicating assets', async t => {
  const { root, project } = await fixture(t);
  const input = { idempotencyKey: 'generation-exact-result', name: 'Recovered result', kind: 'image',
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
  const processed = await reopened.processImage({ assetId: a.id, revisionId: importedId, recipe: { width: 24, height: 24 } });
  const recovered = await reopened.importAsset(input);
  assert.equal(recovered.importReceipt.revisionId, importedId);
  assert.equal(recovered.selectedRevisionId, processed.selectedRevisionId, 'Recovery must preserve the user-selected later version.');
  for (const patch of [{ name: 'Different' }, { metadata: { example: { a: 1, b: 3 } } }, { files: [{ ...input.files[0], buffer: Buffer.from('different') }] }]) {
    await assert.rejects(reopened.importAsset({ ...input, ...patch }), error => error.status === 409 && error.code === 'IMPORT_KEY_CONFLICT');
  }
  assert.equal((await reopened.snapshot()).assets.length, 1);
  await fs.writeFile(path.join(root, 'assets', a.id, importedId, 'image.png'), Buffer.from('corrupt'));
  await assert.rejects(reopened.importAsset(input), /mismatch/);
});

test('corrupt artifact cannot be read, processed or exported even after a prior passing validation', async (t) => {
  const { root, project } = await fixture(t);
  const asset = await project.importImage({ fileName: 'source.png', buffer: await source() });
  const args = { assetId: asset.id, revisionId: asset.selectedRevisionId };
  assert.equal((await project.validateRevision(args)).status, 'passed');
  const sourcePath = path.join(root, 'assets', asset.id, asset.selectedRevisionId, 'source.png');
  const bytes = await fs.readFile(sourcePath);
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(sourcePath, bytes);
  await assert.rejects(project.readArtifact({ ...args, fileName: 'source.png' }), /hash mismatch/);
  await assert.rejects(project.processImage({ ...args, recipe: {} }), /hash mismatch/);
  assert.equal((await project.validateRevision(args)).status, 'failed');
  await assert.rejects(project.exportAsset(args), /validation failed/);
  assert.equal((await project.snapshot()).exports.length, 0);
});

test('unsafe names, IDs, recipes and malformed inputs are rejected before creating revisions', async (t) => {
  const { project } = await fixture(t);
  for (const name of ['../bad.png', '..\\bad.png', 'C:\\bad.png', 'CON.png', 'bad:stream.png', '.', 'bad.png ']) {
    assert.throws(() => safeFileName(name), /safe basename/);
  }
  await assert.rejects(project.importImage({ fileName: 'source.png', buffer: Buffer.from('broken') }));
  await assert.rejects(project.importImage({ fileName: '../source.png', buffer: await source() }), /safe basename/);
  await assert.rejects(project.readArtifact({ assetId: '../../outside', revisionId: 'bad', fileName: 'safe.png' }), /Invalid asset ID/);
  for (const recipe of [{ width: 0 }, { width: 8193 }, { width: 8192, height: 8192 }, { width: 16, padding: 8 }, { trim: 'true' }, { background: 'red' }, { fit: 'invalid' }, { version: 2 }, { unknown: 1 }, { removeBackground: { color: '#ffffff', tolerance: 256 } }]) {
    assert.throws(() => normalizeRecipe(recipe));
  }
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
  const asset = await project.importAsset({ name: 'Hero', kind: 'spine', files, metadata: { spine: { version: '4.2' } } });
  const revised = await project.addRevision({ assetId: asset.id, parentRevisionId: asset.selectedRevisionId, files, metadata: { spine: { version: '4.2' } }, recipe: { operation: 'replace' } });
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

test('background color fills transparent source holes and padding exactly once', async () => {
  const input = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const processed = await processImageBuffer(input, { width: 4, height: 4, padding: 1, background: '#33669980' });
  const { data } = await sharp(processed.buffer).raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) assert.deepEqual([...data.subarray(index, index + 4)], [51, 102, 153, 128]);
});

test('CLI emits machine-readable JSON and real import/process/export results', async (t) => {
  const { root } = await fixture(t);
  const input = path.join(root, 'input.png');
  await fs.writeFile(input, await source());
  const imported = JSON.parse((await exec(process.execPath, [cli, 'import', '--project', root, '--file', input])).stdout);
  const processed = JSON.parse((await exec(process.execPath, [cli, 'process', '--project', root, '--asset', imported.id, '--width', '48', '--height', '48', '--padding', '4'])).stdout);
  assert.equal(processed.revisions.at(-1).metadata.image.width, 48);
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
  await project.processImage({ assetId: asset.id, recipe: { width: 16, height: 16 } });
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
