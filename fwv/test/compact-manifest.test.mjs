import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FwvProject as CompactProject } from '../src/core/project.mjs';

const LIMIT = 16 * 1024 * 1024;
// 42k rows keeps each public metadata write below 1 MiB while accounting for
// exportAsset's two manifest copies of the selected revision metadata.
const rowsMetadata = () => ({ rows: Array.from({ length: 42000 }, (_, index) => ({ index: index % 10, a: 0 })) });
const smallFile = (tag) => [{ name: 'source.bin', role: 'source', mime: 'application/octet-stream', buffer: Buffer.from(`source-${tag}`) }];
const manifestPath = (root) => path.join(root, 'fwv.project.json');
const readManifest = async (root) => JSON.parse(await fs.readFile(manifestPath(root), 'utf8'));
const manifestBytes = async (root) => (await fs.stat(manifestPath(root))).size;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-compact-'));

async function makeProject(Project, name) {
  const root = path.join(tempRoot, name);
  await fs.mkdir(root);
  const project = new Project(root);
  await project.init({ name });
  return { root, project };
}

async function buildFourAssetHistory(name) {
  const state = await makeProject(CompactProject, name);
  const assets = [];
  for (let index = 0; index < 4; index += 1) {
    let asset = await state.project.importAsset({ name: `large-${index}`, kind: 'custom-art', files: smallFile(index), metadata: rowsMetadata(), recipe: { operation: 'synthetic-import' } });
    assets.push(asset);
  }
  return { ...state, assets };
}

test('compact manifest preserves history and fits where pretty export reaches the 16 MiB guard', async () => {
  const fixture = await buildFourAssetHistory('pretty-capacity');
  const compactSnapshot = await fixture.project.snapshot();
  // Synthetic legacy fixture: exact public snapshot, serialized in the
  // historical pretty format; no second implementation is shipped.
  await fs.writeFile(manifestPath(fixture.root), `${JSON.stringify(compactSnapshot, null, 2)}\n`);
  const beforeExport = await fs.readFile(manifestPath(fixture.root));
  const before = JSON.parse(beforeExport);
  const prettyBeforeBytes = beforeExport.length;
  assert(prettyBeforeBytes < LIMIT, `pretty setup must remain legal before export: ${prettyBeforeBytes}`);
  const originalBytes = new Map();
  const legacyReader = new CompactProject(fixture.root);
  for (const asset of before.assets) for (const revision of asset.revisions) for (const file of revision.files) {
    originalBytes.set(`${asset.id}/${revision.id}/${file.name}`, (await legacyReader.readArtifact({ assetId: asset.id, revisionId: revision.id, fileName: file.name })).buffer);
  }

  const compactRoot = path.join(tempRoot, 'compact-capacity');
  await fs.cp(fixture.root, compactRoot, { recursive: true });
  const compact = new CompactProject(compactRoot);
  const exported = await compact.exportAsset({ assetId: before.assets[0].id, revisionId: before.assets[0].selectedRevisionId });
  const after = await readManifest(compactRoot);
  const compactBytes = await manifestBytes(compactRoot);
  assert(compactBytes < LIMIT, `compact export must remain legal: ${compactBytes}`);
  const prettyProjectionBytes = Buffer.byteLength(`${JSON.stringify(after, null, 2)}\n`);
  assert(prettyProjectionBytes > LIMIT, `the same post-export data in pretty JSON must exceed 16 MiB: ${prettyProjectionBytes}`);
  assert.equal(after.assets.length, before.assets.length);
  assert.equal(after.assets.reduce((sum, asset) => sum + asset.revisions.length, 0), 4);
  assert.equal(after.exports.length, 1);
  assert.equal(exported.assetId, before.assets[0].id);
  for (const asset of after.assets) {
    for (const revision of asset.revisions) {
      for (const file of revision.files) {
        const current = (await compact.readArtifact({ assetId: asset.id, revisionId: revision.id, fileName: file.name })).buffer;
        assert.deepEqual(current, originalBytes.get(`${asset.id}/${revision.id}/${file.name}`));
      }
    }
  }
  const withoutValidation = value => ({ ...value, revisions: value.revisions.map(({ validation, ...revision }) => revision) });
  assert.deepEqual(after.assets.map(withoutValidation), before.assets.map(withoutValidation), 'existing revision metadata and IDs must be preserved');
  assert.equal(Buffer.from(await fs.readFile(manifestPath(compactRoot), 'utf8')).includes(Buffer.from('\n  ')), false);
  return { prettyBeforeBytes, prettyProjectionBytes, compactBytes, originalAssetCount: before.assets.length, originalRevisionCount: 4, exportCount: after.exports.length };
});

test('compact writer reads legacy pretty JSON and preserves CAS plus stale-writer rejection', async () => {
  const legacy = await makeProject(CompactProject, 'legacy-compat');
  const imported = await legacy.project.importAsset({ name: 'legacy', kind: 'custom-art', files: smallFile('legacy'), metadata: { source: 'legacy' }, recipe: { operation: 'import' } });
  const legacySnapshot = await legacy.project.snapshot();
  await fs.writeFile(manifestPath(legacy.root), `${JSON.stringify(legacySnapshot, null, 2)}\n`);
  const initial = await fs.readFile(manifestPath(legacy.root));
  const compact = new CompactProject(legacy.root);
  const writerA = new CompactProject(legacy.root);
  const writerB = new CompactProject(legacy.root);
  const revised = await writerB.addRevision({ assetId: imported.id, parentRevisionId: imported.selectedRevisionId, expectedSelectedRevisionId: imported.selectedRevisionId, files: smallFile('writer-b'), metadata: { source: 'writer-b' }, recipe: { operation: 'revision-b' } });
  await assert.rejects(
    writerA.addRevision({ assetId: imported.id, parentRevisionId: imported.selectedRevisionId, expectedSelectedRevisionId: imported.selectedRevisionId, files: smallFile('writer-a'), metadata: { source: 'writer-a' }, recipe: { operation: 'revision-a' } }),
    (error) => error.status === 409,
  );
  const current = await compact.snapshot();
  assert.equal(current.assets[0].selectedRevisionId, revised.selectedRevisionId);
  assert.equal(current.assets[0].revisions.at(-1).metadata.source, 'writer-b');
  assert(initial.includes(Buffer.from('\n  ')), 'legacy fixture must be pretty JSON');
  assert.equal((await compact.readArtifact({ assetId: imported.id, revisionId: revised.selectedRevisionId, fileName: 'source.bin' })).buffer.toString(), 'source-writer-b');
  const exported = await compact.exportAsset({ assetId: imported.id, revisionId: revised.selectedRevisionId });
  const artifact = await compact.readArtifact({ assetId: imported.id, revisionId: revised.selectedRevisionId, fileName: 'source.bin' });
  assert.equal(sha256(artifact.buffer), exported.manifest.files[0].sha256);
  assert.equal((await compact.snapshot()).exports.length, 1);
});

test('compact public imports reject only the first over-limit write and leave the live manifest unchanged', async () => {
  const state = await makeProject(CompactProject, 'compact-overflow');
  let accepted = 0;
  let rejected = null;
  for (let index = 0; index < 40 && !rejected; index += 1) {
    const before = await fs.readFile(manifestPath(state.root));
    try {
      await state.project.importAsset({ name: `fill-${index}`, kind: 'custom-art', files: smallFile(`fill-${index}`), metadata: rowsMetadata(), recipe: { operation: 'capacity-fill' } });
      accepted += 1;
      assert((await manifestBytes(state.root)) <= LIMIT);
    } catch (error) {
      rejected = { error, before };
    }
  }
  assert(rejected, 'bounded public imports must eventually reach the manifest guard');
  assert.match(rejected.error.message, /Project manifest exceeds(?: the)? 16 MiB/i);
  assert.deepEqual(await fs.readFile(manifestPath(state.root)), rejected.before, 'rejected import must preserve the live manifest bytes');
  assert(accepted > 0);
  const final = await readManifest(state.root);
  assert.equal(final.assets.length, accepted);
  return { accepted, bytes: await manifestBytes(state.root) };
});
