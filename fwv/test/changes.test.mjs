import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { ArtChanges, executeChangeCommand } from '../src/workflows/changes.mjs';
import { GenerationJobs } from '../src/generation/jobs.mjs';
import { run } from '../bin/fwv.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectImage } from '../src/image/processor.mjs';

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'fwv-changes-'), root = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(root.startsWith(prefix) && path.dirname(root) === path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const project = new FwvProject(root); await project.init({ name: '素材修改闭环' });
  const original = await sharp({ create: { width: 20, height: 16, channels: 4, background: '#cc4433' } }).png().toBuffer();
  const source = await project.importImage({ name: '图标', fileName: 'icon.png', buffer: original });
  const changes = new ArtChanges({ project });
  const request = { sourceAssetId: source.id, sourceRevisionId: source.selectedRevisionId, title: '调整边距', request: '增加透明边距。', preserve: '保持主体颜色和形状。',
    anchors: { region: { x: 0, y: 0, width: 20, height: 16 }, objects: ['主体'], view: { background: 'checkerboard', zoom: 2 } } };
  const change = await changes.create(request);
  return { root, project, original, source, changes, request, change };
}
const recipe = { width: 32, height: 32, padding: 4, trim: false, background: 'transparent', fit: 'contain' };

test('image candidate, human review and adoption form a durable loop without prematurely switching the source', async t => {
  const f = await fixture(t);
  const changed = await f.changes.process({ changeId: f.change.id, requestId: 'padding-one', recipe });
  const candidate = changed.candidates[0];
  assert.equal(candidate.validation.status, 'passed'); assert.equal(candidate.validation.humanAcceptance, 'not-reviewed');
  assert.equal(candidate.review.decision, 'pending'); assert.notEqual(candidate.assetId, f.source.id);
  assert.equal((await f.project.snapshot()).assets.find(asset => asset.id === f.source.id).selectedRevisionId, f.source.selectedRevisionId);
  await assert.rejects(f.changes.adopt({ changeId: f.change.id, candidateId: candidate.id }), /先人工接受/);
  const accepted = await f.changes.review({ changeId: f.change.id, candidateId: candidate.id, decision: 'accepted', comment: '同尺度核对，边距合适。' });
  assert.equal(accepted.candidates[0].validation.humanAcceptance, 'not-reviewed');
  assert.equal(accepted.adoption, null);
  const adopted = await f.changes.adopt({ changeId: f.change.id, candidateId: candidate.id });
  const snapshot = await f.project.snapshot(), source = snapshot.assets.find(asset => asset.id === f.source.id);
  assert.equal(source.selectedRevisionId, adopted.adoption.revisionId);
  assert.equal(source.revisions.length, 2); assert.equal(source.revisions[1].parentId, f.source.selectedRevisionId);
  assert.equal(source.revisions[1].metadata.artChange.review.comment, '同尺度核对，边距合适。');
  const image = await f.project.readArtifact({ assetId: source.id, revisionId: source.selectedRevisionId, fileName: 'image.png' });
  assert.equal((await sharp(image.buffer).metadata()).width, 32);
  const original = await f.project.readArtifact({ assetId: source.id, revisionId: f.source.selectedRevisionId, fileName: 'icon.png' });
  assert.deepEqual(original.buffer, f.original);
  const exported = await f.project.exportAsset({ assetId: source.id, revisionId: source.selectedRevisionId });
  assert.equal(exported.manifest.metadata.artChange.candidateId, candidate.id);
  assert.equal(exported.manifest.validation.humanAcceptance, 'not-reviewed');
  const reopened = await new ArtChanges({ project: new FwvProject(f.root) }).get({ changeId: f.change.id });
  assert.equal(reopened.adoptedCandidateId, candidate.id); assert.equal(reopened.source.revisionId, f.source.selectedRevisionId);
  await f.project.selectRevision({ assetId: source.id, revisionId: f.source.selectedRevisionId });
  await f.changes.adopt({ changeId: f.change.id, candidateId: candidate.id });
  assert.equal((await f.project.snapshot()).assets.find(asset => asset.id === source.id).selectedRevisionId, f.source.selectedRevisionId, 'A response-loss retry must not undo a later explicit version selection.');
});

test('candidate registration is idempotent, and cross-instance writers preserve reviews and candidates', async t => {
  const f = await fixture(t), other = new ArtChanges({ project: new FwvProject(f.root) });
  const first = await f.changes.process({ changeId: f.change.id, requestId: 'one', recipe });
  const again = await other.process({ changeId: f.change.id, requestId: 'one', recipe });
  assert.equal(again.candidates.length, 1); assert.equal(again.candidates[0].id, first.candidates[0].id);
  await assert.rejects(other.process({ changeId: f.change.id, requestId: 'one', recipe: { ...recipe, padding: 5 } }), /不同配方/);
  await Promise.all([
    f.changes.review({ changeId: f.change.id, candidateId: first.candidates[0].id, decision: 'rejected', comment: '边距仍需加大。' }),
    other.process({ changeId: f.change.id, requestId: 'two', recipe: { ...recipe, padding: 6 } }),
  ]);
  const current = await f.changes.get({ changeId: f.change.id });
  assert.equal(current.candidates.length, 2); assert.equal(current.candidates[0].review.decision, 'rejected');
  assert.equal(current.candidates[0].reviews.length, 1);
  await assert.rejects(f.changes.adopt({ changeId: f.change.id, candidateId: first.candidates[0].id }), /先人工接受/);
  const attached = await f.changes.attach({ changeId: f.change.id, assetId: first.candidates[0].assetId, revisionId: first.candidates[0].revisionId, regionMode: 'reference' });
  assert.equal(attached.candidates.length, 2);
});

test('adoption checks both current file integrity and concurrent source selection inside the transaction', async t => {
  const f = await fixture(t), candidate = (await f.changes.process({ changeId: f.change.id, recipe })).candidates[0];
  await f.changes.review({ changeId: f.change.id, candidateId: candidate.id, decision: 'accepted' });
  const independent = await f.project.processImage({ assetId: f.source.id, revisionId: f.source.selectedRevisionId, recipe: { ...recipe, width: 48 } });
  await assert.rejects(f.changes.adopt({ changeId: f.change.id, candidateId: candidate.id }), error => error.status === 409);
  assert.equal((await f.project.snapshot()).assets.find(asset => asset.id === f.source.id).selectedRevisionId, independent.selectedRevisionId);
  await f.project.selectRevision({ assetId: f.source.id, revisionId: f.source.selectedRevisionId });
  await fs.writeFile(path.join(f.root, 'assets', candidate.assetId, candidate.revisionId, 'image.png'), 'corrupt');
  const checked = await f.changes.validate({ changeId: f.change.id, candidateId: candidate.id });
  assert.equal(checked.candidates[0].validation.status, 'failed'); assert.equal(checked.candidates[0].review.decision, 'accepted');
  await assert.rejects(f.changes.adopt({ changeId: f.change.id, candidateId: candidate.id }), /技术检查失败/);
  assert.equal((await f.changes.get({ changeId: f.change.id })).adoptedCandidateId, null);
});

test('guarded acceptance cannot overwrite another reviewer rejection and omitted preconditions remain compatible', async t => {
  const f = await fixture(t), other = new ArtChanges({ project: new FwvProject(f.root) });
  const candidate = (await f.changes.process({ changeId: f.change.id, recipe })).candidates[0];
  const identity = { changeId: f.change.id, candidateId: candidate.id }, expectedReview = structuredClone(candidate.review);
  await other.review({ ...identity, decision: 'rejected', comment: '动画时仍有边缘残留。' });
  const conflict = error => error.status === 409 && error.code === 'ART_CHANGE_REVIEW_CONFLICT';
  await assert.rejects(executeChangeCommand(f.changes, { type: 'change.review', payload: { ...identity, decision: 'accepted', expectedReview } }), conflict);
  await assert.rejects(f.changes.review({ ...identity, decision: 'accepted', expectedReview: null }), conflict);
  const rejected = (await other.get({ changeId: f.change.id })).candidates[0];
  assert.equal(rejected.review.decision, 'rejected'); assert.equal(rejected.review.comment, '动画时仍有边缘残留。'); assert.equal(rejected.reviews.length, 1);
  await assert.rejects(f.changes.adopt(identity), /先人工接受/);
  assert.equal((await f.project.snapshot()).assets.find(asset => asset.id === f.source.id).selectedRevisionId, f.source.selectedRevisionId);
  // Existing explicit review commands keep their intentional ability to revise a decision.
  const accepted = await other.review({ ...identity, decision: 'accepted', comment: '已重新核对残留，接受当前效果。' });
  const currentReview = accepted.candidates[0].review;
  const guarded = await f.changes.review({ ...identity, decision: 'accepted', comment: '同条件复核通过。', expectedReview: currentReview });
  assert.equal(guarded.candidates[0].review.comment, '同条件复核通过。'); assert.equal(guarded.candidates[0].reviews.length, 3);
  await assert.rejects(other.review({ ...identity, decision: 'rejected', comment: '过时的意见', expectedReview: currentReview }), conflict);
});

test('guarded adoption refuses an unseen competing candidate while same-candidate retries remain harmless', async t => {
  const f = await fixture(t), other = new ArtChanges({ project: new FwvProject(f.root) });
  const first = (await f.changes.process({ changeId: f.change.id, requestId: 'first', recipe })).candidates[0];
  const second = (await other.process({ changeId: f.change.id, requestId: 'second', recipe: { ...recipe, padding: 6 } })).candidates[1];
  const firstIdentity = { changeId: f.change.id, candidateId: first.id }, secondIdentity = { changeId: f.change.id, candidateId: second.id };
  await f.changes.review({ ...firstIdentity, decision: 'accepted' }); await other.review({ ...secondIdentity, decision: 'accepted' });
  const expectedAdoption = structuredClone((await f.changes.get({ changeId: f.change.id })).adoption);
  assert.equal(expectedAdoption, null);
  const adopted = await f.changes.adopt({ ...firstIdentity, expectedAdoption });
  await assert.rejects(executeChangeCommand(other, { type: 'change.adopt', payload: { ...secondIdentity, expectedAdoption } }),
    error => error.status === 409 && error.code === 'ART_CHANGE_ADOPTION_CONFLICT');
  let source = (await f.project.snapshot()).assets.find(asset => asset.id === f.source.id);
  assert.equal(source.selectedRevisionId, adopted.adoption.revisionId); assert.equal(source.revisions.length, 2);
  assert.equal((await other.get({ changeId: f.change.id })).adoptedCandidateId, first.id);
  // A lost response can be retried with the old null precondition without rewriting selection.
  await f.project.selectRevision({ assetId: f.source.id, revisionId: f.source.selectedRevisionId });
  await other.adopt({ ...firstIdentity, expectedAdoption });
  source = (await f.project.snapshot()).assets.find(asset => asset.id === f.source.id);
  assert.equal(source.selectedRevisionId, f.source.selectedRevisionId); assert.equal(source.revisions.length, 2);
  await f.project.selectRevision({ assetId: f.source.id, revisionId: adopted.adoption.revisionId });
  const switched = await other.adopt(secondIdentity); // Legacy explicit comparison remains available.
  assert.equal(switched.adoptedCandidateId, second.id); assert.equal(switched.adoptions.length, 2);
});

test('adoption rejects a rewritten candidate even when an external writer updates its manifest hashes', async t => {
  const f = await fixture(t), candidate = (await f.changes.process({ changeId: f.change.id, recipe })).candidates[0];
  await f.changes.review({ changeId: f.change.id, candidateId: candidate.id, decision: 'accepted' });
  const replacement = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#0000ff' } }).png().toBuffer();
  await fs.writeFile(path.join(f.root, 'assets', candidate.assetId, candidate.revisionId, 'image.png'), replacement);
  await f.project._withLock(async () => {
    const data = await f.project._load(), revision = data.assets.find(asset => asset.id === candidate.assetId).revisions.find(item => item.id === candidate.revisionId);
    revision.files[0].sha256 = createHash('sha256').update(replacement).digest('hex'); revision.files[0].bytes = replacement.length;
    revision.metadata.image = await inspectImage(replacement); await f.project._save(data);
  });
  await assert.rejects(f.changes.adopt({ changeId: f.change.id, candidateId: candidate.id }), /人工评审时的确切版本/);
  assert.equal((await f.changes.get({ changeId: f.change.id })).adoptedCandidateId, null);
});

test('external Agent task fixes exact source files, anchors and preservation intent without generating', async t => {
  const f = await fixture(t);
  const prepared = await f.changes.prepare({ changeId: f.change.id });
  assert.match(prepared.prompt, /保持主体颜色和形状/); assert.match(prepared.prompt, new RegExp(f.source.selectedRevisionId));
  assert.equal(prepared.sourceFiles[0].path, path.join(f.root, 'assets', f.source.id, f.source.selectedRevisionId, 'icon.png'));
  assert.deepEqual(await fs.readFile(prepared.sourceFiles[0].path), f.original);
  assert.equal(prepared.completion.type, 'change.candidate.attach');
  const external = await f.project.importImage({ name: '外部候选', fileName: 'external.png', buffer: await sharp(f.original).modulate({ brightness: .8 }).png().toBuffer() });
  const result = await executeChangeCommand(f.changes, { type: 'change.candidate.attach', payload: { changeId: f.change.id, assetId: external.id, revisionId: external.selectedRevisionId,
    note: '外部工具调整明度。', execution: { kind: 'local-agent', tool: 'test-external', note: '测试回填合同' } } });
  assert.equal(result.candidates[0].execution.kind, 'local-agent'); assert.equal(result.generations.length, 0);
  await assert.rejects(f.changes.create({ ...f.request, anchors: { region: { x: 19, y: 0, width: 2, height: 1 } } }), /选区超出/);
  await assert.rejects(f.changes.attach({ changeId: f.change.id, assetId: f.source.id, revisionId: f.source.selectedRevisionId }), /基线不能/);
  await assert.rejects(f.changes.review({ changeId: f.change.id, candidateId: result.candidates[0].id, decision: 'rejected' }), /驳回意见/);
});

test('domain-neutral request can preserve objects and animation anchors without claiming image processing', async t => {
  const f = await fixture(t);
  const source = await f.project.importAsset({ name: '测试专业数据', kind: 'custom-art', files: [{ name: 'model.bin', role: 'model', mime: 'application/octet-stream', buffer: Buffer.from('opaque custom fixture') }] });
  const change = await f.changes.create({ sourceAssetId: source.id, sourceRevisionId: source.selectedRevisionId, title: '膝关节', request: '检查局部变形', anchors: { objects: ['bones/left-knee'], animation: { name: 'walk', time: .6 }, view: { camera: [1, 2, 3] } } });
  assert.equal(change.capabilities.imageProcess, false); assert.equal(change.capabilities.imageGenerate, false);
  assert.equal(change.source.kind, 'custom-art'); assert.equal(change.anchors.animation.time, .6);
  await assert.rejects(f.changes.process({ changeId: change.id, recipe }), /只支持图片/);
});

function fakeProvider(buffer, calls) {
  const config = { baseUrl: 'http://127.0.0.1:9000/v1', model: 'fixture-image', protocol: 'gpt-image', canGenerate: true };
  return { publicConfig: () => config, generate: async input => { calls.push(input); return { buffer, name: 'generated.png', mime: 'image/png', request: { model: config.model, prompt: input.prompt, size: input.size, quality: input.quality, background: input.background }, usage: { total_tokens: 3 } }; } };
}
async function settled(jobs, jobId) {
  for (let index = 0; index < 100; index++) { const job = jobs.get({ jobId }); if (!['queued', 'running'].includes(job.status)) return job; await delay(20); }
  throw new Error('Fixture generation did not settle.');
}

test('generation keeps exact source and recovers after a real service restart without another model call', async t => {
  const f = await fixture(t), calls = [], output = await sharp(f.original).modulate({ brightness: .8 }).png().toBuffer();
  const jobs = new GenerationJobs({ project: f.project, provider: fakeProvider(output, calls) });
  const changes = new ArtChanges({ project: f.project, generationJobs: jobs });
  const started = await changes.generate({ changeId: f.change.id, requestId: 'redraw-one' });
  const jobId = started.generations[0].jobId;
  const finished = await settled(jobs, jobId); assert.equal(finished.status, 'succeeded', finished.error);
  assert.deepEqual(calls[0].reference.buffer, f.original); assert.match(calls[0].prompt, /保持主体颜色和形状/);
  await jobs.close();
  const restartedJobs = new GenerationJobs({ project: new FwvProject(f.root), provider: fakeProvider(output, calls) });
  t.after(() => restartedJobs.close());
  const restarted = new ArtChanges({ project: new FwvProject(f.root), generationJobs: restartedJobs });
  const restored = await restarted.get({ changeId: f.change.id });
  assert.equal(restored.generations[0].canRecover, true);
  const repeated = await restarted.generate({ changeId: f.change.id, requestId: 'redraw-one' });
  assert.equal(repeated.generations[0].jobId, jobId); assert.equal(calls.length, 1);
  await assert.rejects(restarted.generate({ changeId: f.change.id, requestId: 'redraw-one', prompt: 'different' }), /不同内容/);
  const saved = await restarted.recover({ changeId: f.change.id, jobId });
  assert.equal(saved.candidates.length, 1); assert.equal(saved.candidates[0].review.decision, 'pending');
  assert.equal(saved.generations[0].status, 'attached');
  assert.equal((await restarted.recover({ changeId: f.change.id, jobId })).candidates.length, 1);
  assert.equal(calls.length, 1);
  assert.equal((await f.project.snapshot()).assets.find(asset => asset.id === f.source.id).selectedRevisionId, f.source.selectedRevisionId);
});

test('staged model output survives import failure and can be attached without credentials after restart', async t => {
  const f = await fixture(t), calls = [], failingProject = new FwvProject(f.root);
  failingProject.importAsset = async () => { throw new Error('Injected import failure'); };
  const jobs = new GenerationJobs({ project: failingProject, provider: fakeProvider(f.original, calls) });
  const changes = new ArtChanges({ project: failingProject, generationJobs: jobs });
  const started = await changes.generate({ changeId: f.change.id, requestId: 'recover-staged' });
  const jobId = started.generations[0].jobId;
  const staged = await settled(jobs, jobId); assert.equal(staged.status, 'ready'); assert.equal(staged.durability, 'staged');
  await jobs.close();
  const provider = fakeProvider(f.original, calls); provider.publicConfig = () => ({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'fixture-image', protocol: 'gpt-image', canGenerate: false });
  const restartedJobs = new GenerationJobs({ project: f.project, provider }); t.after(() => restartedJobs.close());
  const restarted = new ArtChanges({ project: f.project, generationJobs: restartedJobs });
  const attached = await restarted.recover({ changeId: f.change.id, jobId });
  assert.equal(attached.candidates.length, 1); assert.equal(calls.length, 1);
  const file = await f.project.readArtifact({ assetId: attached.candidates[0].assetId, revisionId: attached.candidates[0].revisionId, fileName: 'image.png' });
  assert.deepEqual(file.buffer, f.original);
});

test('unknown generation remains unknown after restart and repeating its request never dispatches again', async t => {
  const f = await fixture(t), calls = [], provider = fakeProvider(f.original, calls);
  provider.generate = async input => { calls.push(input); throw Object.assign(new Error('Result connection lost'), { uncertain: true }); };
  const jobs = new GenerationJobs({ project: f.project, provider }), changes = new ArtChanges({ project: f.project, generationJobs: jobs });
  const started = await changes.generate({ changeId: f.change.id, requestId: 'unknown-result' });
  assert.equal((await settled(jobs, started.generations[0].jobId)).status, 'unknown');
  await jobs.close();
  const restartedJobs = new GenerationJobs({ project: f.project, provider: fakeProvider(f.original, calls) }); t.after(() => restartedJobs.close());
  const restarted = new ArtChanges({ project: f.project, generationJobs: restartedJobs });
  const repeated = await restarted.generate({ changeId: f.change.id, requestId: 'unknown-result' });
  assert.equal(repeated.generations[0].status, 'unknown'); assert.equal(repeated.generations[0].canRecover, false); assert.equal(calls.length, 1);
  await assert.rejects(restarted.recover({ changeId: f.change.id, jobId: started.generations[0].jobId }), /不会重新调用模型/);
});

test('regional candidates replace RGBA only inside the exact source selection and retain the raw result', async t => {
  const f = await fixture(t), region = { x: 3, y: 4, width: 5, height: 6 };
  const change = await f.changes.create({ ...f.request, anchors: { region } });
  const replacementBytes = await sharp({ create: { width: 40, height: 32, channels: 4, background: '#2299ee80' } }).png().toBuffer();
  const replacement = await f.project.importImage({ name: '整张候选', fileName: 'candidate.png', buffer: replacementBytes });
  const result = await f.changes.attach({ changeId: change.id, assetId: replacement.id, revisionId: replacement.selectedRevisionId });
  const candidate = result.candidates[0];
  assert.notEqual(candidate.assetId, replacement.id); assert.equal(candidate.scope.outsidePixels, 'preserved');
  assert.deepEqual(candidate.scope.normalization, { inputWidth: 40, inputHeight: 32, width: 20, height: 16, fit: 'fill' });
  const composed = await f.project.readArtifact({ assetId: candidate.assetId, revisionId: candidate.revisionId, fileName: 'image.png' });
  const pixels = await sharp(composed.buffer).ensureAlpha().raw().toBuffer();
  const baseline = await sharp(f.original).ensureAlpha().raw().toBuffer();
  const expected = await sharp(replacementBytes).resize(20, 16, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < 16; y++) for (let x = 0; x < 20; x++) {
    const inside = x >= 3 && x < 8 && y >= 4 && y < 10, offset = (y * 20 + x) * 4;
    assert.deepEqual(pixels.subarray(offset, offset + 4), (inside ? expected : baseline).subarray(offset, offset + 4), `pixel ${x},${y}`);
  }
  assert.deepEqual((await f.project.readArtifact({ assetId: replacement.id, revisionId: replacement.selectedRevisionId, fileName: 'candidate.png' })).buffer, replacementBytes);
  const repeated = await f.changes.attach({ changeId: change.id, assetId: replacement.id, revisionId: replacement.selectedRevisionId });
  assert.equal(repeated.candidates.length, 1);
});

test('CLI and application API read and mutate the same change records', async t => {
  const f = await fixture(t), file = path.join(f.root, 'command.json');
  await fs.writeFile(file, JSON.stringify({ type: 'change.candidate.process', payload: { changeId: f.change.id, requestId: 'cli-process', recipe } }));
  const processed = await run(['change', '--project', f.root, '--file', file], { env: {} });
  assert.equal(processed.candidates.length, 1);
  const loaded = await run(['changes', '--project', f.root, '--change', f.change.id], { env: {} });
  assert.equal(loaded.candidates[0].id, processed.candidates[0].id);
  assert.equal((await run(['change-prepare', '--project', f.root, '--change', f.change.id], { env: {} })).source.revisionId, f.source.selectedRevisionId);
});

test('real HTTP change commands enforce origin/CSRF and share CLI-visible review and adoption state', async t => {
  const f = await fixture(t);
  const fwePath = process.env.FWV_TEST_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url));
  const editor = await startEditor({ projectRoot: f.root, fwePath, port: 0 });
  try {
    const session = await fetch(editor.url + '/api/fwv/session').then(response => response.json());
    const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWV-CSRF': session.csrfToken };
    const body = { type: 'change.candidate.process', payload: { changeId: f.change.id, requestId: 'http-process', recipe } };
    const denied = await fetch(editor.url + '/api/fwv/commands', { method: 'POST', headers: { ...headers, 'X-FWV-CSRF': 'wrong' }, body: JSON.stringify(body) });
    assert.equal(denied.status, 403); assert.equal((await f.changes.get({ changeId: f.change.id })).candidates.length, 0);
    const command = async (type, payload) => {
      const response = await fetch(editor.url + '/api/fwv/commands', { method: 'POST', headers, body: JSON.stringify({ type, payload }) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.result;
    };
    const processed = await command(body.type, body.payload), candidateId = processed.candidates[0].id;
    const list = await fetch(editor.url + '/api/fwv/changes').then(response => response.json());
    assert.equal(list.changes[0].candidates[0].id, candidateId);
    const prepared = await command('change.prepare', { changeId: f.change.id });
    assert.equal(prepared.source.revisionId, f.source.selectedRevisionId);
    await command('change.review', { changeId: f.change.id, candidateId, decision: 'accepted', comment: '浏览器明确接受' });
    const adopted = await command('change.adopt', { changeId: f.change.id, candidateId });
    const cli = await run(['changes', '--project', f.root, '--change', f.change.id], { env: {} });
    assert.equal(cli.adoption.revisionId, adopted.adoption.revisionId); assert.equal(cli.candidates[0].review.comment, '浏览器明确接受');
    assert.equal((await fetch(editor.url + '/api/fwv/changes?unexpected=1')).status, 400);
  } finally { await editor.close(); }
});
