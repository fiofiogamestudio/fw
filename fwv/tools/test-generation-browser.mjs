import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { createSpineFixture } from '../examples/spine-fixture/create.mjs';

// All image-model requests in this test go to the HTTP server created below.
// The test uses a random fake credential and never calls a commercial provider.
const require = createRequire(import.meta.url);
const fwvRoot = fileURLToPath(new URL('../', import.meta.url));
const fwePath = await fs.realpath(process.env.FWV_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url)));
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test', 'browser-smoke.js'));
const output = path.join(fwvRoot, '.local', 'reports', 'generation-browser'); await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project');
const project = new FwvProject(projectRoot), fakeKey = `fwv-mock-${randomUUID()}`;
const report = { startedAt: new Date().toISOString(), status: 'running', runRoot, projectRoot, checks: [], screenshots: [], browserErrors: [], expectedNetworkErrors: [] };
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const q = JSON.stringify, sel = id => `[data-testid="${id}"]`, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let editor, chrome, cdp, stage = 'setup', modelMode = 'normal', releaseOutput, dropStartResponse = false, expectedBlockedResponse = false, fetchEnabled = false, dropResponseAck;
const received = [], pendingResponses = new Set();
const generatedImage = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#24a97c' } }).png().toBuffer();
const editedImage = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#566bda' } }).png().toBuffer();
const referenceImage = await sharp({ create: { width: 64, height: 48, channels: 4, background: '#e9a544' } }).png().toBuffer();
const referencePath = path.join(runRoot, 'reference.png'); await fs.writeFile(referencePath, referenceImage);
const invalidReferencePath = path.join(runRoot, 'invalid-reference.txt'); await fs.writeFile(invalidReferencePath, 'This is not a supported image.');
const mock = http.createServer(async (req, res) => {
  pendingResponses.add(res); res.once('close', () => pendingResponses.delete(res));
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
    const record = { method: req.method, path: req.url, authenticated: req.headers.authorization === `Bearer ${fakeKey}` };
    if (req.url === '/v1/models') {
      received.push(record); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] })); return;
    }
    if (req.url !== '/v1/images/generations' && req.url !== '/v1/images/edits') { res.writeHead(404); res.end(); return; }
    assert.equal(req.method, 'POST'); assert.equal(record.authenticated, true);
    record.hasReferenceBytes = body.indexOf(referenceImage) >= 0;
    record.multipart = String(req.headers['content-type']).startsWith('multipart/form-data;');
    if (!record.multipart) { const parsed = JSON.parse(body); record.model = parsed.model; record.prompt = parsed.prompt; record.size = parsed.size; record.quality = parsed.quality; record.background = parsed.background; }
    received.push(record);
    const image = req.url.endsWith('/edits') ? editedImage : generatedImage;
    const reply = () => { if (res.destroyed) return; res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': `mock-${received.length}` });
      res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }], usage: { input_tokens: 12, output_tokens: 18, total_tokens: 30 } })); };
    if (modelMode === 'hold' || modelMode === 'save-failure') releaseOutput = reply;
    else { const timer = setTimeout(reply, modelMode === 'slow' ? 2300 : 600); res.once('close', () => clearTimeout(timer)); }
  } catch (error) { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${mock.address().port}/v1`;
function passed(name, details = {}) { report.checks.push({ name, status: 'passed', ...details }); console.log(`[FWV generation] ${name}`); }
const modelRequests = () => received.filter(item => item.path.startsWith('/v1/images/'));
async function waitFor(fn, label, timeout = 16000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(80); } throw new Error(`Timed out: ${label}`); }
async function expression(value) { return waitForExpression(cdp, value, 16000); }
async function ready() { await expression(`document.querySelector(${q(sel('fwv-workbench'))}) && !document.querySelector(${q(sel('fwv-import'))})?.disabled`); }
async function panel(name) { const collectionId = { generate: 'generationDrafts', images: 'imageDrafts', spine: 'spineDrafts' }[name]; await evaluate(cdp, `window.fwe.context().navigation.navigate({domainId:'fwv-authoring',fileName:'authoring.json',collectionId:${q(collectionId)},mode:'detail'},{updateUrl:true})`); }
async function enter() { await panel('generate'); await expression(`document.querySelector(${q(sel('fwv-provider-key-status'))})?.textContent !== '尚未读取配置' && document.querySelector(${q(sel('fwv-generation'))})`); }
async function reveal(id) { await evaluate(cdp, `(() => {let node=document.querySelector(${q(sel(id))});const parents=[];for(let item=node?.parentElement;item;item=item.parentElement)if(item.tagName==='DETAILS')parents.unshift(item);for(const item of parents)if(!item.open)item.querySelector(':scope > summary').click();node?.scrollIntoView({block:'nearest'});})()`); }
async function fold(id) { await evaluate(cdp, `(() => {const details=document.querySelector(${q(sel(id))});if(details?.open)details.querySelector(':scope > summary').click();})()`); }
async function fill(id, value) { await reveal(id); await evaluate(cdp, `(() => { const node=document.querySelector(${q(sel(id))}); node.value=${q(String(value))}; node.dispatchEvent(new Event('input',{bubbles:true})); })()`); }
async function choose(id, value) { await reveal(id); await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel(id))});node.value=${q(String(value))};node.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function click(id) { await expression(`document.querySelector(${q(sel(id))}) && !document.querySelector(${q(sel(id))}).disabled`); await reveal(id); await evaluate(cdp, `document.querySelector(${q(sel(id))}).click()`); }
async function upload(id, file) { await reveal(id); const tree = await cdp.call('DOM.getDocument', { depth: 0 }); const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: tree.root.nodeId, selector: sel(id) }); assert.ok(nodeId); await cdp.call('DOM.setFileInputFiles', { nodeId, files: Array.isArray(file) ? file : [file] }); }
async function jobs() { return (await fetch(editor.url + '/api/fwv/generation/jobs').then(response => response.json())).jobs; }
async function jobStatus(status, previous = 0) { return waitFor(async () => { const list = await jobs(); return list.length > previous && list[0]?.status === status ? list[0] : false; }, `job status ${status}`); }
async function displayed() { await expression(`document.querySelector(${q(sel('fwv-generation-image'))})?.naturalWidth === 1024 && document.querySelector(${q(sel('fwv-generation-job-status'))})?.textContent === '已保存到素材库'`); }
async function generatedPixels(job, expected) {
  const asset = (await project.snapshot()).assets.find(entry => entry.id === job.assetId), revision = asset.revisions.find(entry => entry.id === job.revisionId);
  const file = revision.files.find(entry => entry.role === 'image');
  const artifact = await project.readArtifact({ assetId: asset.id, revisionId: revision.id, fileName: file.name }); assert.equal(digest(artifact.buffer), digest(expected));
  assert.equal(revision.metadata.generation.model, 'gpt-image-2'); assert.equal(revision.metadata.generation.baseUrl, providerUrl);
  return { asset, revision, imageSha256: digest(artifact.buffer) };
}
async function screenshot(name) {
  await evaluate(cdp, `(() => {let node=document.querySelector(${q(sel('fwv-workbench'))});while(node){node.scrollTop=0;node=node.parentElement;}window.scrollTo(0,0);})()`);
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const target = path.join(runRoot, name + '.png'); await fs.writeFile(target, Buffer.from(shot.data, 'base64')); report.screenshots.push(target);
}
async function assertNoCredentialLeaks() {
  const browser = await evaluate(cdp, `({html:document.documentElement.outerHTML,values:[...document.querySelectorAll('input,textarea')].map(node=>node.value),local:[...Object.entries(localStorage)],session:[...Object.entries(sessionStorage)],url:location.href})`);
  assert.equal(JSON.stringify(browser).includes(fakeKey), false, 'Credential leaked into browser DOM or storage.');
  async function scan(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const target = path.join(directory, entry.name); if (entry.isDirectory()) await scan(target); else if (entry.isFile()) assert.equal((await fs.readFile(target)).includes(Buffer.from(fakeKey)), false, 'Credential leaked into project file.'); } }
  await scan(projectRoot);
  const safeConfig = await fetch(editor.url + '/api/fwv/provider').then(response => response.json()); assert.equal(JSON.stringify(safeConfig).includes(fakeKey), false);
}

try {
  await project.init({ name: 'FWV · 本机模拟生图验收' }); editor = await startEditor({ projectRoot, fwePath, port: 0 });
  const debugPort = await getFreePort(); chrome = startChrome(editor.url, debugPort); const target = await waitForTarget(debugPort, editor.url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Log.entryAdded', event => { if (event.entry?.level !== 'error') return; const value = `${event.entry.text} @ ${event.entry.url || ''}`;
    if (expectedBlockedResponse && value.includes('/api/fwv/commands') && value.includes('ERR_CONNECTION_CLOSED')) report.expectedNetworkErrors.push(value); else report.browserErrors.push(value); });
  cdp.on('Fetch.requestPaused', event => {
    if (!fetchEnabled) return;
    const body = event.request.postData;
    let request;
    if (dropStartResponse && body && JSON.parse(body).type === 'generation.start') {
      dropStartResponse = false; expectedBlockedResponse = true;
      request = dropResponseAck = cdp.call('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionClosed' });
    } else request = cdp.call('Fetch.continueRequest', { requestId: event.requestId });
    void request.catch(error => { if (fetchEnabled || !error.message.includes('Fetch domain is not enabled')) report.browserErrors.push(error.message); });
  });
  await cdp.call('Runtime.enable'); await cdp.call('Log.enable'); await cdp.call('Page.enable'); await cdp.call('DOM.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1160, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.reload', { ignoreCache: true }); await ready(); await enter();

  stage = 'settings';
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-generation-provider-settings'))}).open`), true, 'Unconfigured service opens its setup controls automatically.');
  await fill('fwv-provider-base-url', providerUrl); await fill('fwv-provider-model', 'gpt-image-2'); await fill('fwv-provider-key', fakeKey); await click('fwv-provider-save');
  await expression(`document.querySelector(${q(sel('fwv-provider-key-status'))})?.textContent.includes('已配置凭据')`);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-provider-key'))}).value`), '');
  await click('fwv-provider-check'); await waitFor(() => received.some(entry => entry.path === '/v1/models'), 'credentials checked against local mock');
  await expression(`!document.querySelector(${q(sel('fwv-provider-check'))}).disabled`);
  assert.equal(received.find(entry => entry.path === '/v1/models').authenticated, true);
  await assertNoCredentialLeaks(); passed('Service save/check uses local mock; API key cleared and absent from DOM/storage/project');
  await fold('fwv-generation-provider-settings');
  const initialLayout = await evaluate(cdp, `(() => {const root=document.querySelector(${q(sel('fwv-generation'))});const visible=node=>node.checkVisibility();return {fields:[...root.querySelectorAll('input,textarea,select')].filter(visible).map(node=>node.dataset.testid),advanced:document.querySelector(${q(sel('fwv-generation-options'))}).open,reference:document.querySelector(${q(sel('fwv-generation-reference-settings'))}).open,primary:document.querySelector(${q(sel('fwv-generation-start'))}).checkVisibility()};})()`);
  assert.deepEqual(initialLayout.fields.sort(), ['fwv-generation-name','fwv-generation-prompt']); assert.equal(initialLayout.advanced,false); assert.equal(initialLayout.reference,false); assert.equal(initialLayout.primary,true);
  await screenshot('00-focused-generation'); passed('Default generation screen shows the request, preview and one primary action; optional settings open through disclosure controls',initialLayout);

  stage = 'generation';
  await fill('fwv-generation-name', '模拟薄荷素材'); await fill('fwv-generation-prompt', 'A mint-green item icon for a local automated test.'); await click('fwv-generation-start');
  await expression(`document.querySelector(${q(sel('fwv-generation-start'))}).disabled`);
  const firstJob = await jobStatus('succeeded'); await displayed(); const first = await generatedPixels(firstJob, generatedImage);
  assert.equal(modelRequests().length, 1); assert.equal(modelRequests()[0].path, '/v1/images/generations');
  assert.equal(modelRequests()[0].model, 'gpt-image-2'); assert.equal(modelRequests()[0].size, '1024x1024');
  passed('Queued job auto-polls to saved image without duplicate submission', { imageSha256: first.imageSha256, assetId: first.asset.id }); await screenshot('01-generated');

  stage = 'new reference error after successful job';
  await upload('fwv-generation-reference-input', invalidReferencePath);
  await expression(`document.querySelector(${q(sel('fwv-generation-status'))})?.dataset.error === 'true'`);
  const referenceError = await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel('fwv-generation-status'))});return {visible:node.checkVisibility(),tone:node.dataset.tone,message:node.textContent,job:document.querySelector(${q(sel('fwv-generation-job-status'))}).textContent};})()`);
  assert.equal(referenceError.visible, true, 'A prior successful job must not hide a new reference-validation failure.');
  assert.equal(referenceError.tone, 'danger'); assert.equal(referenceError.job, '已保存到素材库'); assert.equal(modelRequests().length, 1);
  passed('New reference validation errors remain visible with danger tone after a successful generation', referenceError);

  stage = 'reference edit';
  await upload('fwv-generation-reference-input', referencePath);
  await waitFor(async () => (await project.snapshot()).assets.length === 2, 'reference imported through picker');
  await expression(`document.querySelector(${q(sel('fwv-generation-reference-asset'))}).value !== '' && !document.querySelector(${q(sel('fwv-generation-start'))}).disabled`);
  const referenceAssetId = await evaluate(cdp, `document.querySelector(${q(sel('fwv-generation-reference-asset'))}).value`);
  await fill('fwv-generation-name', '模拟参考图变体'); await fill('fwv-generation-prompt', 'Change the reference image to blue for a local test.'); await click('fwv-generation-start');
  const editedJob = await jobStatus('succeeded', 1); await displayed(); const edited = await generatedPixels(editedJob, editedImage);
  assert.equal(modelRequests().length, 2); assert.equal(modelRequests()[1].path, '/v1/images/edits'); assert.equal(modelRequests()[1].multipart, true); assert.equal(modelRequests()[1].hasReferenceBytes, true);
  assert.equal(edited.revision.metadata.generation.reference.assetId, referenceAssetId);
  const retainedReference = edited.revision.files.find(file => file.role === 'reference'); assert.ok(retainedReference);
  assert.equal(digest((await project.readArtifact({ assetId: edited.asset.id, revisionId: edited.revision.id, fileName: retainedReference.name })).buffer), digest(referenceImage));
  passed('Reference picker import uses multipart image edit and retains original reference bytes', { assetId: edited.asset.id, imageSha256: edited.imageSha256 });
  await click('fwv-generation-open');
  await expression(`document.querySelector(${q(sel('fwv-current-preview'))})?.naturalWidth === 1024 && document.querySelector(${q(sel('fwv-current-preview'))})?.src.includes(${q(edited.asset.id)})`);
  await enter(); await displayed(); passed('Generated image opens selected asset in image workbench');

  stage = 'lost start response';
  await choose('fwv-generation-reference-asset', ''); await fill('fwv-generation-name', '模拟响应丢失'); await fill('fwv-generation-prompt', 'A second green item for lost-response recovery.');
  modelMode = 'slow'; dropStartResponse = true;
  fetchEnabled = true; await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*/api/fwv/commands', requestStage: 'Response' }] }); await click('fwv-generation-start');
  await waitFor(() => modelRequests().length === 3, 'lost-response model dispatch');
  await waitFor(() => dropResponseAck, 'intended start response intercepted'); await dropResponseAck;
  fetchEnabled = false;
  await cdp.call('Fetch.disable');
  await panel('images'); await enter();
  const recoveredJob = await jobStatus('succeeded', 2); await displayed(); await pause(1700);
  assert.equal(modelRequests().length, 3); await generatedPixels(recoveredJob, generatedImage);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-status'))})?.textContent.includes('Failed to fetch')`),false,'Recovered generation does not retain its already-resolved global network error.');
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-generation-status'))})?.dataset.error`),'false','Confirmed recovery also clears its already-resolved panel error.');
  expectedBlockedResponse = false;
  passed('Lost start response recovers by request ID after remount without another model call', { jobId: recoveredJob.id });

  stage = 'retry local save';
  modelMode = 'save-failure'; await fill('fwv-generation-name', '模拟保存重试'); await fill('fwv-generation-prompt', 'A generated image whose local saving is temporarily unavailable.'); await click('fwv-generation-start');
  await waitFor(() => modelRequests().length === 4 && releaseOutput, 'held model result');
  const assetsPath = path.join(projectRoot, 'assets'), parkedAssets = path.join(projectRoot, 'assets-test-parked');
  assert.equal(path.dirname(assetsPath), projectRoot); assert.equal(path.dirname(parkedAssets), projectRoot);
  await fs.rename(assetsPath, parkedAssets); await fs.writeFile(assetsPath, 'intentional test storage obstruction');
  let waitingJob;
  try { releaseOutput(); waitingJob = await jobStatus('ready', 3); } finally { await fs.unlink(assetsPath); await fs.rename(parkedAssets, assetsPath); }
  assert.equal(waitingJob.durability, 'staged');
  const stagedManifest = JSON.parse(await fs.readFile(path.join(projectRoot, waitingJob.recoveryPath), 'utf8'));
  const savedGenerationTime = stagedManifest.metadata.generation.generatedAt;
  await expression(`!document.querySelector(${q(sel('fwv-generation-save'))}).disabled && !document.querySelector(${q(sel('fwv-generation-save'))}).classList.contains('fg-hidden')`);
  await screenshot('02-staged-result');
  stage = 'restore staged output after server restart';
  // Navigate away first so this controlled service restart does not leave polling requests in flight.
  await cdp.call('Page.navigate', { url: 'about:blank' }); await expression(`location.href === 'about:blank'`);
  const restartPort = Number(new URL(editor.url).port);
  await editor.close(); editor = await startEditor({ projectRoot, fwePath, port: restartPort });
  await cdp.call('Page.navigate', { url: editor.url }); await ready(); await enter();
  const recoveredWaiting = await jobStatus('ready', 3);
  assert.equal(recoveredWaiting.id, waitingJob.id); assert.equal(recoveredWaiting.durability, 'staged');
  assert.equal((await fetch(editor.url + '/api/fwv/provider').then(response => response.json())).keyConfigured, false);
  await expression(`document.querySelector(${q(sel('fwv-generation-job-message'))})?.textContent.includes('已从磁盘恢复') && !document.querySelector(${q(sel('fwv-generation-save'))}).disabled`);
  await screenshot('02-restored-result');
  await click('fwv-generation-save'); const savedJob = await jobStatus('succeeded', 3); await displayed(); await generatedPixels(savedJob, generatedImage);
  const savedAsset = (await project.snapshot()).assets.find(asset => asset.id === savedJob.assetId);
  assert.equal(savedAsset.revisions[0].metadata.generation.generatedAt, savedGenerationTime);
  assert.equal(modelRequests().length, 4); passed('Staged result restores after a real editor restart and saves identical pixels/provenance without credentials or another model call', { jobId: savedJob.id });
  await fill('fwv-provider-base-url', providerUrl); await fill('fwv-provider-model', 'gpt-image-2'); await fill('fwv-provider-key', fakeKey); await click('fwv-provider-save');
  await expression(`document.querySelector(${q(sel('fwv-provider-key-status'))})?.textContent.includes('已配置凭据')`);

  stage = 'cancel uncertain request';
  modelMode = 'hold'; releaseOutput = null; await fill('fwv-generation-name', '模拟取消'); await fill('fwv-generation-prompt', 'Hold this local mock request until it is cancelled.'); await click('fwv-generation-start');
  await waitFor(() => modelRequests().length === 5, 'cancel target dispatched'); await click('fwv-generation-cancel'); const cancelledJob = await jobStatus('unknown', 4);
  await expression(`document.querySelector(${q(sel('fwv-generation-job-status'))})?.textContent === '结果待核实'`); await pause(1900);
  assert.equal(modelRequests().length, 5); assert.equal((await project.snapshot()).assets.length, 5);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-generation-start'))}).disabled`), true);
  passed('Dispatched cancellation remains explicitly unknown and never auto-retries', { jobId: cancelledJob.id });
  await screenshot('02-uncertain');
  await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel('fwv-generation-acknowledge'))});node.checked=true;node.dispatchEvent(new Event('change',{bubbles:true}));})()`); await click('fwv-generation-new-request');

  stage = 'settings and navigation';
  await choose('fwv-provider-protocol', 'openai-compatible'); await click('fwv-provider-save');
  await expression(`document.querySelector(${q(sel('fwv-generation-background'))})?.disabled`);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-generation-background'))}).value`), 'auto');
  stage = 'configured model parameters reach compatible provider';
  assert.deepEqual(await evaluate(cdp, `[...document.querySelector(${q(sel('fwv-generation-quality'))}).options].map(option=>option.value)`), ['auto', 'low', 'medium', 'high', 'standard', 'hd']);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-generation-prompt'))}).maxLength`), 8000);
  await choose('fwv-generation-reference-asset', ''); await choose('fwv-generation-quality', 'hd'); await fill('fwv-generation-size', '768x512');
  await fill('fwv-generation-name', '兼容协议配置参数'); await fill('fwv-generation-prompt', 'A custom-size compatible protocol image from the declared fields.');
  modelMode = 'normal'; await click('fwv-generation-start');
  const compatibleJob = await jobStatus('succeeded', 5); await displayed();
  assert.equal(modelRequests().length, 6); assert.equal(modelRequests().at(-1).size, '768x512'); assert.equal(modelRequests().at(-1).quality, 'hd');
  const compatibleAsset = (await project.snapshot()).assets.find(asset => asset.id === compatibleJob.assetId);
  assert.equal(compatibleAsset.revisions[0].metadata.generation.quality, 'hd');
  passed('Schema quality values and prompt limit drive native fields; compatible hd and custom dimensions reach the provider unchanged');
  await click('fwv-provider-clear'); await expression(`!document.querySelector(${q(sel('fwv-provider-key-status'))})?.textContent.includes('已配置凭据')`);
  const config = await fetch(editor.url + '/api/fwv/provider').then(response => response.json()); assert.equal(config.keyConfigured, false); assert.equal(config.keySource, 'none'); assert.equal(config.canGenerate, true);
  await assertNoCredentialLeaks(); passed('Compatible protocol forces auto background; clear key leaves local keyless service usable');
  await fold('fwv-generation-options'); await fold('fwv-generation-reference-settings'); await fold('fwv-generation-provider-settings');
  await screenshot('03-local-keyless');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false }); await pause(100);
  const overflow = await evaluate(cdp, `({page:document.documentElement.scrollWidth-innerWidth,panel:document.querySelector(${q(sel('fwv-generation'))}).scrollWidth-document.querySelector(${q(sel('fwv-generation'))}).clientWidth})`);
  assert.ok(overflow.page <= 2 && overflow.panel <= 2, `Generation panel overflow: ${JSON.stringify(overflow)}`); await screenshot('04-narrow'); passed('Generation panel fits 1000 px viewport', overflow);

  stage = 'generated image used by Spine';
  const fixtureRoot = path.join(runRoot, 'spine-source'), fixture = await createSpineFixture(fixtureRoot);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1160, deviceScaleFactor: 1, mobile: false });
  await panel('spine');
  await expression(`document.querySelector(${q(sel('fwv-spine-asset'))})?.options.length > 0`);
  await upload('fwv-spine-import-input', fixture.files.map(file => path.join(fixtureRoot, file.name)));
  await waitFor(async () => (await project.snapshot()).assets.some(asset => asset.kind === 'spine'), 'Spine fixture imported');
  await expression(`!document.querySelector(${q(sel('fwv-spine-use-library'))}).disabled`);
  await choose('fwv-spine-library-image', first.asset.id); await click('fwv-spine-use-library');
  await expression(`document.querySelector(${q(sel('fwv-spine-status'))})?.textContent.includes('替换图片已就绪')`);
  await click('fwv-spine-replace');
  const spineAsset = await waitFor(async () => { const asset = (await project.snapshot()).assets.find(entry => entry.kind === 'spine'); return asset?.revisions.length === 2 ? asset : false; }, 'Generated image applied to Spine');
  const page = (await project.readArtifact({ assetId: spineAsset.id, revisionId: spineAsset.selectedRevisionId, fileName: 'fixture.png' })).buffer;
  assert.deepEqual([...await sharp(page).extract({ left: 64, top: 76, width: 1, height: 1 }).ensureAlpha().raw().toBuffer()], [36, 169, 124, 255]);
  assert.deepEqual((await project.readArtifact({ assetId: spineAsset.id, revisionId: spineAsset.selectedRevisionId, fileName: 'fixture.json' })).buffer, fixture.json);
  await expression(`document.querySelector(${q(sel('fwv-spine-replace'))}).disabled`);
  await screenshot('05-generated-spine'); await assertNoCredentialLeaks();
  passed('Generated asset is selected from Spine library and changes actual atlas pixels', { spineAssetId: spineAsset.id, sourceAssetId: first.asset.id });
  assert.equal(report.browserErrors.length, 0, report.browserErrors.join('\n'));
  report.status = 'passed'; report.modelRequestCount = modelRequests().length; report.onlyProvider = providerUrl;
} catch (error) {
  report.status = 'failed'; report.failureStage = stage; report.error = error.stack || String(error); process.exitCode = 1;
  if (cdp) try { await screenshot('failure'); report.visibleStatus = await evaluate(cdp, `({provider:document.querySelector(${q(sel('fwv-provider-status'))})?.textContent,generation:document.querySelector(${q(sel('fwv-generation-status'))})?.textContent,job:document.querySelector(${q(sel('fwv-generation-job-message'))})?.textContent})`); } catch {}
  console.error(`[FWV generation] FAILED at ${stage}: ${error.message}`);
} finally {
  if (cdp) cdp.close(); if (chrome) await stopProcess(chrome); if (editor) await editor.close();
  for (const res of pendingResponses) res.destroy(); mock.closeAllConnections?.(); await new Promise(resolve => mock.close(resolve));
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2));
}
