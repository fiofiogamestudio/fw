import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { extractSpinePart } from '../src/spine/application.mjs';
import { createReskinFixture } from '../examples/reskin-fixture/create.mjs';

// Isolated repository acceptance: every model request goes to this owned local mock.
const require = createRequire(import.meta.url), fwvRoot = fileURLToPath(new URL('../', import.meta.url));
const fwePath = await fs.realpath(process.env.FWV_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url)));
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test', 'browser-smoke.js'));
const outputIndex = process.argv.indexOf('--output');
const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : path.join(fwvRoot, '.local', 'reports', 'reskin-browser'));
await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project'), fixtureRoot = path.join(runRoot, 'source');
const project = new FwvProject(projectRoot), fixture = await createReskinFixture(fixtureRoot);
const report = { startedAt: new Date().toISOString(), status: 'running', runRoot, projectRoot, checks: [], screenshots: [], browserErrors: [], modelRequests: [] };
const digest = buffer => createHash('sha256').update(buffer).digest('hex'), q = JSON.stringify, sel = id => `[data-testid="${id}"]`, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let editor, chrome, cdp, stage = 'setup', mockMode = 'normal', workflowId;
const pendingResponses = new Set();
const importAsset = FwvProject.prototype.importAsset;
let failGeneratedRegistration = false;
FwvProject.prototype.importAsset = async function(input) { if (failGeneratedRegistration && this.root === projectRoot && input.metadata?.generation) throw new Error('Injected generated-sheet registration failure'); return importAsset.call(this,input); };
const mock = http.createServer(async (req, res) => {
  pendingResponses.add(res); res.once('close', () => pendingResponses.delete(res));
  try {
    if (req.method === 'GET' && req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] })); return; }
    assert.equal(req.url, '/v1/images/edits'); assert.equal(req.method, 'POST');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
    const image = form.get('image'); assert.ok(image && typeof image.arrayBuffer === 'function', 'Reskin must submit one actual reference image.');
    const guide = Buffer.from(await image.arrayBuffer()), prompt = form.get('prompt');
    const request = { path: req.url, model: form.get('model'), size: form.get('size'), prompt, inputSha256: digest(guide) }; report.modelRequests.push(request);
    const { data, info } = await sharp(guide).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); assert.equal(info.width, 1024); assert.equal(info.height, 1024);
    // Keep exact cell positions and alpha while changing all painted pixels. Preserve shading.
    const tint = report.modelRequests.length === 1 ? [76, 167, 209] : [171, 89, 187];
    for (let offset = 0; offset < data.length; offset += 4) if (data[offset + 3]) { const light = (data[offset] + data[offset + 1] + data[offset + 2]) / 765; for (let channel = 0; channel < 3; channel++) data[offset + channel] = Math.round(tint[channel] * (0.35 + light * 0.65)); }
    const result = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer(); request.outputSha256 = digest(result);
    if (mockMode === 'hold') return;
    const timer = setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: result.toString('base64') }] })); } }, 700);
    res.once('close', () => clearTimeout(timer));
  } catch (error) { report.mockError = error.stack; if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${mock.address().port}/v1`;
function passed(name, details = {}) { report.checks.push({ name, status: 'passed', ...details }); console.log(`[FWV reskin] ${name}`); }
async function waitFor(fn, label, timeout = 25000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(90); } throw new Error(`Timed out: ${label}`); }
const expression = value => waitForExpression(cdp, value, 25000);
async function reveal(css) {
  await expression(`document.querySelector(${q(css)})`);
  await evaluate(cdp, `(() => {const node=document.querySelector(${q(css)}),details=[];for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open)details.unshift(parent);for(const parent of details)parent.querySelector(':scope > summary').click();node.scrollIntoView({block:'center'});})()`);
  await expression(`document.querySelector(${q(css)})?.getClientRects().length > 0`);
}
async function fill(id, value) { await reveal(sel(id)); await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel(id))});node.value=${q(String(value))};node.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function choose(id, value) { await reveal(sel(id)); await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel(id))});node.value=${q(String(value))};node.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function click(id) { await reveal(sel(id)); await expression(`document.querySelector(${q(sel(id))}) && !document.querySelector(${q(sel(id))}).disabled`); await evaluate(cdp, `document.querySelector(${q(sel(id))}).click()`); }
async function panel(name) { const collectionId = { generate: 'generationDrafts', reskin: 'reskinDrafts', spine: 'spineDrafts' }[name]; await evaluate(cdp, `window.fwe.context().navigation.navigate({domainId:'fwv-authoring',fileName:'authoring.json',collectionId:${q(collectionId)},mode:'detail'},{updateUrl:true})`); }
async function upload(id, files) { const tree = await cdp.call('DOM.getDocument', { depth: 0 }), { nodeId } = await cdp.call('DOM.querySelector', { nodeId: tree.root.nodeId, selector: sel(id) }); assert.ok(nodeId); await cdp.call('DOM.setFileInputFiles', { nodeId, files }); }
async function view() { const response = await fetch(editor.url + '/api/fwv/reskin/workflows?' + new URLSearchParams({ workflowId })); assert.equal(response.status, 200); return (await response.json()).workflow; }
async function done(count) { return waitFor(async () => { const workflow = await view(), attempt = workflow.attempts.at(-1); if (workflow.attempts.length < count) return false; if (['failed', 'ready', 'unknown'].includes(attempt.status)) throw new Error(`Attempt ended ${attempt.status}: ${attempt.error}`); return attempt.status === 'succeeded' ? workflow : false; }, `candidate ${count} assembled`, 40000); }
async function sheetVisible() { await expression(`document.querySelector(${q(sel('fwv-reskin-generated-sheet'))})?.naturalWidth === 1024 && document.querySelector(${q(sel('fwv-reskin-attempt-status'))})?.textContent === '候选已组装'`); }
async function screenshot(name) { await evaluate(cdp, `(() => {let node=document.querySelector(${q(sel('fwv-workbench'))});while(node){node.scrollTop=0;node=node.parentElement;}window.scrollTo(0,0);})()`); const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const target = path.join(runRoot, name + '.png'); await fs.writeFile(target, Buffer.from(shot.data, 'base64')); report.screenshots.push(target); }
function candidate(attempt) { return { assetId: attempt.candidateAssetId, revisionId: attempt.candidateRevisionId }; }
async function revision(ref) { const asset = (await project.snapshot()).assets.find(asset => asset.id === ref.assetId); return asset.revisions.find(revision => revision.id === ref.revisionId); }
async function pixels(ref, regionName) { return sharp(await extractSpinePart(project, { ...ref, regionName })).ensureAlpha().raw().toBuffer(); }
async function partHashes(ref, regions) { const result = {}; for (const regionName of regions) result[regionName] = digest(await pixels(ref, regionName)); return result; }
async function assertSkeleton(ref) { assert.deepEqual((await project.readArtifact({ ...ref, fileName: 'cat.json' })).buffer, fixture.json); assert.deepEqual((await project.readArtifact({ ...ref, fileName: 'cat.atlas' })).buffer, fixture.atlas); }
async function chooseOnly(regionName) { await click('fwv-reskin-clear-parts'); await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel('fwv-reskin-part') + `[data-region-name="${regionName}"]`)});node.checked=true;node.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function note(regionName, value) { await reveal(sel('fwv-reskin-part-note') + `[data-region-name="${regionName}"]`); await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel('fwv-reskin-part-note') + `[data-region-name="${regionName}"]`)});node.value=${q(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function inlinePreview() {
  const runtime = await fetch(editor.url + '/api/fwv/spine-runtime');
  if (!runtime.ok) { report.previewSkipped = 'Optional installed Spine runtime is unavailable; data acceptance still ran.'; return; }
  await expression(`document.querySelector(${q(sel('fwv-reskin-candidate-canvas'))})?.dataset.rendered === 'true' && document.querySelector(${q(sel('fwv-reskin-original-canvas'))})?.dataset.rendered === 'true'`);
  const canvasSelector = sel('fwv-reskin-candidate-canvas');
  const frame = await evaluate(cdp, `document.querySelector(${q(canvasSelector)}).toDataURL()`); await pause(260);
  assert.notEqual(await evaluate(cdp, `document.querySelector(${q(canvasSelector)}).toDataURL()`), frame, 'Official Spine canvas must animate actual candidate.');
  const visible = await evaluate(cdp, `(() => {const source=document.querySelector(${q(canvasSelector)}),copy=document.createElement('canvas');copy.width=source.width;copy.height=source.height;const context=copy.getContext('2d');context.drawImage(source,0,0);const data=context.getImageData(0,0,copy.width,copy.height).data;let painted=0,red=0,blue=0;for(let i=0;i<data.length;i+=4)if(data[i+3]>0){painted++;red+=data[i];blue+=data[i+2];}return {painted,red,blue};})()`);
  assert.ok(visible.painted > 100, `Preview has only ${visible.painted} painted pixels.`); assert.ok(visible.blue > visible.red, 'Candidate canvas must display actual blue generated pixels.');
  await choose('fwv-reskin-preview-animation', 'wave');
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-reskin-preview-animation'))}).value`), 'wave');
  const synchronized = await evaluate(cdp, `({original:document.querySelector(${q(sel('fwv-reskin-original-canvas'))}).dataset.time,candidate:document.querySelector(${q(canvasSelector)}).dataset.time})`); assert.equal(synchronized.original, synchronized.candidate);
  passed('Inline official Spine preview renders and animates the actual candidate', { canvasPixels: visible });
}

try {
  await project.init({ name: 'FWV · 整套角色换皮验收' }); editor = await startEditor({ projectRoot, fwePath, port: 0 });
  const debugPort = await getFreePort(); chrome = startChrome(editor.url, debugPort); const target = await waitForTarget(debugPort, editor.url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Log.entryAdded', event => { if (event.entry?.level === 'error') report.browserErrors.push(`${event.entry.text} @ ${event.entry.url || ''}`); });
  await cdp.call('Runtime.enable'); await cdp.call('Log.enable'); await cdp.call('Page.enable'); await cdp.call('DOM.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1160, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.reload', { ignoreCache: true }); await expression(`document.querySelector(${q(sel('fwv-reskin'))})`);
  stage = 'template import'; await click('fwv-reskin-import-template'); await expression(`document.querySelector(${q(sel('fwv-spine-import-input'))})`);
  await upload('fwv-spine-import-input', fixture.files.map(file => path.join(fixtureRoot, file.name)));
  const template = await waitFor(async () => (await project.snapshot()).assets.find(asset => asset.kind === 'spine'), 'six part template imported');
  const templateRef = { assetId: template.id, revisionId: template.selectedRevisionId }, originalRevision = await revision(templateRef);
  assert.equal(originalRevision.metadata.spine.regions.length, 6); assert.deepEqual(originalRevision.metadata.spine.animations, ['idle', 'walk', 'wave']); await assertSkeleton(templateRef);
  const regions = originalRevision.metadata.spine.regions.map(region => region.name), originalHashes = await partHashes(templateRef, regions);
  passed('Actual file picker imports six-part template with three reusable animations', { assetId: template.id });

  stage = 'local configuration'; await panel('generate'); await expression(`document.querySelector(${q(sel('fwv-provider-key-status'))})?.textContent !== '尚未读取配置' && document.querySelector(${q(sel('fwv-provider-base-url'))}) && !document.querySelector(${q(sel('fwv-provider-save'))}).disabled`);
  await fill('fwv-provider-base-url', providerUrl); await click('fwv-provider-save');
  await waitFor(async () => (await fetch(editor.url + '/api/fwv/provider').then(response => response.json())).baseUrl === providerUrl, 'local keyless provider configured');
  await panel('reskin'); await expression(`document.querySelectorAll(${q(sel('fwv-reskin-part'))}).length === 6 && !document.querySelector(${q(sel('fwv-reskin-create'))}).disabled`);
  stage = 'no-model plan'; await choose('fwv-reskin-mode', 'api'); await fill('fwv-reskin-name', '星夜猫咪游侠'); await fill('fwv-reskin-brief', '将猫咪换成星夜游侠，保留原比例与连接点。'); await fill('fwv-reskin-style', '统一蓝色配色，清晰描边，保留原有明暗层次。'); await note('head', '保留猫耳与表情，头部使用浅蓝色。'); await click('fwv-reskin-create');
  const initial = await waitFor(async () => { const response = await fetch(editor.url + '/api/fwv/reskin/workflows').then(response => response.json()); return response.workflows[0]; }, 'durable plan created'); workflowId = initial.assetId;
  await expression(`document.querySelector(${q(sel('fwv-reskin-guide'))})?.naturalWidth === 1024 && !document.querySelector(${q(sel('fwv-reskin-generate'))}).disabled`);
  assert.equal(initial.parts.length, 6); assert.equal(initial.sheet.layout.parts.length, 6); assert.equal(initial.attempts.length, 0); assert.equal(report.modelRequests.length, 0);
  assert.equal(initial.parts.find(part => part.regionName === 'head').note, '保留猫耳与表情，头部使用浅蓝色。');
  passed('Plan creation persists six-part reference layout and notes with zero model calls', { workflowId }); await screenshot('01-plan');

  stage = 'whole character generation'; await click('fwv-reskin-generate'); await expression(`document.querySelector(${q(sel('fwv-reskin-generate'))}).disabled`);
  const first = await done(1), firstAttempt = first.attempts[0], firstRef = candidate(firstAttempt); await sheetVisible();
  assert.equal(report.modelRequests.length, 1); assert.equal(report.modelRequests[0].model, 'gpt-image-2'); assert.equal(report.modelRequests[0].size, '1024x1024');
  assert.equal(report.modelRequests[0].inputSha256, digest((await project.readArtifact(firstAttempt.guide)).buffer));
  for (const regionName of regions) assert.ok(report.modelRequests[0].prompt.includes(regionName));
  const firstHashes = await partHashes(firstRef, regions);
  for (const regionName of regions) { assert.notEqual(firstHashes[regionName], originalHashes[regionName]); const before = await pixels(templateRef, regionName), after = await pixels(firstRef, regionName); for (let offset = 3; offset < before.length; offset += 4) if (before[offset] === 0) assert.equal(after[offset], 0, `${regionName} escaped template alpha mask`); }
  await assertSkeleton(firstRef); assert.deepEqual(await partHashes(templateRef, regions), originalHashes);
  assert.equal((await revision(firstRef)).metadata.reskin.partChecks.length, 6); await expression(`document.querySelector(${q(sel('fwv-reskin-part-checks'))})?.textContent.includes('head')`);
  passed('One actual multipart edit changes all six parts and preserves masks, skeleton and original', { candidate: firstRef, partHashes: firstHashes });
  await inlinePreview(); await screenshot('02-whole-character');

  stage = 'exact candidate navigation'; await click('fwv-reskin-open'); await expression(`document.querySelector(${q(sel('fwv-spine-asset'))})?.value === ${q(firstRef.assetId)} && document.querySelector(${q(sel('fwv-spine-revision'))})?.value === ${q(firstRef.revisionId)}`);
  await choose('fwv-spine-animation', 'walk'); await fill('fwv-spine-seek', '.45');
  passed('Full animation editor opens exact candidate asset and revision'); await screenshot('03-animation-editor');
  await panel('reskin'); await sheetVisible(); await expression(`document.querySelector(${q(sel('fwv-reskin-generate'))}) && !document.querySelector(${q(sel('fwv-reskin-generate'))}).disabled`);

  stage = 'head-only reroll'; await chooseOnly('head'); await note('head', '仅重新设计头部为紫色，保留已接受的身体与四肢。'); await fill('fwv-reskin-brief', '仅修改头部为紫色星夜猫咪，其余已选角色部件保持。');
  await click('fwv-reskin-generate'); const second = await done(2), secondAttempt = second.attempts[1], secondRef = candidate(secondAttempt); await sheetVisible();
  assert.equal(report.modelRequests.length, 2); assert.deepEqual(secondAttempt.regionNames, ['head']); assert.deepEqual(secondAttempt.base, firstRef); assert.equal(secondAttempt.guide.layout.parts.length, 1);
  assert.equal(report.modelRequests[1].inputSha256, digest((await project.readArtifact(secondAttempt.guide)).buffer));
  const secondHashes = await partHashes(secondRef, regions); assert.notEqual(secondHashes.head, firstHashes.head); for (const regionName of regions.filter(name => name !== 'head')) assert.equal(secondHashes[regionName], firstHashes[regionName], `Unselected ${regionName} changed`);
  await assertSkeleton(secondRef); assert.deepEqual(await partHashes(templateRef, regions), originalHashes);
  passed('Explicit one-head reroll sends one edit and preserves all five other accepted parts byte-for-byte', { candidate: secondRef, partHashes: secondHashes }); await screenshot('04-head-reroll');

  stage = 'local adjustment'; await choose('fwv-reskin-adjust-part', 'head'); await fill('fwv-reskin-scale', '.9'); await fill('fwv-reskin-offsetX', '3'); await click('fwv-reskin-reassemble');
  const adjusted = await waitFor(async () => { const workflow = await view(), attempt = workflow.attempts[1]; return attempt.status === 'succeeded' && attempt.candidateAssetId !== secondRef.assetId ? workflow : false; }, 'local candidate rebuilt');
  const adjustedRef = candidate(adjusted.attempts[1]), adjustedHashes = await partHashes(adjustedRef, regions);
  assert.equal(report.modelRequests.length, 2); assert.notEqual(adjustedHashes.head, secondHashes.head); assert.equal(adjusted.attempts[1].transforms.head.offsetX, 3);
  for (const regionName of regions.filter(name => name !== 'head')) assert.equal(adjustedHashes[regionName], secondHashes[regionName]);
  passed('Local scale/offset rebuild creates a new candidate without another model request', { candidate: adjustedRef });

  stage = 'candidate selection and export'; await expression(`!document.querySelector(${q(sel('fwv-reskin-select'))}).disabled`);
  await reveal(sel('fwv-reskin-attempt') + `[data-attempt-id="${firstAttempt.id}"]`); await evaluate(cdp, `document.querySelector(${q(sel('fwv-reskin-attempt') + `[data-attempt-id="${firstAttempt.id}"]`)}).click()`); await click('fwv-reskin-select');
  await waitFor(async () => (await view()).selectedCandidateId === firstAttempt.id, 'earlier candidate selected'); await click('fwv-reskin-export');
  const exported = await waitFor(async () => (await project.snapshot()).exports[0], 'candidate package exported'); assert.equal(exported.assetId, firstRef.assetId); assert.equal(exported.revisionId, firstRef.revisionId);
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, exported.path, 'manifest.json'))); assert.equal(manifest.validation.status, 'passed'); assert.equal(manifest.validation.humanAcceptance, 'not-reviewed');
  for (const file of manifest.files) assert.equal(digest(await fs.readFile(path.join(projectRoot, exported.path, file.path))), file.sha256);
  assert.deepEqual(await fs.readFile(path.join(projectRoot, exported.path, 'resources', 'cat.json')), fixture.json);
  await cdp.call('Page.reload', { ignoreCache: true }); await expression(`document.querySelector(${q(sel('fwv-reskin-workflows'))})?.value === ${q(workflowId)}`);
  assert.equal((await view()).selectedCandidateId, firstAttempt.id); assert.equal(report.modelRequests.length, 2);
  passed('Earlier candidate selection survives reload and exports exact intact package with technical-only validation', { exportPath: path.join(projectRoot, exported.path) });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false }); await pause(150);
  const overflow = await evaluate(cdp, `({page:document.documentElement.scrollWidth-innerWidth,panel:document.querySelector(${q(sel('fwv-reskin'))}).scrollWidth-document.querySelector(${q(sel('fwv-reskin'))}).clientWidth})`); assert.ok(overflow.page <= 2 && overflow.panel <= 2, JSON.stringify(overflow));
  if (!report.previewSkipped) await expression(`document.querySelector(${q(sel('fwv-reskin-original-canvas'))})?.dataset.rendered === 'true' && document.querySelector(${q(sel('fwv-reskin-candidate-canvas'))})?.dataset.rendered === 'true'`);
  await screenshot('05-narrow'); passed('Reskin workflow fits 1000 px viewport', overflow);

  stage = 'restart with staged generated sheet';
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1160, deviceScaleFactor: 1, mobile: false });
  await expression(`document.querySelector(${q(sel('fwv-reskin-generate'))}) && !document.querySelector(${q(sel('fwv-reskin-generate'))}).disabled`);await chooseOnly('head');
  failGeneratedRegistration=true;await click('fwv-reskin-generate');
  const stagedAttempt=await waitFor(async()=>{const attempt=(await view()).attempts[2];return attempt?.status==='ready'&&attempt;},'generated sheet durably staged after registration failure');
  assert.equal(report.modelRequests.length,3);assert.equal(stagedAttempt.sheetAssetId,undefined);
  const expectedOutput=report.modelRequests[2].outputSha256;failGeneratedRegistration=false;
  const restoredPort=Number(new URL(editor.url).port);await editor.close();editor=await startEditor({projectRoot,fwePath,port:restoredPort});
  const priorDocument=await evaluate(cdp,'performance.timeOrigin');await cdp.call('Page.reload',{ignoreCache:true});await expression(`performance.timeOrigin!==${q(priorDocument)}`);
  await expression(`document.querySelector(${q(sel('fwv-reskin-workflows'))})?.value===${q(workflowId)}`);
  const stagedHistory=sel('fwv-reskin-attempt')+`[data-attempt-id="${stagedAttempt.id}"]`;await reveal(stagedHistory);await evaluate(cdp,`document.querySelector(${q(stagedHistory)}).click()`);
  await expression(`!document.querySelector(${q(sel('fwv-reskin-reassemble'))})?.disabled`);
  assert.equal((await view()).attempts[2].status,'ready');
  assert.equal(await evaluate(cdp,`document.querySelector(${q(sel('fwv-reskin-reassemble'))}).textContent`),'保存并装配角色');
  await screenshot('06-recovered-ready');await click('fwv-reskin-reassemble');
  const recovered=await waitFor(async()=>{const attempt=(await view()).attempts[2];return attempt.status==='succeeded'&&attempt;},'recovered sheet saved and assembled',40000);assert.equal(report.modelRequests.length,3);assert.ok(recovered.candidateAssetId);
  const recoveredImage=await revision({assetId:recovered.sheetAssetId,revisionId:recovered.sheetRevisionId});
  assert.equal(recoveredImage.files.find(file=>file.role==='image').sha256,expectedOutput);
  const candidateCount=(await project.snapshot()).assets.filter(asset=>asset.kind==='spine').length;
  await click('fwv-reskin-reassemble');await expression(`!document.querySelector(${q(sel('fwv-reskin-reassemble'))}).disabled`);
  assert.equal((await project.snapshot()).assets.filter(asset=>asset.kind==='spine').length,candidateCount);
  assert.equal(report.modelRequests.length,3);await assertSkeleton(candidate(recovered));
  passed('Staged reskin generation survives server restart, saves exact output and assembles once through visible recovery action without another model call',{jobId:stagedAttempt.generationJobId,candidate:candidate(recovered),sha256:expectedOutput});
  // The provider is deliberately reconfigured only for the next, new request.
  await panel('generate');await expression(`document.querySelector(${q(sel('fwv-provider-base-url'))}) && !document.querySelector(${q(sel('fwv-provider-save'))}).disabled`);
  await fill('fwv-provider-base-url',providerUrl);await click('fwv-provider-save');await panel('reskin');
  stage = 'restart uncertain request'; await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1160, deviceScaleFactor: 1, mobile: false });
  await expression(`document.querySelector(${q(sel('fwv-reskin-generate'))}) && !document.querySelector(${q(sel('fwv-reskin-generate'))}).disabled`); await chooseOnly('head'); mockMode = 'hold'; await click('fwv-reskin-generate'); await waitFor(() => report.modelRequests.length === 4, 'held request dispatched');
  const port = Number(new URL(editor.url).port); await editor.close(); editor = await startEditor({ projectRoot, fwePath, port });
  await cdp.call('Page.reload', { ignoreCache: true }); await expression(`document.querySelector(${q(sel('fwv-reskin-attempt-status'))})?.textContent === '远端结果待核实'`);
  const reopened = await view(); assert.equal(reopened.attempts[3].status, 'unknown'); assert.equal(reopened.selectedCandidateId, recovered.id); await click('fwv-reskin-query'); await pause(1700);
  assert.equal(report.modelRequests.length, 4); assert.deepEqual(await partHashes(templateRef, regions), originalHashes);
  passed('Server restart retains uncertain remote state and selected candidate without automatic paid retry');
  if (!report.previewSkipped) await expression(`document.querySelector(${q(sel('fwv-reskin-original-canvas'))})?.dataset.rendered === 'true'`);
  await screenshot('06-restart-unknown');
  assert.equal(report.browserErrors.length, 0, report.browserErrors.join('\n')); assert.equal(report.mockError, undefined);
  report.status = 'passed'; report.onlyProvider = providerUrl;
} catch (error) {
  report.status = 'failed'; report.failureStage = stage; report.error = error.stack || String(error); process.exitCode = 1;
  if (cdp) try { await screenshot('failure'); report.visibleStatus = await evaluate(cdp, `({status:document.querySelector(${q(sel('fwv-reskin-status'))})?.textContent,attempt:document.querySelector(${q(sel('fwv-reskin-attempt-status'))})?.textContent,preview:document.querySelector(${q(sel('fwv-reskin-character-preview'))})?.textContent})`); } catch {}
  console.error(`[FWV reskin] FAILED at ${stage}: ${error.message}`);
} finally {
  FwvProject.prototype.importAsset=importAsset;
  if (cdp) cdp.close(); if (chrome) await stopProcess(chrome); if (editor) await editor.close();
  for (const res of pendingResponses) res.destroy(); mock.closeAllConnections?.(); await new Promise(resolve => mock.close(resolve));
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2));
}
