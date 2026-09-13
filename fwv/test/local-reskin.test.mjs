import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { GenerationJobs } from '../src/generation/jobs.mjs';
import { ReskinWorkflows } from '../src/workflows/reskin.mjs';
import { importSpine, extractSpinePart } from '../src/spine/application.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { createReskinFixture } from '../examples/reskin-fixture/create.mjs';

const fwePath = process.env.FWV_TEST_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url));
const EXECUTION = { provider: 'test-fixture', tool: 'local-reskin-test', model: 'mock-raster-v1', notes: 'MOCK ONLY: deterministic raster fixture; no model or image_gen invocation occurred.' };
const analysis = { summary: 'MOCK analysis: retain the six original silhouettes and apply a violet palette.', partNotes: { head: 'Violet cat ears with the existing expression.' }, risks: ['Fixture analysis only; check the joint seams by eye.'] };

async function setup(t) {
  const prefix = path.join(os.tmpdir(), 'fwv-local-reskin-'), root = await fs.mkdtemp(prefix);
  const project = new FwvProject(root); await project.init({ name: 'Local reskin fixture; no model calls' });
  const source = await createReskinFixture();
  const template = await importSpine(project, { name: source.name, files: source.files });
  const counts = { provider: 0, jobs: 0 }, controllers = [];
  const controller = (selectedProject = project) => {
    const provider = { publicConfig: () => ({ baseUrl: 'https://invalid.fixture/v1', model: 'gpt-image-2', protocol: 'gpt-image', keyConfigured: false, keySource: 'none', canGenerate: false }),
      generate: async () => { counts.provider++; throw new Error('This test must never call an image provider.'); } };
    const jobs = new GenerationJobs({ project: selectedProject, provider });
    const start = jobs.start.bind(jobs); jobs.start = (...args) => { counts.jobs++; return start(...args); };
    const workflows = new ReskinWorkflows({ project: selectedProject, generationJobs: jobs }); controllers.push({ workflows, jobs }); return workflows;
  };
  const workflows = controller();
  t.after(async () => {
    for (const item of controllers) { await item.workflows.close(); item.jobs.close(); }
    assert.deepEqual(counts, { provider: 0, jobs: 0 });
    assert.ok(root.startsWith(prefix) && path.dirname(root) === path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = (options = {}) => workflows.create({ templateAssetId: template.id, templateRevisionId: template.selectedRevisionId, name: 'Local violet cat', brief: 'A violet cat adventurer', mode: 'local', ...options });
  const reserve = async (options = {}) => {
    const view = await create();
    const generated = await workflows.generate({ workflowId: view.assetId, requestId: options.requestId || 'local-request', ...options });
    const attempt = generated.attempts.at(-1); return { workflowId: view.assetId, attemptId: attempt.id, attempt, view: generated };
  };
  const image = async (color = '#8b53ce', width = 1024, height = 1024) => {
    const buffer = await sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
    const asset = await project.importImage({ name: 'MOCK local result', fileName: 'mock-result.png', buffer });
    return { asset, buffer, imageAssetId: asset.id, imageRevisionId: asset.selectedRevisionId };
  };
  const prepare = async (task, workerId = 'mock-worker') => {
    const claim = await workflows.localClaim({ workflowId: task.workflowId, attemptId: task.attemptId, workerId });
    const claimId = claim.claimId ?? claim.task.claimId;
    assert.ok(claimId, 'Claim returns a private token to the claiming worker.');
    const args = { workflowId: task.workflowId, attemptId: task.attemptId, claimId };
    await workflows.localAnalyze({ ...args, analysis }); await workflows.localDispatch(args);
    return args;
  };
  return { root, project, source, template, counts, workflows, controller, create, reserve, image, prepare };
}

test('local tasks need no API key, persist guides and keep claim tokens private while analysis changes the dispatched prompt', async t => {
  const f = await setup(t), task = await f.reserve();
  assert.equal(task.view.mode, 'local'); assert.equal(task.attempt.mode, 'local');
  assert.equal(task.attempt.status, 'waiting-local'); assert.equal(task.attempt.local.status, 'waiting');
  const guide = await f.project.readArtifact(task.attempt.guide);
  assert.equal((await sharp(guide.buffer).metadata()).width, 1024);
  const repeated = await f.workflows.generate({ workflowId: task.workflowId, requestId: 'local-request' });
  assert.equal(repeated.attempts.length, 1); assert.equal(repeated.attempts[0].id, task.attemptId);
  const beforeClaim = await f.workflows.localTask({ workflowId: task.workflowId, attemptId: task.attemptId });
  assert.ok(beforeClaim.task.reference); assert.equal(beforeClaim.task.output.width, 1024);
  const first = await f.workflows.localClaim({ workflowId: task.workflowId, attemptId: task.attemptId, workerId: 'worker-one' });
  const again = await f.workflows.localClaim({ workflowId: task.workflowId, attemptId: task.attemptId, workerId: 'worker-one' });
  const claimId = first.claimId ?? first.task.claimId;
  assert.equal(again.claimId ?? again.task.claimId, claimId);
  assert.equal(JSON.stringify(await f.workflows.get({ workflowId: task.workflowId })).includes(claimId), false);
  assert.equal(JSON.stringify(await f.workflows.list()).includes(claimId), false);
  assert.equal(JSON.stringify(await f.workflows.localTask({ workflowId: task.workflowId, attemptId: task.attemptId })).includes(claimId), false);
  const args = { workflowId: task.workflowId, attemptId: task.attemptId, claimId };
  await assert.rejects(f.workflows.localAnalyze({ ...args, claimId: 'wrong-token', analysis }), error => error.status === 409);
  await assert.rejects(f.workflows.localDispatch(args), error => error.status === 400);
  await f.workflows.localAnalyze({ ...args, analysis });
  const analyzed = await f.workflows.localTask({ workflowId: task.workflowId, attemptId: task.attemptId });
  assert.match(analyzed.task.prompt, /Violet cat ears/); assert.match(analyzed.task.prompt, /MOCK analysis/);
  await f.workflows.localDispatch(args);
  await assert.rejects(f.workflows.localAnalyze({ ...args, analysis: { ...analysis, summary: 'Changed after dispatch' } }), error => error.status === 409);
  await assert.rejects(f.workflows.localDispatch(args), error => error.status === 409);
});

test('two independent Node worker processes can claim a local task only once', { timeout: 30000 }, async t => {
  const f = await setup(t), task = await f.reserve();
  const moduleUrl = relative => new URL(relative, import.meta.url).href;
  const workerCode = `import {FwvProject} from ${JSON.stringify(moduleUrl('../src/core/project.mjs'))};
import {ReskinWorkflows} from ${JSON.stringify(moduleUrl('../src/workflows/reskin.mjs'))};
const workflows=new ReskinWorkflows({project:new FwvProject(process.argv[1]),generationJobs:{provider:{publicConfig(){throw new Error('No provider needed');}}}});
process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));
try { const result=await workflows.localClaim({workflowId:process.argv[2],attemptId:process.argv[3],workerId:process.argv[4]});process.send({ok:true,result}); }
catch(error){process.send({ok:false,status:error.status,message:error.message});}
await workflows.close();process.disconnect();`;
  const children = ['worker-a', 'worker-b'].map(workerId => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode, f.root, task.workflowId, task.attemptId, workerId], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const ready = new Promise((resolve, reject) => { child.on('message', message => { if (message.ready) resolve(); }); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(stderr || `Worker exited ${code}`)); }); });
    const result = new Promise((resolve, reject) => { child.on('message', message => { if (Object.hasOwn(message, 'ok')) resolve(message); }); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(stderr || `Worker exited ${code}`)); }); });
    t.after(() => { if (child.exitCode === null) child.kill(); }); return { child, ready, result };
  });
  await Promise.all(children.map(child => child.ready)); for (const child of children) child.child.send('claim');
  const results = await Promise.all(children.map(child => child.result));
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
  assert.equal(results.find(result => !result.ok).status, 409);
  const view = await f.workflows.get({ workflowId: task.workflowId });
  assert.equal(view.attempts.length, 1); assert.equal(view.attempts[0].local.status, 'claimed');
  await assert.rejects(f.workflows.localClaim({ workflowId: task.workflowId, attemptId: task.attemptId, workerId: 'third-worker' }), error => error.status === 409);
});

test('registered source-role image completion assembles one candidate, preserves provenance and supports an exact subset reroll', async t => {
  const f = await setup(t), task = await f.reserve(), args = await f.prepare(task), output = await f.image();
  assert.equal(output.asset.revisions[0].files[0].role, 'source', 'Exercise importImage original role, not only processed role=image.');
  const completeArgs = { ...args, imageAssetId: output.imageAssetId, imageRevisionId: output.imageRevisionId, execution: EXECUTION };
  const competing = f.controller(new FwvProject(f.root));
  const completions = await Promise.all([f.workflows.localComplete(completeArgs), competing.localComplete(completeArgs)]);
  const completed = completions[0], first = completed.attempts[0];
  assert.equal(completions[1].attempts[0].candidateAssetId, first.candidateAssetId, 'Concurrent receipt completion must converge on one candidate.');
  assert.equal(first.status, 'succeeded'); assert.equal(completed.selectedCandidateId, first.id);
  const firstRef = { assetId: first.candidateAssetId, revisionId: first.candidateRevisionId };
  for (const file of f.source.files.slice(0, 2)) assert.deepEqual((await f.project.readArtifact({ ...firstRef, fileName: file.name })).buffer, file.buffer);
  const snapshot = await f.project.snapshot();
  const storedSheet = snapshot.assets.find(asset => asset.id === first.sheetAssetId).revisions.find(revision => revision.id === first.sheetRevisionId);
  const serialized = JSON.stringify(storedSheet.metadata);
  assert.match(serialized, /local/); assert.match(serialized, /MOCK analysis/); assert.match(serialized, /MOCK ONLY/);
  const repeated = await f.workflows.localComplete(completeArgs);
  assert.equal(repeated.attempts[0].candidateAssetId, first.candidateAssetId); assert.equal((await f.project.snapshot()).assets.length, snapshot.assets.length);
  const different = await f.image('#22aabb');
  await assert.rejects(f.workflows.localComplete({ ...args, imageAssetId: different.imageAssetId, imageRevisionId: different.imageRevisionId, execution: EXECUTION }), error => error.status === 409);
  const identicalBytesElsewhere = await f.image();
  await assert.rejects(f.workflows.localComplete({ ...args, imageAssetId: identicalBytesElsewhere.imageAssetId, imageRevisionId: identicalBytesElsewhere.imageRevisionId, execution: EXECUTION }), error => error.status === 409);
  await assert.rejects(f.workflows.localComplete({ ...completeArgs, execution: { ...EXECUTION, model: 'different-provenance' } }), error => error.status === 409);
  const next = await f.workflows.generate({ workflowId: task.workflowId, requestId: 'head-only', regionNames: ['head'], mode: 'local' });
  const secondTask = { workflowId: task.workflowId, attemptId: next.attempts.at(-1).id };
  const nextArgs = await f.prepare(secondTask, 'worker-two');
  const final = await f.workflows.localComplete({ ...nextArgs, imageAssetId: different.imageAssetId, imageRevisionId: different.imageRevisionId, execution: EXECUTION });
  const second = final.attempts.at(-1), secondRef = { assetId: second.candidateAssetId, revisionId: second.candidateRevisionId };
  assert.deepEqual(second.base, firstRef);
  for (const regionName of ['torso', 'arm-left', 'arm-right', 'leg-left', 'leg-right']) assert.deepEqual(await extractSpinePart(f.project, { ...secondRef, regionName }), await extractSpinePart(f.project, { ...firstRef, regionName }));
  assert.notDeepEqual(await extractSpinePart(f.project, { ...secondRef, regionName: 'head' }), await extractSpinePart(f.project, { ...firstRef, regionName: 'head' }));
  for (const file of f.source.files) assert.deepEqual((await f.project.readArtifact({ assetId: f.template.id, revisionId: f.template.selectedRevisionId, fileName: file.name })).buffer, file.buffer);
});

test('waiting, claimed and dispatched tasks remain queryable after controller restart without automatic generation', async t => {
  const f = await setup(t);
  for (const desired of ['waiting', 'claimed', 'dispatched']) {
    const task = await f.reserve({ requestId: `restart-${desired}` });
    let claimId;
    if (desired !== 'waiting') {
      const claimed = await f.workflows.localClaim({ workflowId: task.workflowId, attemptId: task.attemptId, workerId: 'same-worker' });
      claimId = claimed.claimId ?? claimed.task.claimId;
    }
    if (desired === 'dispatched') {
      await f.workflows.localAnalyze({ workflowId: task.workflowId, attemptId: task.attemptId, claimId, analysis });
      await f.workflows.localDispatch({ workflowId: task.workflowId, attemptId: task.attemptId, claimId });
    }
    const restarted = f.controller(new FwvProject(f.root));
    const reopened = await restarted.localTask({ workflowId: task.workflowId, attemptId: task.attemptId });
    assert.equal(reopened.workflow.attempts[0].local.status, desired);
    if (desired === 'dispatched') {
      assert.equal(reopened.task.canDispatch, false);
      await assert.rejects(restarted.localDispatch({ workflowId: task.workflowId, attemptId: task.attemptId, claimId }), error => error.status === 409);
    }
    const duplicate = await restarted.generate({ workflowId: task.workflowId, requestId: `restart-${desired}`, mode: 'local' });
    assert.equal(duplicate.attempts.length, 1); assert.equal(duplicate.attempts[0].id, task.attemptId);
  }
});

test('explicit cancellation before or after dispatch refuses late completion without deleting independent output images', async t => {
  const f = await setup(t);
  for (const dispatched of [false, true]) {
    const task = await f.reserve({ requestId: `cancel-${dispatched}` });
    const claimed = await f.workflows.localClaim({ workflowId: task.workflowId, attemptId: task.attemptId, workerId: 'cancelled-worker' });
    const claimId = claimed.claimId ?? claimed.task.claimId, args = { workflowId: task.workflowId, attemptId: task.attemptId, claimId };
    if (dispatched) { await f.workflows.localAnalyze({ ...args, analysis }); await f.workflows.localDispatch(args); }
    await f.workflows.cancel({ workflowId: task.workflowId, attemptId: task.attemptId });
    const output = await f.image();
    await assert.rejects(f.workflows.localDispatch(args), error => error.status === 409);
    await assert.rejects(f.workflows.localComplete({ ...args, imageAssetId: output.imageAssetId, imageRevisionId: output.imageRevisionId, execution: EXECUTION }), error => error.status === 409);
    const attempt = (await f.workflows.get({ workflowId: task.workflowId })).attempts[0];
    assert.equal(attempt.status, dispatched ? 'unknown' : 'cancelled');
    assert.equal((await f.project.snapshot()).assets.filter(asset => asset.kind === 'spine').length, 1);
    assert.deepEqual((await f.project.readArtifact({ assetId: output.imageAssetId, revisionId: output.imageRevisionId, fileName: 'mock-result.png' })).buffer, output.buffer);
  }
});

test('invalid dimensions, damaged bytes and inconsistent image metadata fail before a candidate is created', async t => {
  const f = await setup(t), task = await f.reserve(), args = await f.prepare(task);
  const invalidSize = await f.image('#448855', 64, 64);
  await assert.rejects(f.workflows.localComplete({ ...args, imageAssetId: invalidSize.imageAssetId, imageRevisionId: invalidSize.imageRevisionId, execution: EXECUTION }));
  const damaged = await f.image();
  await fs.writeFile(path.join(f.root, 'assets', damaged.imageAssetId, damaged.imageRevisionId, 'mock-result.png'), Buffer.alloc(damaged.buffer.length));
  await assert.rejects(f.workflows.localComplete({ ...args, imageAssetId: damaged.imageAssetId, imageRevisionId: damaged.imageRevisionId, execution: EXECUTION }));
  const valid = await f.image();
  const manifest = await f.project.snapshot();
  const revision = manifest.assets.find(asset => asset.id === valid.imageAssetId).revisions[0];
  revision.metadata.image.width = 512;
  await fs.writeFile(path.join(f.root, 'fwv.project.json'), JSON.stringify(manifest));
  await assert.rejects(f.workflows.localComplete({ ...args, imageAssetId: valid.imageAssetId, imageRevisionId: valid.imageRevisionId, execution: EXECUTION }));
  assert.equal((await f.project.snapshot()).assets.filter(asset => asset.kind === 'spine').length, 1);
  assert.equal((await f.workflows.get({ workflowId: task.workflowId })).attempts[0].candidateAssetId, undefined);
});

test('assembly storage failure keeps the generated sheet ready and retries only the local assembly', async t => {
  const f = await setup(t), task = await f.reserve(), args = await f.prepare(task), output = await f.image();
  const writeRevision = f.project._writeRevision.bind(f.project);
  let rejectCandidate = true;
  f.project._writeRevision = async (assetId, input) => {
    if (input.metadata?.spine && rejectCandidate) { rejectCandidate = false; throw new Error('Deterministic candidate storage failure'); }
    return writeRevision(assetId, input);
  };
  const completed = await f.workflows.localComplete({ ...args, imageAssetId: output.imageAssetId, imageRevisionId: output.imageRevisionId, execution: EXECUTION });
  assert.equal(completed.attempts[0].status, 'ready'); assert.ok(completed.attempts[0].sheetAssetId);
  f.project._writeRevision = writeRevision;
  const restored = f.controller(new FwvProject(f.root));
  const assembled = await restored.assemble({ workflowId: task.workflowId, attemptId: task.attemptId });
  assert.equal(assembled.attempts[0].status, 'succeeded');
  assert.equal((await f.project.snapshot()).assets.filter(asset => asset.kind === 'spine').length, 2);
});

test('an interrupted dispatched worker records unknown and may complete its original receipt without another dispatch', async t => {
  const f = await setup(t), task = await f.reserve(), args = await f.prepare(task);
  const interrupted = await f.workflows.localFail({ ...args, error: 'Mock worker disconnected after recording dispatch.' });
  assert.equal(interrupted.attempts[0].status, 'unknown');
  const restarted = f.controller(new FwvProject(f.root));
  await assert.rejects(restarted.localDispatch(args), error => error.status === 409);
  const output = await f.image();
  const completed = await restarted.localComplete({ ...args, imageAssetId: output.imageAssetId, imageRevisionId: output.imageRevisionId, execution: EXECUTION });
  assert.equal(completed.attempts[0].status, 'succeeded');
});

test('HTTP local-task reads and authenticated local commands enforce origin, CSRF, query and token boundaries', async t => {
  const f = await setup(t), task = await f.reserve();
  const editor = await startEditor({ projectRoot: f.root, fwePath, port: 0 }); t.after(() => editor.close());
  const session = await fetch(editor.url + '/api/fwv/session').then(response => response.json());
  const headers = { Origin: editor.url, 'X-FWV-CSRF': session.csrfToken, 'Content-Type': 'application/json' };
  const post = async (type, payload, customHeaders = headers) => {
    const response = await fetch(editor.url + '/api/fwv/commands', { method: 'POST', headers: customHeaders, body: JSON.stringify({ type, payload }) });
    return { status: response.status, body: await response.json() };
  };
  const payload = { workflowId: task.workflowId, attemptId: task.attemptId, workerId: 'http-worker' };
  const noOrigin = { ...headers }; delete noOrigin.Origin;
  assert.equal((await post('reskin.localClaim', payload, noOrigin)).status, 403);
  assert.equal((await post('reskin.localClaim', payload, { ...headers, 'X-FWV-CSRF': 'wrong' })).status, 403);
  assert.equal((await f.workflows.get({ workflowId: task.workflowId })).attempts[0].local.status, 'waiting');
  const claimed = await post('reskin.localClaim', payload); assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const claimId = claimed.body.result.claimId ?? claimed.body.result.task.claimId;
  const query = new URLSearchParams({ workflowId: task.workflowId, attemptId: task.attemptId });
  const response = await fetch(editor.url + '/api/fwv/reskin/local-task?' + query);
  assert.equal(response.status, 200); assert.equal((await response.text()).includes(claimId), false);
  for (const suffix of ['&extra=1', '&attemptId=duplicate']) assert.equal((await fetch(editor.url + '/api/fwv/reskin/local-task?' + query + suffix)).status, 400);
  const wrong = await post('reskin.localAnalyze', { workflowId: task.workflowId, attemptId: task.attemptId, claimId: 'wrong', analysis }); assert.equal(wrong.status, 409);
  const accepted = await post('reskin.localAnalyze', { workflowId: task.workflowId, attemptId: task.attemptId, claimId, analysis }); assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const dispatched = await post('reskin.localDispatch', { workflowId: task.workflowId, attemptId: task.attemptId, claimId }); assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
  const output = await f.image();
  const completed = await post('reskin.localComplete', { workflowId: task.workflowId, attemptId: task.attemptId, claimId, imageAssetId: output.imageAssetId, imageRevisionId: output.imageRevisionId, execution: EXECUTION });
  assert.equal(completed.status, 200, JSON.stringify(completed.body)); assert.equal(completed.body.result.attempts[0].status, 'succeeded');
  assert.equal((await fetch(editor.url + '/api/fwv/generation/jobs').then(response => response.json())).jobs.length, 0);
});
