import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { ReskinWorkflows } from '../src/workflows/reskin.mjs';
import { importSpine } from '../src/spine/application.mjs';
import { createReskinFixture } from '../examples/reskin-fixture/create.mjs';

const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const execution = { provider: 'test-fixture', model: 'mock-raster', tool: 'local-normalization-test', notes: 'Synthetic RGB fixture; no model called. Explicit uniform 1254 to 1024 normalization; layout not visually accepted.' };
const recipe = { width: 1024, height: 1024, padding: 0, trim: false, fit: 'contain', background: 'transparent' };

async function fixture(t, size = 1254) {
  const prefix = path.join(os.tmpdir(), 'fwv-local-normalization-'), root = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(root.startsWith(prefix) && path.dirname(root) === path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const project = new FwvProject(root); await project.init({ name: 'Synthetic normalization provenance' });
  const source = await createReskinFixture(), template = await importSpine(project, { name: source.name, files: source.files });
  const workflows = new ReskinWorkflows({ project }); t.after(() => workflows.close());
  const created = await workflows.create({ templateAssetId: template.id, templateRevisionId: template.selectedRevisionId, name: 'Test candidate', brief: 'Synthetic flat palette', mode: 'local' });
  const generated = await workflows.generate({ workflowId: created.assetId, requestId: 'normalization-fixture' });
  const task = { workflowId: created.assetId, attemptId: generated.attempts[0].id };
  const claimed = await workflows.localClaim({ ...task, workerId: 'normalization-test' });
  const claim = { ...task, claimId: claimed.task.claimId };
  await workflows.localAnalyze({ ...claim, analysis: { summary: 'Synthetic test preserves the six original masks.', partNotes: {}, risks: ['No visual acceptance is performed by this fixture.'] } });
  await workflows.localDispatch(claim);
  const buffer = await sharp({ create: { width: size, height: size, channels: 3, background: '#6f55aa' } }).png().toBuffer();
  const original = await project.importImage({ name: 'Mock RGB raw result', fileName: 'raw-result.png', buffer });
  return { project, root, workflows, claim, buffer, original };
}

test('explicit 1254 RGB normalization retains verified parent and recipe provenance through candidate export', async t => {
  const f = await fixture(t);
  assert.equal(f.original.revisions[0].metadata.image.hasAlpha, false);
  await assert.rejects(f.workflows.localComplete({ ...f.claim, imageAssetId: f.original.id, imageRevisionId: f.original.selectedRevisionId, execution }), /1024/);
  const normalized = await f.project.processImage({ assetId: f.original.id, revisionId: f.original.selectedRevisionId, recipe });
  const args = { ...f.claim, imageAssetId: normalized.id, imageRevisionId: normalized.selectedRevisionId, execution };
  const completed = await f.workflows.localComplete(args), attempt = completed.attempts[0];
  assert.equal(attempt.status, 'succeeded');
  const snapshot = await f.project.snapshot();
  const sheet = snapshot.assets.find(asset => asset.id === attempt.sheetAssetId).revisions[0];
  const result = sheet.metadata.generation.sourceResult;
  assert.equal(result.parentRevisionId, f.original.selectedRevisionId);
  assert.deepEqual(result.processingRecipe, normalized.revisions.at(-1).recipe);
  assert.deepEqual(result.sourceDimensions, { width: 1254, height: 1254 });
  assert.deepEqual(result.resultDimensions, { width: 1024, height: 1024 });
  assert.deepEqual(result.parentInput, { assetId: f.original.id, revisionId: f.original.selectedRevisionId, fileName: 'raw-result.png', sha256: hash(f.buffer), width: 1254, height: 1254 });
  assert.deepEqual((await f.project.readArtifact({ assetId: f.original.id, revisionId: f.original.selectedRevisionId, fileName: 'raw-result.png' })).buffer, f.buffer);
  const candidate = snapshot.assets.find(asset => asset.id === attempt.candidateAssetId).revisions[0];
  assert.deepEqual(candidate.metadata.reskin.provenance.generation.sourceResult, result);
  assert.ok(!candidate.files.some(file => file.sha256 === hash(f.buffer)), 'The original RGB image remains in its source asset; it is not copied into the candidate.');
  const exported = await f.project.exportAsset({ assetId: attempt.candidateAssetId, revisionId: attempt.candidateRevisionId });
  const manifest = JSON.parse(await fs.readFile(path.join(f.root, exported.path, 'manifest.json')));
  assert.deepEqual(manifest.metadata.reskin.provenance.generation.sourceResult, result);
  assert.deepEqual(manifest.recipe.provenance.generation.sourceResult, result);
  assert.equal((await f.workflows.localComplete(args)).attempts[0].candidateAssetId, attempt.candidateAssetId);
  assert.equal((await f.project.snapshot()).assets.length, snapshot.assets.length);
});

test('unprocessed import receipts retain their exact four-field source identity and remain idempotent', async t => {
  const f = await fixture(t, 1024);
  const args = { ...f.claim, imageAssetId: f.original.id, imageRevisionId: f.original.selectedRevisionId, execution };
  const completed = await f.workflows.localComplete(args), attempt = completed.attempts[0];
  const snapshot = await f.project.snapshot();
  const sheet = snapshot.assets.find(asset => asset.id === attempt.sheetAssetId).revisions[0];
  assert.deepEqual(sheet.metadata.generation.sourceResult, { assetId: f.original.id, revisionId: f.original.selectedRevisionId, fileName: 'raw-result.png', sha256: hash(f.buffer) });
  await f.workflows.localComplete(args);
  assert.equal((await f.project.snapshot()).assets.length, snapshot.assets.length);
});

test('normalization refuses corrupt parent bytes, parent metadata and a mismatched processing recipe before recording output', async t => {
  const f = await fixture(t);
  const normalized = await f.project.processImage({ assetId: f.original.id, revisionId: f.original.selectedRevisionId, recipe });
  const args = { ...f.claim, imageAssetId: normalized.id, imageRevisionId: normalized.selectedRevisionId, execution };
  const originalPath = path.join(f.root, 'assets', f.original.id, f.original.selectedRevisionId, 'raw-result.png');
  const corrupted = Buffer.from(f.buffer); corrupted[corrupted.length - 1] ^= 1; await fs.writeFile(originalPath, corrupted);
  const before = await f.project.snapshot();
  await assert.rejects(f.workflows.localComplete(args), /hash mismatch/);
  await fs.writeFile(originalPath, f.buffer);
  const manifestPath = path.join(f.root, 'fwv.project.json');
  const wrongMetadata = structuredClone(before);
  wrongMetadata.assets.find(asset => asset.id === f.original.id).revisions[0].metadata.image.width = 1253;
  await fs.writeFile(manifestPath, JSON.stringify(wrongMetadata));
  await assert.rejects(f.workflows.localComplete(args), /父版本图片索引/);
  const wrongRecipe = structuredClone(before);
  wrongRecipe.assets.find(asset => asset.id === f.original.id).revisions.at(-1).recipe.width = 512;
  await fs.writeFile(manifestPath, JSON.stringify(wrongRecipe));
  await assert.rejects(f.workflows.localComplete(args), /处理配方/);
  const after = await f.project.snapshot();
  assert.equal(after.assets.length, before.assets.length);
  assert.equal((await f.workflows.get({ workflowId: f.claim.workflowId })).attempts[0].sheetAssetId, undefined);
});
