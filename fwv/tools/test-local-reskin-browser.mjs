import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { GenerationJobs } from '../src/generation/jobs.mjs';
import { ReskinWorkflows } from '../src/workflows/reskin.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { createReskinFixture } from '../examples/reskin-fixture/create.mjs';

// Explicit synthetic worker: this checks the bridge, never claims an AI image was generated.
const require = createRequire(import.meta.url), fwvRoot = fileURLToPath(new URL('../', import.meta.url));
const fwePath = await fs.realpath(process.env.FWV_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url)));
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test', 'browser-smoke.js'));
let outputArgument;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] !== '--output' || !process.argv[index + 1]) throw new Error('Usage: node tools/test-local-reskin-browser.mjs [--output directory]');
  outputArgument = process.argv[++index];
}
const output = path.resolve(outputArgument || path.join(fwvRoot, '.local', 'reports', 'local-reskin-browser'));
await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project'), sourceRoot = path.join(runRoot, 'source');
const project = new FwvProject(projectRoot), fixture = await createReskinFixture(sourceRoot);
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', runRoot, projectRoot, checks: [], screenshots: [], browserErrors: [], providerCalls: 0, generatedBy: 'deterministic mock worker; no AI model called' };
const q = JSON.stringify, sel = id => `[data-testid="${id}"]`, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), hash = buffer => createHash('sha256').update(buffer).digest('hex');
const externalProject = new FwvProject(projectRoot);
const jobs = new GenerationJobs({ project: externalProject, provider: {
  publicConfig: () => ({ baseUrl: 'https://invalid.fixture/v1', model: 'unconfigured', protocol: 'gpt-image', keyConfigured: false, keySource: 'none', canGenerate: false }),
  generate: async () => { report.providerCalls++; throw new Error('Local browser acceptance must not call a provider.'); },
} });
const worker = new ReskinWorkflows({ project: externalProject, generationJobs: jobs });
let editor, chrome, cdp, workflowId, stage = 'setup';
function passed(name, details = {}) { report.checks.push({ name, status: 'passed', ...details }); console.log(`[FWV local] ${name}`); }
async function waitFor(fn, label, timeout = 25000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(90); } throw new Error(`Timed out: ${label}`); }
const expression = value => waitForExpression(cdp, value, 25000);
async function click(id) { await reveal(sel(id));
  await expression(`document.querySelector(${q(sel(id))}) && !document.querySelector(${q(sel(id))}).disabled`);
  await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel(id))});node.scrollIntoView({block:'center'});node.click();})()`);
}
async function reveal(css) {
  await expression(`document.querySelector(${q(css)})`);
  await evaluate(cdp, `(() => {const node=document.querySelector(${q(css)}),details=[];for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open)details.unshift(parent);for(const parent of details)parent.querySelector(':scope > summary').click();node.scrollIntoView({block:'center'});})()`);
  await expression(`document.querySelector(${q(css)})?.getClientRects().length > 0`);
}
async function fill(id, value) { await reveal(sel(id)); await expression(`document.querySelector(${q(sel(id))}) && !document.querySelector(${q(sel(id))}).disabled`); await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel(id))});node.value=${q(String(value))};node.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function upload(id, files) { const tree = await cdp.call('DOM.getDocument', { depth: 0 }); const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: tree.root.nodeId, selector: sel(id) }); assert.ok(nodeId); await cdp.call('DOM.setFileInputFiles', { nodeId, files }); }
async function panel(name) { const collectionId = { generate: 'generationDrafts', reskin: 'reskinDrafts', spine: 'spineDrafts' }[name]; await evaluate(cdp, `window.fwe.context().navigation.navigate({domainId:'fwv-authoring',fileName:'authoring.json',collectionId:${q(collectionId)},mode:'detail'},{updateUrl:true})`); }
async function view() { const response = await fetch(editor.url + '/api/fwv/reskin/workflows?' + new URLSearchParams({ workflowId })); assert.equal(response.status, 200); return (await response.json()).workflow; }
async function screenshot(name, focus) {
  if (focus) await reveal(sel(focus));
  if (focus) await evaluate(cdp, `document.querySelector(${q(sel(focus))}).scrollIntoView({block:'center'})`);
  else await evaluate(cdp, `(() => {let node=document.querySelector(${q(sel('fwv-reskin'))});while(node){node.scrollTop=0;node.scrollLeft=0;node=node.parentElement;}window.scrollTo(0,0);})()`);
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(runRoot, name + '.png'); await fs.writeFile(target, Buffer.from(shot.data, 'base64')); report.screenshots.push(target);
}
async function assertSource(reference) {
  for (const file of fixture.files) assert.deepEqual((await project.readArtifact({ ...reference, fileName: file.name })).buffer, file.buffer);
}

try {
  await project.init({ name: 'FWV · 本地 Agent 桥接模拟验收' });
  editor = await startEditor({ projectRoot, fwePath, port: 0 }); report.url = editor.url;
  const session = await fetch(editor.url + '/api/fwv/session').then(response => response.json());
  const configured = await fetch(editor.url + '/api/fwv/commands', { method: 'POST', headers: { Origin: editor.url, 'X-FWV-CSRF': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'provider.configure', payload: { baseUrl: 'https://unconfigured.fixture.invalid/v1', clearKey: true } }) });
  assert.equal(configured.status, 200);
  const publicConfig = await fetch(editor.url + '/api/fwv/provider').then(response => response.json());
  assert.equal(publicConfig.keyConfigured, false); assert.equal(publicConfig.canGenerate, false);
  const debugPort = await getFreePort(); chrome = startChrome(editor.url, debugPort); const target = await waitForTarget(debugPort, editor.url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Log.entryAdded', event => { if (event.entry?.level === 'error') report.browserErrors.push(`${event.entry.text} @ ${event.entry.url || ''}`); });
  for (const domain of ['Runtime', 'Log', 'Page', 'DOM']) await cdp.call(domain + '.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1180, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.reload', { ignoreCache: true }); await expression(`document.querySelector(${q(sel('fwv-reskin'))})`);

  stage = 'template and local plan';
  await click('fwv-reskin-import-template'); await expression(`document.querySelector(${q(sel('fwv-spine-import-input'))})`);
  await upload('fwv-spine-import-input', fixture.files.map(file => path.join(sourceRoot, file.name)));
  const template = await waitFor(async () => (await project.snapshot()).assets.find(asset => asset.kind === 'spine'), 'six-part source template imported');
  const templateRef = { assetId: template.id, revisionId: template.selectedRevisionId }; await assertSource(templateRef);
  await panel('reskin'); await expression(`document.querySelector(${q(sel('fwv-reskin-mode'))})?.value === 'local'`);
  await expression(`document.querySelectorAll(${q(sel('fwv-reskin-part'))}).length === 6 && !document.querySelector(${q(sel('fwv-reskin-create'))}).disabled`);
  await expression(`document.querySelector(${q(sel('fwv-reskin-original-canvas'))})?.dataset.rendered === 'true'`);
  const initialControls = await evaluate(cdp, `[...document.querySelectorAll('[data-testid="fwv-reskin"] input,[data-testid="fwv-reskin"] textarea,[data-testid="fwv-reskin"] select')].filter(node=>node.getClientRects().length&&!node.closest('details:not([open])')).map(node=>node.dataset.testid)`);
  assert.ok(!initialControls.includes('fwv-reskin-style') && !initialControls.includes('fwv-reskin-part-note'));
  assert.ok(await evaluate(cdp, `!document.querySelector(${q(sel('fwv-reskin-candidate-canvas'))}).getClientRects().length`));
  await screenshot('00-new-template'); passed('New plan previews the actual animated template with advanced requirements collapsed', { controls: initialControls });
  await fill('fwv-reskin-name', '本地 Agent · 模拟紫色猫咪'); await fill('fwv-reskin-brief', '模拟验收：保留六部件轮廓，将猫咪改为统一紫色。');
  await fill('fwv-reskin-style', 'MOCK fixture only, no model invocation'); await click('fwv-reskin-create');
  const initial = await waitFor(async () => { const response = await fetch(editor.url + '/api/fwv/reskin/workflows').then(response => response.json()); return response.workflows[0]; }, 'local plan saved'); workflowId = initial.assetId;
  assert.equal(initial.mode, 'local'); assert.equal(initial.attempts.length, 0); assert.equal(jobs.list().length, 0);
  await expression(`document.querySelector(${q(sel('fwv-reskin-generate'))}) && !document.querySelector(${q(sel('fwv-reskin-generate'))}).disabled`);
  await screenshot('01-local-plan'); passed('New UI defaults to local mode and enables a six-part plan with no API key');

  stage = 'waiting local worker';
  await click('fwv-reskin-generate');
  const waiting = await waitFor(async () => { const current = await view(); return current.attempts[0]?.guide && current.attempts[0]?.local?.status === 'waiting' ? current : false; }, 'persisted local worker task and guide');
  const attempt = waiting.attempts[0], taskRef = { workflowId, attemptId: attempt.id };
  await expression(`document.querySelector(${q(sel('fwv-reskin-local-task'))})?.dataset.attemptId === ${q(attempt.id)}`);
  const instructions = await evaluate(cdp, `document.querySelector(${q(sel('fwv-reskin-local-instructions'))}).value`);
  assert.ok(instructions.includes(workflowId)); assert.ok(instructions.includes(attempt.id)); assert.ok(instructions.includes(projectRoot));
  assert.match(await evaluate(cdp, `document.querySelector(${q(sel('fwv-reskin-attempt-status'))}).textContent`), /等待.*领取/);
  assert.equal(jobs.list().length, 0); assert.equal(report.providerCalls, 0);
  await screenshot('02-waiting-agent', 'fwv-reskin-local-task'); passed('One local task exposes exact worker instructions and a saved guide without a provider job', taskRef);

  stage = 'external worker analysis';
  const claimed = await worker.localClaim({ ...taskRef, workerId: 'browser-mock-worker' });
  const claimId = claimed.task.claimId, workerRef = { ...taskRef, claimId };
  const analysis = { summary: 'MOCK analysis: retain the six silhouettes and preserve all joint connections.', partNotes: { head: 'Use a violet head while keeping cat ears and expression.' }, risks: ['Synthetic test only; no model was called.'] };
  await worker.localAnalyze({ ...workerRef, analysis });
  await expression(`document.querySelector(${q(sel('fwv-reskin-local-analysis'))})?.textContent.includes('MOCK analysis')`);
  assert.equal((await view()).attempts.length, 1); await screenshot('03-worker-analysis', 'fwv-reskin-local-analysis');
  const task = (await worker.localTask(taskRef)).task;
  assert.match(task.prompt, /violet head/); assert.equal(JSON.stringify(await view()).includes(claimId), false);
  await worker.localDispatch(workerRef);
  await expression(`document.querySelector(${q(sel('fwv-reskin-attempt-status'))})?.textContent.includes('等待内置生图结果')`);
  passed('A separate core worker claims once and the UI polls its analysis and dispatched status');

  stage = 'synthetic result completion';
  const guide = await externalProject.readArtifact(task.reference);
  const { data, info } = await sharp(guide.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < data.length; offset += 4) if (data[offset + 3]) { const shade = (data[offset] + data[offset + 1] + data[offset + 2]) / 765; data[offset] = Math.round(154 * (.35 + shade * .65)); data[offset + 1] = Math.round(76 * (.35 + shade * .65)); data[offset + 2] = Math.round(221 * (.35 + shade * .65)); }
  const mockResult = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  const imported = await externalProject.importImage({ name: 'MOCK worker output; not AI generated', fileName: 'mock-local-sheet.png', buffer: mockResult });
  const completion = { ...workerRef, imageAssetId: imported.id, imageRevisionId: imported.selectedRevisionId, execution: { provider: 'test-fixture', model: 'mock-raster-v1', tool: 'local-browser-test', notes: 'Synthetic tint fixture only; no model or image_gen invocation occurred.' } };
  const completed = await worker.localComplete(completion), candidate = completed.attempts[0];
  assert.equal(candidate.status, 'succeeded'); report.candidate = { assetId: candidate.candidateAssetId, revisionId: candidate.candidateRevisionId };
  await expression(`document.querySelector(${q(sel('fwv-reskin-attempt-status'))})?.textContent === '候选已组装' && document.querySelector(${q(sel('fwv-reskin-candidate-canvas'))})?.dataset.rendered === 'true'`);
  const canvasSelector = sel('fwv-reskin-candidate-canvas');
  const firstFrame = await evaluate(cdp, `document.querySelector(${q(canvasSelector)}).toDataURL()`); await pause(330);
  const nextFrame = await evaluate(cdp, `document.querySelector(${q(canvasSelector)}).toDataURL()`); assert.notEqual(firstFrame, nextFrame);
  const png = Buffer.from(firstFrame.split(',')[1], 'base64'); await fs.writeFile(path.join(runRoot, 'mock-candidate-canvas.png'), png);
  const pixels = await sharp(png).ensureAlpha().raw().toBuffer(); let painted = 0, red = 0, blue = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset + 3] > 30) { painted++; red += pixels[offset]; blue += pixels[offset + 2]; }
  assert.ok(painted > 300 && blue > red, 'The rendered canvas must contain the actual violet mock output.');
  await assertSource(templateRef);
  for (const file of fixture.files.slice(0, 2)) assert.deepEqual((await project.readArtifact({ ...report.candidate, fileName: file.name })).buffer, file.buffer);
  const assetCount = (await project.snapshot()).assets.length;
  assert.equal((await worker.localComplete(completion)).attempts[0].candidateAssetId, candidate.candidateAssetId); assert.equal((await project.snapshot()).assets.length, assetCount);
  await screenshot('04-mock-candidate', 'fwv-reskin-candidate-canvas');
  passed('Registered synthetic worker pixels assemble automatically and animate in the official Spine runtime', { ...report.candidate, guideSha256: hash(guide.buffer), mockOutputSha256: hash(mockResult), painted });

  stage = 'reload and export';
  await cdp.call('Page.reload', { ignoreCache: true });
  await expression(`document.querySelector(${q(sel('fwv-reskin-workflows'))})?.value === ${q(workflowId)} && document.querySelector(${q(sel('fwv-reskin-attempt-status'))})?.textContent === '候选已组装'`);
  await click('fwv-reskin-query'); assert.equal((await view()).attempts.length, 1); assert.equal((await project.snapshot()).assets.length, assetCount);
  await click('fwv-reskin-export');
  const exported = await waitFor(async () => (await project.snapshot()).exports.find(item => item.assetId === candidate.candidateAssetId), 'exact local candidate exported');
  assert.equal(exported.revisionId, candidate.candidateRevisionId);
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, exported.path, 'manifest.json')));
  for (const file of manifest.files) assert.equal(hash(await fs.readFile(path.join(projectRoot, exported.path, file.path))), file.sha256);
  assert.equal(report.providerCalls, 0); assert.equal(jobs.list().length, 0);
  passed('Reload and explicit query retain one completed task and export the exact result without re-dispatch');

  stage = 'narrow layout';
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false }); await pause(180);
  const overflow = await evaluate(cdp, `(() => {const root=document.querySelector(${q(sel('fwv-reskin'))});return {page:document.documentElement.scrollWidth-innerWidth,panel:root.scrollWidth-root.clientWidth};})()`);
  assert.ok(overflow.page <= 2 && overflow.panel <= 2, JSON.stringify(overflow)); await screenshot('05-narrow-local'); await screenshot('06-narrow-candidate', 'fwv-reskin-candidate-canvas');
  passed('Local task and candidate UI fit a 1000px viewport', overflow);
  assert.deepEqual(report.browserErrors, []); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failureStage = stage; report.error = error.stack || String(error); process.exitCode = 1;
  if (cdp) try { await screenshot('failure'); report.visibleStatus = await evaluate(cdp, `({status:document.querySelector(${q(sel('fwv-reskin-status'))})?.textContent,attempt:document.querySelector(${q(sel('fwv-reskin-attempt-status'))})?.textContent})`); } catch {}
  console.error(`[FWV local] FAILED at ${stage}: ${error.message}`);
} finally {
  if (cdp) cdp.close(); if (chrome) await stopProcess(chrome); if (editor) await editor.close(); await worker.close(); jobs.close();
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2));
}
