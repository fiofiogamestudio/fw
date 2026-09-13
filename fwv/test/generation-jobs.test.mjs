import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { GenerationJobs } from '../src/generation/jobs.mjs';

const sleep = duration => new Promise(resolve => setTimeout(resolve, duration));
const request = overrides => ({ requestId: randomUUID(), name: 'Generated test icon', prompt: 'A small orange cat icon on a transparent background', size: '1024x1024', quality: 'medium', background: 'transparent', ...overrides });

async function waitUntil(predicate, message = 'Generation job did not settle') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(message);
}

function deferredProvider() {
  const calls = [];
  const secret = 'never-serialize-this-test-api-key';
  return {
    calls, apiKey: secret,
    publicConfig: () => ({ keyConfigured: true, protocol: 'openai-images', model: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1' }),
    generate(...args) {
      return new Promise((resolve, reject) => calls.push({ args, resolve, reject }));
    },
  };
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-generation-jobs-'));
  const project = new FwvProject(root);
  await project.init({ name: 'Generation job tests' });
  const provider = deferredProvider();
  const jobs = new GenerationJobs({ project, provider });
  t.after(async () => {
    await jobs.close();
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup path.');
    await fs.rm(root, { recursive: true, force: true });
  });
  const buffer = await sharp({ create: { width: 12, height: 16, channels: 4, background: { r: 230, g: 160, b: 60, alpha: 0.8 } } }).png().toBuffer();
  const result = params => ({ buffer, mime: 'image/png', name: 'generated.png', usage: { total_tokens: 12 }, requestId: 'provider-request-id', revisedPrompt: 'An orange cat icon', request: { model: 'gpt-image-1', prompt: params.prompt, size: params.size, quality: params.quality, background: params.background } });
  return { root, project, provider, jobs, buffer, result };
}

test('generation reserves request IDs before async work and imports one result with provenance', async t => {
  const { project, provider, jobs, buffer, result } = await setup(t);
  const params = request();
  const [first, duplicate] = await Promise.all([jobs.start(params), jobs.start({ ...params })]);
  assert.equal(first.id, duplicate.id);
  await waitUntil(() => provider.calls.length === 1);
  assert.equal(jobs.list().length, 1);
  await assert.rejects(jobs.start({ ...params, prompt: 'A conflicting paid request' }));
  provider.calls[0].resolve(result(params));
  const asset = await waitUntil(async () => (await project.snapshot()).assets[0]);
  const revision = asset.revisions[0];
  assert.equal(asset.kind, 'image');
  assert.equal(revision.metadata.image.width, 12);
  assert.equal(revision.metadata.image.height, 16);
  assert.ok(revision.metadata.generation);
  assert.ok(revision.recipe.generation);
  assert.ok(JSON.stringify(revision.metadata.generation).includes(params.prompt));
  const output = revision.files.find(file => file.role !== 'reference');
  assert.deepEqual((await project.readArtifact({ assetId: asset.id, revisionId: revision.id, fileName: output.name })).buffer, buffer);
  const repeated = await jobs.start(params);
  assert.equal(repeated.id, first.id);
  assert.equal(provider.calls.length, 1);
  assert.equal((await project.snapshot()).assets.length, 1);
  assert.equal((await project.validateRevision({ assetId: asset.id, revisionId: revision.id })).status, 'passed');
  const exported = await project.exportAsset({ assetId: asset.id, revisionId: revision.id });
  assert.equal(exported.manifest.assetId, asset.id);
  assert.ok(!JSON.stringify({ jobs: jobs.list(), asset }).includes(provider.apiKey));
  assert.equal(jobs.get({ requestId: params.requestId }).id, first.id);
  assert.equal(jobs.get({ jobId: first.id }).id, first.id);
  assert.equal(jobs.get({ jobId: 'missing' }), null);
});

test('jobs retain compatible quality and bounded custom dimensions without narrowing provider capabilities', async t => {
  const { project, provider, jobs, result } = await setup(t);
  const params = request({ size: '768x512', quality: 'hd', background: 'auto' });
  const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1);
  assert.equal(provider.calls[0].args[0].size, params.size);
  assert.equal(provider.calls[0].args[0].quality, params.quality);
  provider.calls[0].resolve(result(params));
  await waitUntil(() => jobs.get({ jobId: started.id }).status === 'succeeded');
  const asset = (await project.snapshot()).assets[0];
  assert.equal(asset.revisions[0].metadata.generation.size, params.size);
  assert.equal(asset.revisions[0].metadata.generation.quality, params.quality);
  for (const invalid of [{ size: '0x512' }, { size: '9999x9999' }, { quality: 'ultra' }, { prompt: 'x'.repeat(8001) }]) {
    await assert.rejects(jobs.start(request(invalid)));
  }
  assert.equal(provider.calls.length, 1);
  assert.equal(jobs.list().length, 1);
});

test('registered image reference bytes are copied into generated revision and arbitrary paths are rejected', async t => {
  const { project, provider, jobs, buffer, result } = await setup(t);
  const reference = await project.importImage({ name: 'Original', fileName: 'reference.png', buffer });
  const params = request({ reference: { assetId: reference.id, revisionId: reference.selectedRevisionId, fileName: 'reference.png' } });
  const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1);
  const call = provider.calls[0].args[0];
  assert.deepEqual(call.reference.buffer, buffer);
  provider.calls[0].resolve(result(params));
  const asset = await waitUntil(async () => (await project.snapshot()).assets.find(asset => asset.id !== reference.id));
  const revision = asset.revisions[0];
  const storedReference = revision.files.find(file => file.role === 'reference');
  assert.ok(storedReference);
  assert.deepEqual((await project.readArtifact({ assetId: asset.id, revisionId: revision.id, fileName: storedReference.name })).buffer, buffer);
  const forbidden = await jobs.start(request({ reference: { assetId: reference.id, revisionId: reference.selectedRevisionId, fileName: '../outside.png' } }));
  await waitUntil(() => jobs.get({ jobId: forbidden.id }).status === 'failed');
  assert.equal(provider.calls.length, 1);
  assert.ok(jobs.get({ jobId: started.id }));
});

test('a failed local import keeps generated bytes available and save retries without generation', async t => {
  const { project, provider, jobs, result } = await setup(t);
  const originalImport = project.importAsset.bind(project);
  let attempts = 0;
  project.importAsset = async params => {
    attempts++;
    if (attempts === 1) throw new Error('Simulated local disk failure');
    return originalImport(params);
  };
  const params = request();
  const job = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1);
  provider.calls[0].resolve(result(params));
  await waitUntil(() => jobs.get({ jobId: job.id }).status === 'ready');
  assert.equal((await project.snapshot()).assets.length, 0);
  const saves = await Promise.allSettled([jobs.save({ jobId: job.id }), jobs.save({ jobId: job.id })]);
  assert.ok(saves.some(result => result.status === 'fulfilled'));
  assert.equal((await project.snapshot()).assets.length, 1);
  assert.equal(provider.calls.length, 1);
  assert.equal(attempts, 2);
});

test('definitive authentication failure is failed and duplicate submission never retries', async t => {
  const { project, provider, jobs } = await setup(t);
  const params = request();
  const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1);
  provider.calls[0].reject(Object.assign(new Error('Provider rejected authentication'), { status: 401, code: 'PROVIDER_AUTH', uncertain: false }));
  await waitUntil(() => jobs.get({ jobId: started.id }).status === 'failed');
  assert.equal((await jobs.start(params)).id, started.id);
  assert.equal(provider.calls.length, 1);
  assert.equal((await project.snapshot()).assets.length, 0);
  await assert.rejects(jobs.save({ jobId: started.id }));
});

test('uncertain provider timeout remains unknown with no automatic or duplicate-request retry', async t => {
  const { project, provider, jobs } = await setup(t);
  const params = request();
  const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1);
  provider.calls[0].reject(Object.assign(new Error('Response timed out after dispatch'), { code: 'PROVIDER_TIMEOUT', uncertain: true }));
  await waitUntil(() => jobs.get({ jobId: started.id }).status === 'unknown');
  await sleep(40);
  assert.equal((await jobs.start(params)).id, started.id);
  assert.equal(provider.calls.length, 1);
  assert.equal((await project.snapshot()).assets.length, 0);
});

test('generation rejects a registered non-image asset as reference before provider invocation', async t => {
  const { project, provider, jobs, buffer } = await setup(t);
  const other = await project.importAsset({ name: 'Not an image asset', kind: 'spine', files: [{ name: 'page.png', mime: 'image/png', role: 'texture', buffer }] });
  const started = await jobs.start(request({ reference: { assetId: other.id, revisionId: other.selectedRevisionId, fileName: 'page.png' } }));
  await waitUntil(() => jobs.get({ jobId: started.id }).status === 'failed');
  assert.equal(provider.calls.length, 0);
  assert.equal((await project.snapshot()).assets.length, 1);
});

test('cancel aborts in-flight request and preserves uncertain outcome without importing', async t => {
  const { project, provider, jobs } = await setup(t);
  const started = await jobs.start(request());
  await waitUntil(() => provider.calls.length === 1);
  const call = provider.calls[0];
  const signal = call.args[0].signal;
  assert.ok(signal instanceof AbortSignal);
  signal.addEventListener('abort', () => call.reject(Object.assign(new Error('Cancelled after dispatch'), { uncertain: true })), { once: true });
  await jobs.cancel({ jobId: started.id });
  assert.equal(signal.aborted, true);
  await waitUntil(() => jobs.get({ jobId: started.id }).status === 'unknown');
  assert.equal((await project.snapshot()).assets.length, 0);
  assert.equal(provider.calls.length, 1);
});

test('generation captures caller input and public snapshots cannot mutate private job state', async t => {
  const { provider, jobs } = await setup(t);
  const params = request();
  const originalPrompt = params.prompt;
  const pending = jobs.start(params);
  params.prompt = 'Caller changed its own object after submission';
  const started = await pending;
  await waitUntil(() => provider.calls.length === 1);
  assert.equal(provider.calls[0].args[0].prompt, originalPrompt);
  const listed = jobs.list()[0];
  listed.status = 'succeeded';
  if (listed.request) listed.request.prompt = 'Mutated public snapshot';
  assert.notEqual(jobs.get({ jobId: started.id }).status, 'succeeded');
  provider.calls[0].reject(Object.assign(new Error('End isolated test'), { uncertain: false }));
  await waitUntil(() => jobs.get({ jobId: started.id }).status === 'failed');
});

test('closing job service aborts every active provider request and rejects further work', async t => {
  const { project, provider, jobs } = await setup(t);
  const first = await jobs.start(request());
  const second = await jobs.start(request());
  await waitUntil(() => provider.calls.length === 2);
  for (const call of provider.calls) call.args[0].signal.addEventListener('abort', () => call.reject(Object.assign(new Error('Service closed after dispatch'), { uncertain: true })), { once: true });
  jobs.close();
  for (const call of provider.calls) assert.equal(call.args[0].signal.aborted, true);
  await waitUntil(() => [first, second].every(job => jobs.get({ jobId: job.id }).status === 'unknown'));
  await assert.rejects(jobs.start(request()));
  assert.equal(provider.calls.length, 2);
  assert.equal((await project.snapshot()).assets.length, 0);
});

test('generated image processing preserves generation origin and exact reference through repeated processing and export', async t => {
  const { root, project, provider, jobs, buffer, result } = await setup(t);
  const reference = await project.importImage({ name: 'Original reference', fileName: 'original.png', buffer });
  const params = request({ reference: { assetId: reference.id, revisionId: reference.selectedRevisionId, fileName: 'original.png' } });
  const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1);
  provider.calls[0].resolve(result(params));
  const succeeded = await waitUntil(() => { const job = jobs.get({ jobId: started.id }); return job.status === 'succeeded' ? job : null; });
  const first = await project.processImage({ assetId: succeeded.assetId, revisionId: succeeded.revisionId, recipe: { width: 32, height: 32, padding: 2 } });
  const second = await project.processImage({ assetId: succeeded.assetId, revisionId: first.selectedRevisionId, recipe: { width: 48, height: 48, padding: 4 } });
  const revision = second.revisions.at(-1);
  assert.equal(revision.metadata.image.width, 48);
  assert.equal(revision.metadata.generation.prompt, params.prompt);
  assert.equal(revision.metadata.generation.model, 'gpt-image-1');
  assert.equal(revision.metadata.generation.originRevisionId, succeeded.revisionId);
  assert.equal(revision.metadata.generation.reference.assetId, reference.id);
  const referenceFile = revision.files.find(file => file.role === 'reference');
  assert.ok(referenceFile);
  assert.equal(referenceFile.name, revision.metadata.generation.reference.sourceFile);
  assert.deepEqual((await project.readArtifact({ assetId: second.id, revisionId: revision.id, fileName: referenceFile.name })).buffer, buffer);
  const exported = await project.exportAsset({ assetId: second.id, revisionId: revision.id });
  assert.equal(exported.manifest.validation.status, 'passed');
  assert.equal(exported.manifest.metadata.generation.originRevisionId, succeeded.revisionId);
  assert.equal(exported.manifest.metadata.generation.prompt, params.prompt);
  assert.equal(exported.manifest.metadata.generation.model, 'gpt-image-1');
  const exportedReference = exported.manifest.files.find(file => file.role === 'reference');
  assert.deepEqual(await fs.readFile(path.join(root, exported.path, exportedReference.path)), buffer);
  assert.ok(!JSON.stringify(exported.manifest).includes(provider.apiKey));
});


test('staged output and exact reference survive a fresh job service and saving never calls the provider again', async t => {
  const { root, project, provider, jobs, buffer, result } = await setup(t);
  const reference = await project.importImage({ name: 'Recovery reference', fileName: 'original.png', buffer });
  const params = request({ reference: { assetId: reference.id, revisionId: reference.selectedRevisionId, fileName: 'original.png' } });
  const originalImport = project.importAsset.bind(project);
  project.importAsset = async () => { throw new Error('Injected import failure'); };
  const started = await jobs.start(params); await waitUntil(() => provider.calls.length === 1);
  provider.calls[0].resolve(result(params));
  const waiting = await waitUntil(() => { const job = jobs.get({ jobId: started.id }); return job.status === 'ready' && job; });
  assert.equal(waiting.durability, 'staged'); assert.ok(waiting.recoveryPath);
  const manifest = JSON.parse(await fs.readFile(path.join(root, waiting.recoveryPath), 'utf8'));
  assert.equal(manifest.metadata.generation.providerRequestId, 'provider-request-id');
  const generatedAt = manifest.metadata.generation.generatedAt;
  await jobs.close();
  const restarted = new GenerationJobs({ project: new FwvProject(root), provider: { publicConfig: () => ({ keyConfigured: false }), generate() { throw new Error('Recovery must not call provider'); } } });
  t.after(() => restarted.close());
  await restarted.initialize();
  assert.equal(restarted.get({ requestId: params.requestId }).status, 'ready');
  assert.equal((await restarted.start(params)).id, started.id, 'Persisted request lookup does not need provider credentials.');
  const saved = await restarted.save({ jobId: started.id });
  assert.equal(saved.status, 'succeeded'); assert.equal(saved.durability, 'saved');
  const asset = (await project.snapshot()).assets.find(asset => asset.id === saved.assetId);
  assert.equal(asset.revisions.length, 1); const revision = asset.revisions[0];
  assert.equal(revision.metadata.generation.generatedAt, generatedAt);
  assert.equal(revision.metadata.generation.prompt, params.prompt);
  for (const file of revision.files) assert.deepEqual((await project.readArtifact({ assetId: asset.id, revisionId: revision.id, fileName: file.name })).buffer, buffer);
  assert.equal(revision.metadata.generation.reference.assetId, reference.id);
  assert.equal(provider.calls.length, 1);
  assert.equal(JSON.stringify(await fs.readFile(path.join(root, '.fwv', 'generation', started.id, 'job.json'), 'utf8')).includes(provider.apiKey), false);
  await assert.rejects(fs.access(path.join(root, waiting.recoveryPath)), { code: 'ENOENT' });
  project.importAsset = originalImport;
});

test('a committed import with a lost response reconciles one receipt without changing the selected revision', async t => {
  const { root, project, provider, jobs, result } = await setup(t);
  const originalImport = project.importAsset.bind(project);
  project.importAsset = async params => { await originalImport(params); throw new Error('Response lost after manifest commit'); };
  const params = request(); const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1); provider.calls[0].resolve(result(params));
  await waitUntil(() => jobs.get({ jobId: started.id }).status === 'succeeded'); await jobs.close();
  const original = (await project.snapshot()).assets[0], originalRevisionId = original.revisions[0].id;
  const processed = await project.processImage({ assetId: original.id, revisionId: originalRevisionId, recipe: { width: 24, height: 24 } });
  const restarted = new GenerationJobs({ project: new FwvProject(root), provider }); t.after(() => restarted.close());
  await restarted.initialize();
  const [first, second] = await Promise.all([restarted.save({ jobId: started.id }), restarted.save({ jobId: started.id })]);
  assert.equal(first.status, 'succeeded'); assert.equal(first.assetId, original.id); assert.equal(second.assetId, original.id);
  assert.equal(first.revisionId, originalRevisionId);
  const snapshot = await project.snapshot(); assert.equal(snapshot.assets.length, 1);
  assert.equal(snapshot.assets[0].selectedRevisionId, processed.selectedRevisionId);
  assert.equal(snapshot.assets[0].revisions.length, 2); assert.equal(provider.calls.length, 1);
});

test('staged commit survives a failed success-journal update and reconciles after restart', async t => {
  const { root, project, provider, jobs, result } = await setup(t);
  const write = jobs.recovery.write.bind(jobs.recovery);
  jobs.recovery.write = async record => { if (record.status === 'succeeded') throw new Error('Injected journal write failure'); return write(record); };
  const params = request(); const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1); provider.calls[0].resolve(result(params));
  const first = await waitUntil(() => { const job = jobs.get({ jobId: started.id }); return job.status === 'succeeded' && job; });
  assert.match(first.journalError, /journal write failure/); await jobs.close();
  const restarted = new GenerationJobs({ project: new FwvProject(root), provider }); t.after(() => restarted.close());
  await restarted.initialize(); assert.equal(restarted.get({ jobId: started.id }).status, 'succeeded');
  const saved = await restarted.save({ jobId: started.id });
  assert.equal(saved.assetId, first.assetId); assert.equal(saved.revisionId, first.revisionId);
  assert.equal(saved.journalError, undefined); assert.equal((await project.snapshot()).assets.length, 1); assert.equal(provider.calls.length, 1);
});

test('dispatch intent persists across restart and never automatically resends an unknown request', async t => {
  const { root, provider, jobs } = await setup(t);
  const params = request(); const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1);
  const restarted = new GenerationJobs({ project: new FwvProject(root), provider }); t.after(() => restarted.close());
  await restarted.initialize();
  assert.equal(restarted.get({ jobId: started.id }).status, 'unknown');
  assert.equal((await restarted.start(params)).id, started.id); assert.equal(provider.calls.length, 1);
  await assert.rejects(restarted.start({ ...params, prompt: 'Changed paid request' }), /相同请求编号/);
  provider.calls[0].reject(Object.assign(new Error('End isolated request'), { uncertain: true }));
  await waitUntil(() => jobs.get({ jobId: started.id }).status === 'unknown');
});

test('a failed reservation prevents dispatch and failed staging explicitly remains volatile until local retry', async t => {
  const { project, provider, jobs, result } = await setup(t);
  const reserve = jobs.recovery.reserve.bind(jobs.recovery);
  jobs.recovery.reserve = async () => { throw new Error('Read-only recovery storage'); };
  await assert.rejects(jobs.start(request()), /任务未派发/); assert.equal(provider.calls.length, 0);
  jobs.recovery.reserve = reserve;
  const stage = jobs.recovery.stage.bind(jobs.recovery);
  jobs.recovery.stage = async () => { throw new Error('Disk full'); };
  const params = request(); const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1); provider.calls[0].resolve(result(params));
  const waiting = await waitUntil(() => { const job = jobs.get({ jobId: started.id }); return job.status === 'ready' && job; });
  assert.equal(waiting.durability, 'memory'); assert.match(waiting.error, /尚未落盘/); assert.match(waiting.error, /请勿关闭服务/);
  assert.equal((await project.snapshot()).assets.length, 0);
  jobs.recovery.stage = stage;
  const saved = await jobs.save({ jobId: started.id }); assert.equal(saved.status, 'succeeded'); assert.equal(provider.calls.length, 1);
});

test('corrupted staged bytes fail closed on restart and are preserved without an import or model retry', async t => {
  const { root, project, provider, jobs, result } = await setup(t);
  project.importAsset = async () => { throw new Error('Injected import failure'); };
  const params = request(); const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1); provider.calls[0].resolve(result(params));
  await waitUntil(() => jobs.get({ jobId: started.id }).status === 'ready'); await jobs.close();
  const target = path.join(root, '.fwv', 'generation', started.id, 'generated.png');
  const changed = await fs.readFile(target); changed[changed.length - 1] ^= 1; await fs.writeFile(target, changed);
  const restarted = new GenerationJobs({ project: new FwvProject(root), provider }); t.after(() => restarted.close());
  await restarted.initialize(); const recovered = restarted.get({ jobId: started.id });
  assert.equal(recovered.status, 'unknown'); assert.equal(recovered.durability, 'unverified'); assert.match(recovered.error, /hash mismatch/);
  await assert.rejects(restarted.save({ jobId: started.id })); assert.equal((await restarted.start(params)).id, started.id);
  assert.deepEqual(await fs.readFile(target), changed); assert.equal((await project.snapshot()).assets.length, 0); assert.equal(provider.calls.length, 1);
});


test('concurrent restored services reconcile a completed receipt when one removes staging before the other reads', async t => {
  const { root, project, provider, jobs, result } = await setup(t);
  project.importAsset = async () => { throw new Error('Injected import failure'); };
  const params = request(); const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1); provider.calls[0].resolve(result(params));
  await waitUntil(() => jobs.get({ jobId: started.id }).status === 'ready'); await jobs.close();
  const first = new GenerationJobs({ project: new FwvProject(root), provider });
  const second = new GenerationJobs({ project: new FwvProject(root), provider });
  t.after(async () => { await first.close(); await second.close(); });
  await first.initialize(); await second.initialize();
  let releaseRead, readStarted;
  const gate = new Promise(resolve => { releaseRead = resolve; });
  const reached = new Promise(resolve => { readStarted = resolve; });
  const read = second.recovery.read.bind(second.recovery);
  second.recovery.read = async (...args) => { readStarted(); await gate; return read(...args); };
  const slow = second.save({ jobId: started.id }); await reached;
  const fast = await first.save({ jobId: started.id }); assert.equal(fast.status, 'succeeded');
  releaseRead(); const reconciled = await slow;
  assert.equal(reconciled.status, 'succeeded'); assert.equal(reconciled.assetId, fast.assetId); assert.equal(reconciled.revisionId, fast.revisionId);
  const third = new GenerationJobs({ project: new FwvProject(root), provider }); await third.initialize();
  assert.equal(third.get({ jobId: started.id }).status, 'succeeded'); await third.close();
  assert.equal((await project.snapshot()).assets.length, 1); assert.equal(provider.calls.length, 1);
});


test('a stale unknown journal is repaired from its verified original receipt on restart', async t => {
  const { root, project, provider, jobs, result } = await setup(t);
  const params = request(); const started = await jobs.start(params);
  await waitUntil(() => provider.calls.length === 1); provider.calls[0].resolve(result(params));
  const saved = await waitUntil(() => { const job = jobs.get({ jobId: started.id }); return job.status === 'succeeded' && job; });
  await jobs.close();
  const target = path.join(root, '.fwv', 'generation', started.id, 'job.json');
  const journal = JSON.parse(await fs.readFile(target, 'utf8'));
  Object.assign(journal.job, { status: 'unknown', stage: 'recovery-failed', durability: 'unverified', assetId: null, revisionId: null });
  await fs.writeFile(target, JSON.stringify(journal));
  const restarted = new GenerationJobs({ project: new FwvProject(root), provider }); await restarted.initialize();
  const recovered = restarted.get({ jobId: started.id });
  assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.assetId, saved.assetId); assert.equal(recovered.revisionId, saved.revisionId);
  assert.equal((await project.snapshot()).assets.length, 1); assert.equal(provider.calls.length, 1); await restarted.close();
});
