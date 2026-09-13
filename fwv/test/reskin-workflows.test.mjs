import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { GenerationJobs } from '../src/generation/jobs.mjs';
import { importSpine, extractSpinePart } from '../src/spine/application.mjs';
import { ReskinWorkflows } from '../src/workflows/reskin.mjs';

const SECRET = 'sk-reskin-workflow-fixture-never-real';
const REGIONS = ['body', 'head', 'weapon'];

async function fixture() {
  const definitions = [
    { name: 'body', x: 2, y: 2, width: 10, height: 12, color: [190, 70, 50] },
    { name: 'head', x: 20, y: 2, width: 8, height: 8, color: [40, 170, 70] },
    { name: 'weapon', x: 34, y: 2, width: 4, height: 12, color: [60, 70, 190] },
  ];
  const pixels = Buffer.alloc(64 * 64 * 4);
  for (const region of definitions) {
    for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
      if ((x === 0 || x === region.width - 1) && (y === 0 || y === region.height - 1)) continue;
      pixels.set([...region.color, 255], ((region.y + y) * 64 + region.x + x) * 4);
    }
  }
  const page = await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
  const skeleton = {
    skeleton: { spine: '4.2.120', x: 0, y: 0, width: 30, height: 40 },
    bones: [{ name: 'root' }],
    slots: definitions.map(region => ({ name: `${region.name}-slot`, bone: 'root', attachment: region.name })),
    skins: [{ name: 'default', attachments: Object.fromEntries(definitions.map(region => [
      `${region.name}-slot`, { [region.name]: { type: 'region', path: region.name, width: region.width, height: region.height } },
    ])) }],
    animations: { idle: {} },
  };
  const atlas = `hero.png\nsize:64,64\nfilter:Nearest,Nearest\npma:false\n${definitions.map(region => `${region.name}\nbounds:${region.x},${region.y},${region.width},${region.height}\n`).join('')}`;
  return [
    { name: 'hero.json', buffer: Buffer.from(JSON.stringify(skeleton)) },
    { name: 'hero.atlas', buffer: Buffer.from(atlas) },
    { name: 'hero.png', buffer: page },
  ];
}

class DeferredProvider {
  #key = SECRET;
  constructor(onDispatch) { this.calls = []; this.onDispatch = onDispatch; }
  publicConfig() { return { baseUrl: 'https://images.fixture.invalid/v1', model: 'gpt-image-2', protocol: 'gpt-image', keyConfigured: Boolean(this.#key), keySource: 'session', canGenerate: true }; }
  async generate(args) {
    if (this.onDispatch) await this.onDispatch(args);
    return new Promise((resolve, reject) => {
      const call = { args, resolve, reject, settled: false };
      this.calls.push(call);
      const cancelled = () => {
        if (call.settled) return;
        call.settled = true;
        reject(Object.assign(new Error('Request was cancelled after dispatch; remote completion is unknown.'), { uncertain: true }));
      };
      if (args.signal.aborted) cancelled(); else args.signal.addEventListener('abort', cancelled, { once: true });
    });
  }
  async complete(index, color) {
    const call = this.calls[index]; assert.ok(call); assert.equal(call.settled, false);
    const metadata = await sharp(call.args.reference.buffer).metadata();
    const buffer = await sharp({ create: { width: metadata.width, height: metadata.height, channels: 4, background: color } }).png().toBuffer();
    call.settled = true;
    call.resolve({ buffer, mime: 'image/png', name: 'generated.png', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }, requestId: `fixture-response-${index}`, revisedPrompt: null,
      request: { ...this.publicConfig(), prompt: call.args.prompt, size: call.args.size, quality: call.args.quality, background: call.args.background } });
  }
  fail(index, message = 'Provider rejected generation.') {
    const call = this.calls[index]; assert.ok(call); call.settled = true; call.reject(Object.assign(new Error(message), { uncertain: false }));
  }
}

async function waitFor(read, predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = await read();
    if (predicate(result)) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(result)}`);
}

async function setup(t, onDispatch) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-reskin-workflows-'));
  const project = new FwvProject(root); await project.init({ name: 'Reskin workflow tests' });
  const sourceFiles = await fixture();
  const template = await importSpine(project, { name: 'Three-part hero', files: sourceFiles });
  const provider = new DeferredProvider(onDispatch ? args => onDispatch({ args, project }) : undefined);
  const generationJobs = new GenerationJobs({ project, provider });
  const workflows = new ReskinWorkflows({ project, generationJobs });
  const controllers = [{ workflows, generationJobs }];
  t.after(async () => {
    for (const controller of controllers) { await controller.workflows.close(); controller.generationJobs.close(); }
    await delay(150);
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup.');
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = options => workflows.create({ templateAssetId: template.id, templateRevisionId: template.selectedRevisionId,
    name: 'Violet hero', brief: 'A purple armored adventurer', style: 'Readable game art', ...options });
  const view = workflowId => workflows.get({ workflowId });
  const settled = (workflowId, requestId, expected) => waitFor(() => view(workflowId), value => value.attempts.some(attempt => attempt.requestId === requestId && expected.includes(attempt.status)), `attempt ${requestId} reaching ${expected}`);
  return { root, project, sourceFiles, template, provider, generationJobs, workflows, controllers, create, view, settled };
}

async function candidatePart(project, attempt, regionName) {
  return extractSpinePart(project, { assetId: attempt.candidateAssetId, revisionId: attempt.candidateRevisionId, regionName });
}

test('creating a reskin workflow records durable intent without a paid request; generation reserves before dispatch', async t => {
  let observedReserved = false;
  const setupResult = await setup(t, async ({ args, project }) => {
    assert.ok(args.reference?.buffer, 'Paid request must receive the generated part guide as its reference.');
    const snapshot = await project.snapshot();
    const doc = snapshot.assets.filter(asset => asset.kind === 'reskin').flatMap(asset => asset.revisions.map(revision => revision.metadata.reskin));
    observedReserved = doc.some(view => view?.attempts?.some(attempt => attempt.requestId === 'first-paid-request'));
    assert.equal(observedReserved, true, 'The attempt must already exist on disk before provider dispatch.');
  });
  const { project, provider, workflows, create, settled, template, sourceFiles } = setupResult;
  const created = await create({ partNotes: { weapon: 'A silver blade' } });
  assert.equal(provider.calls.length, 0);
  assert.ok(created.assetId); assert.ok(created.revisionId); assert.equal(created.preserveAlpha, true);
  assert.equal((await workflows.list()).some(view => view.assetId === created.assetId), true);
  await workflows.generate({ workflowId: created.assetId, requestId: 'first-paid-request' });
  await waitFor(() => provider.calls, calls => calls.length === 1, 'one provider dispatch');
  assert.equal(observedReserved, true);
  assert.match(provider.calls[0].args.prompt, /purple armored adventurer/i);
  assert.match(provider.calls[0].args.prompt, /silver blade/i);
  await provider.complete(0, '#bb44dd');
  const completed = await settled(created.assetId, 'first-paid-request', ['succeeded']);
  const attempt = completed.attempts.find(item => item.requestId === 'first-paid-request');
  assert.equal(completed.selectedCandidateId, attempt.id);
  assert.ok(attempt.sheetAssetId); assert.ok(attempt.sheetRevisionId);
  assert.ok(attempt.candidateAssetId); assert.notEqual(attempt.candidateAssetId, template.id);
  assert.deepEqual([...attempt.regionNames].sort(), [...REGIONS].sort());
  for (const file of sourceFiles) {
    assert.deepEqual((await project.readArtifact({ assetId: template.id, revisionId: template.selectedRevisionId, fileName: file.name })).buffer, file.buffer);
  }
  assert.equal((await project.snapshot()).assets.find(asset => asset.id === template.id).revisions.length, 1);
  assert.equal(JSON.stringify(await project.snapshot()).includes(SECRET), false);
  assert.equal(provider.calls.length, 1);
});

test('subset regeneration starts from the selected candidate and keeps unselected parts unchanged', async t => {
  const { project, workflows, provider, create, settled } = await setup(t);
  const created = await create();
  await workflows.generate({ workflowId: created.assetId, requestId: 'all-red' });
  await waitFor(() => provider.calls, calls => calls.length === 1, 'first generation');
  await provider.complete(0, '#ee2222');
  const first = (await settled(created.assetId, 'all-red', ['succeeded'])).attempts.find(item => item.requestId === 'all-red');
  const firstBody = await candidatePart(project, first, 'body');
  const firstWeapon = await candidatePart(project, first, 'weapon');
  const firstHead = await candidatePart(project, first, 'head');
  await workflows.generate({ workflowId: created.assetId, requestId: 'head-blue', regionNames: ['head'], partNotes: { head: 'Blue helmet only' } });
  await waitFor(() => provider.calls, calls => calls.length === 2, 'head-only generation');
  await provider.complete(1, '#2222ee');
  const secondView = await settled(created.assetId, 'head-blue', ['succeeded']);
  const second = secondView.attempts.find(item => item.requestId === 'head-blue');
  assert.deepEqual(second.regionNames, ['head']);
  assert.deepEqual(await candidatePart(project, second, 'body'), firstBody);
  assert.deepEqual(await candidatePart(project, second, 'weapon'), firstWeapon);
  assert.notDeepEqual(await candidatePart(project, second, 'head'), firstHead);
  await workflows.select({ workflowId: created.assetId, attemptId: first.id });
  assert.equal((await workflows.get({ workflowId: created.assetId })).selectedCandidateId, first.id);
  assert.equal(provider.calls.length, 2);
});

test('the same request ID remains deduplicated after workflow and job controllers restart', async t => {
  const { project, workflows, generationJobs, provider, controllers, create, settled } = await setup(t);
  const created = await create();
  await workflows.generate({ workflowId: created.assetId, requestId: 'durable-request' });
  await waitFor(() => provider.calls, calls => calls.length === 1, 'generation');
  await provider.complete(0, '#55aa55');
  const before = await settled(created.assetId, 'durable-request', ['succeeded']);
  await workflows.close(); generationJobs.close();
  const restartedJobs = new GenerationJobs({ project, provider });
  const restarted = new ReskinWorkflows({ project, generationJobs: restartedJobs });
  controllers.push({ workflows: restarted, generationJobs: restartedJobs });
  const after = await restarted.generate({ workflowId: created.assetId, requestId: 'durable-request' });
  assert.equal(after.attempts.length, before.attempts.length);
  assert.equal(after.attempts[0].id, before.attempts[0].id);
  assert.equal(after.attempts[0].candidateAssetId, before.attempts[0].candidateAssetId);
  assert.equal(provider.calls.length, 1);
});

test('restart exposes an interrupted attempt as unknown without resubmitting a paid request', async t => {
  const { project, workflows, generationJobs, provider, controllers, create } = await setup(t);
  const created = await create();
  await workflows.generate({ workflowId: created.assetId, requestId: 'interrupted-request' });
  await waitFor(() => provider.calls, calls => calls.length === 1, 'in-flight generation');
  await workflows.close(); generationJobs.close();
  const restartedJobs = new GenerationJobs({ project, provider });
  const restarted = new ReskinWorkflows({ project, generationJobs: restartedJobs });
  controllers.push({ workflows: restarted, generationJobs: restartedJobs });
  const recovered = await restarted.get({ workflowId: created.assetId });
  assert.equal(recovered.attempts.find(item => item.requestId === 'interrupted-request').status, 'unknown');
  const duplicate = await restarted.generate({ workflowId: created.assetId, requestId: 'interrupted-request' });
  assert.equal(duplicate.attempts.length, 1);
  assert.equal(provider.calls.length, 1);
  assert.equal((await project.snapshot()).assets.filter(asset => asset.kind === 'spine').length, 1);
});

test('cancelling a dispatched generation retains uncertainty and creates no candidate', async t => {
  const { project, workflows, provider, create, settled } = await setup(t);
  const created = await create();
  const started = await workflows.generate({ workflowId: created.assetId, requestId: 'cancel-request' });
  await waitFor(() => provider.calls, calls => calls.length === 1, 'dispatched generation');
  await workflows.cancel({ workflowId: created.assetId, attemptId: started.attempts[0].id });
  const result = await settled(created.assetId, 'cancel-request', ['unknown']);
  assert.equal(result.attempts[0].candidateAssetId == null, true);
  await assert.rejects(workflows.assemble({ workflowId: created.assetId, attemptId: result.attempts[0].id }));
  assert.equal((await workflows.get({ workflowId: created.assetId })).attempts[0].status, 'unknown', 'A failed local assemble request cannot turn unknown remote output into a supposedly retained image.');
  assert.equal(provider.calls.length, 1);
  assert.equal((await project.snapshot()).assets.filter(asset => asset.kind === 'spine').length, 1);
});

test('definitive provider failure never assembles or retries', async t => {
  const { project, workflows, provider, create, settled } = await setup(t);
  const created = await create();
  await workflows.generate({ workflowId: created.assetId, requestId: 'rejected-request' });
  await waitFor(() => provider.calls, calls => calls.length === 1, 'dispatched generation');
  provider.fail(0);
  const result = await settled(created.assetId, 'rejected-request', ['failed']);
  assert.equal(result.attempts[0].candidateAssetId == null, true);
  await assert.rejects(workflows.assemble({ workflowId: created.assetId, attemptId: result.attempts[0].id }));
  assert.equal((await workflows.get({ workflowId: created.assetId })).attempts[0].status, 'failed');
  assert.equal(provider.calls.length, 1);
  assert.equal((await project.snapshot()).assets.filter(asset => asset.kind === 'spine').length, 1);
});

test('local assembly failure retains the generated sheet and retries locally without paying again', async t => {
  const { project, workflows, provider, create, settled } = await setup(t);
  const created = await create();
  const importAsset = project.importAsset.bind(project);
  const mocked = t.mock.method(project, 'importAsset', async args => {
    if (args.kind === 'spine') throw new Error('Injected candidate import failure');
    return importAsset(args);
  });
  await workflows.generate({ workflowId: created.assetId, requestId: 'local-save-retry' });
  await waitFor(() => provider.calls, calls => calls.length === 1, 'dispatched generation');
  await provider.complete(0, '#44bbbb');
  const ready = await settled(created.assetId, 'local-save-retry', ['ready']);
  const attempt = ready.attempts[0];
  assert.ok(attempt.sheetAssetId); assert.ok(attempt.sheetRevisionId); assert.equal(attempt.candidateAssetId == null, true);
  mocked.mock.restore();
  await workflows.assemble({ workflowId: created.assetId, attemptId: attempt.id });
  const result = await settled(created.assetId, 'local-save-retry', ['succeeded']);
  assert.ok(result.attempts[0].candidateAssetId);
  assert.equal(result.attempts[0].sheetAssetId, attempt.sheetAssetId);
  assert.equal(provider.calls.length, 1);
});

test('restart restores the exact staged sheet into its reskin attempt and assembles without another generation', async t => {
  const { project, workflows, generationJobs, provider, controllers, create, settled } = await setup(t);
  const created = await create();
  const importAsset = project.importAsset.bind(project);
  const mocked = t.mock.method(project, 'importAsset', async args => {
    if (args.kind === 'image' && args.files.some(file => file.role === 'image')) throw new Error('Injected generated-sheet save failure');
    return importAsset(args);
  });
  await workflows.generate({ workflowId: created.assetId, requestId: 'unsaved-sheet' });
  await waitFor(() => provider.calls, calls => calls.length === 1, 'dispatched generation');
  await provider.complete(0, '#7744aa');
  const ready = await settled(created.assetId, 'unsaved-sheet', ['ready']);
  assert.equal(ready.attempts[0].sheetAssetId == null, true);
  mocked.mock.restore();
  await workflows.close(); generationJobs.close();
  const restartedJobs = new GenerationJobs({ project, provider });
  const restarted = new ReskinWorkflows({ project, generationJobs: restartedJobs });
  controllers.push({ workflows: restarted, generationJobs: restartedJobs });
  assert.equal((await restarted.get({ workflowId: created.assetId })).attempts[0].status, 'ready');
  await restarted.generate({ workflowId: created.assetId, requestId: 'unsaved-sheet' });
  assert.equal(provider.calls.length, 1);
  const assembled = await restarted.assemble({workflowId:created.assetId,attemptId:ready.attempts[0].id});
  assert.equal(assembled.attempts[0].status,'succeeded');
  const recoveredJob=restartedJobs.get({jobId:ready.attempts[0].generationJobId});
  assert.equal(assembled.attempts[0].sheetAssetId,recoveredJob.assetId);
  assert.equal(assembled.attempts[0].sheetRevisionId,recoveredJob.revisionId);
  const before=await project.snapshot();
  await restarted.assemble({workflowId:created.assetId,attemptId:ready.attempts[0].id});
  assert.deepEqual(await project.snapshot(),before,'A repeated recovery action does not create another candidate or workflow version.');
  assert.equal(provider.calls.length,1);
});

test('a cancellation persisted immediately before dispatch prevents the paid request', async t => {
  const { workflows, provider, create } = await setup(t);
  const created = await create();
  const get = workflows.get.bind(workflows);
  let cancelled = false;
  t.mock.method(workflows, 'get', async input => {
    const view = await get(input);
    const attempt = view.attempts.find(item => item.requestId === 'cancel-before-dispatch');
    if (!cancelled && attempt?.status === 'running' && attempt.stage === 'generating' && !attempt.generationJobId) {
      cancelled = true;
      await workflows.cancel({ workflowId: created.assetId, attemptId: attempt.id });
      return get(input);
    }
    return view;
  });
  await workflows.generate({ workflowId: created.assetId, requestId: 'cancel-before-dispatch' });
  // Only intercept the runner's read. Poll through the original method so the
  // test observer cannot accidentally trigger cancellation before it is durable.
  const stopped = await waitFor(() => get({ workflowId: created.assetId }), view => view.attempts.some(attempt => ['cancelled', 'unknown'].includes(attempt.status)), 'pre-dispatch cancellation');
  assert.equal(cancelled, true);
  assert.equal(provider.calls.length, 0);
  assert.equal(stopped.attempts[0].status, 'cancelled');
});

test('concurrent workflow document writes reject the stale revision without overwriting the winner', async t => {
  const { project, provider, workflows, controllers, create } = await setup(t);
  const created = await create();
  const otherJobs = new GenerationJobs({ project, provider });
  const other = new ReskinWorkflows({ project, generationJobs: otherJobs });
  controllers.push({ workflows: other, generationJobs: otherJobs });
  const addRevision = project.addRevision.bind(project);
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  t.mock.method(project, 'addRevision', async args => {
    if (args.assetId === created.assetId) {
      assert.equal(args.expectedSelectedRevisionId, created.revisionId);
      arrivals++; if (arrivals === 2) release();
      await barrier;
    }
    return addRevision(args);
  });
  const results = await Promise.allSettled([
    workflows.update({ workflowId: created.assetId, brief: 'First concurrent character brief' }),
    other.update({ workflowId: created.assetId, brief: 'Second concurrent character brief' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  const winner = results.find(result => result.status === 'fulfilled').value;
  const current = await workflows.get({ workflowId: created.assetId });
  assert.equal(current.revisionId, winner.revisionId); assert.equal(current.brief, winner.brief);
  assert.equal((await project.snapshot()).assets.find(asset => asset.id === created.assetId).revisions.length, 2);
  assert.equal(provider.calls.length, 0);
});


test('recovery refuses a generation result belonging to a different reference or request', async t => {
  const {project,workflows,generationJobs,provider,controllers,create,settled}=await setup(t);
  const created=await create(),importAsset=project.importAsset.bind(project);
  const mocked=t.mock.method(project,'importAsset',async args=>{if(args.metadata?.generation)throw new Error('Injected registration failure');return importAsset(args);});
  await workflows.generate({workflowId:created.assetId,requestId:'identity-check'});
  await waitFor(()=>provider.calls,calls=>calls.length===1,'provider dispatch');await provider.complete(0,'#ab44ab');
  const pending=await settled(created.assetId,'identity-check',['ready']);mocked.mock.restore();workflows.close();await generationJobs.close();
  const restartedJobs=new GenerationJobs({project,provider}),restarted=new ReskinWorkflows({project,generationJobs:restartedJobs});controllers.push({workflows:restarted,generationJobs:restartedJobs});
  await restartedJobs.initialize();const get=restartedJobs.get.bind(restartedJobs);
  const wrong=t.mock.method(restartedJobs,'get',args=>{const job=get(args);if(job)job.input.reference.revisionId='different-reference-version';return job;});
  const before=await project.snapshot();
  assert.equal((await restarted.get({workflowId:created.assetId})).attempts[0].status,'unknown');
  await assert.rejects(restarted.assemble({workflowId:created.assetId,attemptId:pending.attempts[0].id}),/一致的生成任务/);
  assert.deepEqual(await project.snapshot(),before);assert.equal(provider.calls.length,1);wrong.mock.restore();
  const assembled=await restarted.assemble({workflowId:created.assetId,attemptId:pending.attempts[0].id});assert.equal(assembled.attempts[0].status,'succeeded');
});

test('a committed candidate with a lost workflow response is recovered by its assembly receipt', async t => {
  const {project,workflows,provider,create,settled}=await setup(t);const created=await create();
  const importAsset=project.importAsset.bind(project);let lost=true;
  t.mock.method(project,'importAsset',async args=>{const result=await importAsset(args);if(lost&&args.idempotencyKey?.startsWith('reskin:')){lost=false;throw new Error('Injected response loss after candidate commit');}return result;});
  await workflows.generate({workflowId:created.assetId,requestId:'candidate-response-loss'});
  await waitFor(()=>provider.calls,calls=>calls.length===1,'provider dispatch');await provider.complete(0,'#7444aa');
  const ready=await settled(created.assetId,'candidate-response-loss',['ready']);
  const candidates=(await project.snapshot()).assets.filter(asset=>asset.importReceipt?.key.startsWith('reskin:'));assert.equal(candidates.length,1);
  const result=await workflows.assemble({workflowId:created.assetId,attemptId:ready.attempts[0].id});
  assert.equal(result.attempts[0].candidateAssetId,candidates[0].id);
  assert.equal((await project.snapshot()).assets.filter(asset=>asset.importReceipt?.key.startsWith('reskin:')).length,1);assert.equal(provider.calls.length,1);
});
