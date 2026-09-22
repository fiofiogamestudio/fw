import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), fwePath = fileURLToPath(new URL('../../fwe', import.meta.url));
const require = createRequire(import.meta.url);
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test/browser-smoke.js'));
const output = path.join(root, '.local/reports/assets-browser'); await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project');
const project = new FwvProject(projectRoot);
const report = { status: 'running', runRoot, projectRoot, checks: [], browserErrors: [], expectedErrors: [], screenshots: [] };
const generatedImage = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#e34751' } }).png().toBuffer();
let expectedReference;
const modelRequests = [];
const mock = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] })); return; }
  modelRequests.push({ path: request.url, hasReference: Boolean(expectedReference && body.includes(expectedReference)), authenticated: request.headers.authorization === 'Bearer isolated-assets-test-key' });
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ b64_json: generatedImage.toString('base64') }] }));
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
let editor, chrome, cdp, stage = 'setup';
const q = JSON.stringify, sel = id => `[data-testid="${id}"]`;
const wait = expression => waitForExpression(cdp, expression, 15000);
const value = id => evaluate(cdp, `document.querySelector(${q(sel(id))})?.value`);
async function reveal(css) {
  await wait(`document.querySelector(${q(css)})`);
  await evaluate(cdp, `(() => {const el=document.querySelector(${q(css)});for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;el.scrollIntoView({block:'center'});})()`);
}
async function click(css) { await reveal(css); await wait(`!document.querySelector(${q(css)}).disabled`); await evaluate(cdp, `document.querySelector(${q(css)}).click()`); }
async function fill(id, text, event = 'input') {
  await reveal(sel(id)); await wait(`!document.querySelector(${q(sel(id))}).disabled`);
  await evaluate(cdp, `(() => {const el=document.querySelector(${q(sel(id))});el.focus();el.value=${q(String(text))};el.dispatchEvent(new Event(${q(event)},{bubbles:true}));})()`);
}
async function screenshot(name) {
  await evaluate(cdp, `(() => {const root=document.querySelector('[data-testid="fwv-assets"]');for(let p=root;p;p=p.parentElement){p.scrollTop=0;p.scrollLeft=0;}window.scrollTo(0,0);})()`);
  const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(runRoot, name + '.png'); await fs.writeFile(target, Buffer.from(result.data, 'base64')); report.screenshots.push(target);
}
const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log(`[FWV assets] ${name}`); };
async function latestChange() { return (await project.snapshot()).changes?.at(-1); }
async function waitDisk(fn, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
}
async function upload(id, file) {
  const tree = await cdp.call('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: tree.root.nodeId, selector: sel(id) });
  await cdp.call('DOM.setFileInputFiles', { nodeId, files: [file] });
}
try {
  await project.init({ name: '素材问题闭环验收' });
  const source = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#f5cf65' } }).png().toBuffer();
  const candidate = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#f5cf65' } })
    .composite([{ input: await sharp({ create: { width: 32, height: 40, channels: 4, background: '#3165c9' } }).png().toBuffer(), left: 24, top: 32 }]).png().toBuffer();
  const imported = await project.importImage({ name: '图标基线', fileName: 'baseline.png', buffer: source });
  const sourceId = imported.id, sourceRevision = imported.selectedRevisionId, candidateFile = path.join(runRoot, 'candidate.png');
  await fs.writeFile(candidateFile, candidate);
  editor = await startEditor({ projectRoot, fwePath, port: 0 }); report.url = editor.url;
  const session = await fetch(editor.url + '/api/fwv/session').then(response => response.json());
  const configured = await fetch(editor.url + '/api/fwv/commands', { method: 'POST', headers: { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWV-CSRF': session.csrfToken },
    body: JSON.stringify({ type: 'provider.configure', payload: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, protocol: 'gpt-image', model: 'gpt-image-2', apiKey: 'isolated-assets-test-key' } }) });
  assert.equal(configured.status, 200);
  const debugPort = await getFreePort(); chrome = startChrome(editor.url, debugPort);
  const target = await waitForTarget(debugPort, editor.url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Log.entryAdded', event => { if (event.entry?.level === 'error') {
    if (stage === 'concurrent review conflict' && /409/.test(event.entry.text)) report.expectedErrors.push(event.entry.text);
    else report.browserErrors.push(event.entry.text);
  } });
  for (const domain of ['Runtime', 'Log', 'Page', 'DOM']) await cdp.call(domain + '.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.reload', { ignoreCache: true });
  await wait(`document.querySelector('[data-testid="fwv-assets-source"]')?.value === ${q(sourceId)}`);
  await wait(`(() => {const c=document.querySelector('[data-testid="fwv-assets-source-canvas"]');return c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data[0] === 245;})()`);
  assert.equal(await evaluate(cdp, 'window.fwe.navigation.current().collectionId'), 'changeDrafts');
  const initial = await evaluate(cdp, `(() => {const root=document.querySelector('[data-testid="fwv-assets"]');return {sections:Array.from(document.querySelectorAll('button[data-section-id]')).map(n=>n.dataset.sectionId),history:document.querySelector('[data-testid="fwv-assets-history"]').open,more:document.querySelector('[data-testid="fwv-assets-more-request"]').open,execution:document.querySelector('[data-testid="fwv-assets-execution"]').open,columns:root.querySelector('[data-fwv-role="comparison"]').dataset.columns,candidateVisible:document.querySelector('[data-testid="fwv-assets-candidate-canvas"]').getClientRects().length,save:document.querySelector('#saveButton').textContent};})()`);
  assert.ok(initial.sections.every(id => id === 'assets'));
  assert.deepEqual({ ...initial, sections: [] }, { sections: [], history: false, more: false, execution: false, columns: '1', candidateVisible: 0, save: '保存草稿' });
  await screenshot('00-one-prompt-1600');
  record('The default page has one large viewport, one prompt, collapsed details and tools, and explicitly labeled draft actions', initial);

  stage = 'draft history';
  await fill('fwv-assets-request', '把中心图案改为蓝色');
  await fill('fwv-assets-request', '只把圈选位置的图案改为蓝色');
  await click('#undoButton'); await wait(`document.querySelector('[data-testid="fwv-assets-request"]')?.value === '把中心图案改为蓝色'`);
  await click('#redoButton'); await wait(`document.querySelector('[data-testid="fwv-assets-request"]')?.value === '只把圈选位置的图案改为蓝色'`);
  await fill('fwv-assets-preserve', '保留黄色底色、画布尺寸、选区以外的像素');
  assert.equal(await value('fwv-assets-title'), '只把圈选位置的图案改为蓝色');
  record('Issue drafts participate in the native FWE Undo and Redo lifecycle');

  stage = 'canvas selection';
  await reveal(sel('fwv-assets-source-canvas'));
  const rect = await evaluate(cdp, `(() => {const c=document.querySelector('[data-testid="fwv-assets-source-canvas"]'),r=c.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bitmapWidth:c.width,bitmapHeight:c.height};})()`);
  const scale = Math.min((rect.bitmapWidth - 32) / 128, (rect.bitmapHeight - 32) / 128);
  const sourcePoint = (x, y) => ({ x: rect.x + ((rect.bitmapWidth - 128 * scale) / 2 + x * scale) * rect.width / rect.bitmapWidth,
    y: rect.y + ((rect.bitmapHeight - 128 * scale) / 2 + y * scale) * rect.height / rect.bitmapHeight });
  const a = sourcePoint(24, 32), b = sourcePoint(56, 72);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...a });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...b });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...b });
  await wait(`document.querySelector('[data-testid="fwv-assets-region-width"]').value === '32'`);
  assert.equal(await value('fwv-assets-region-x'), '24');
  await click('#saveButton'); await wait('window.fwe.resources.current().dirty === false');
  const stored = JSON.parse(await fs.readFile(path.join(projectRoot, '.fwv/editor-drafts.json'), 'utf8'));
  assert.deepEqual(stored.changeDrafts[0].data.region, { x: 24, y: 32, width: 32, height: 40 });
  assert.equal((await project.snapshot()).changes?.length || 0, 0);
  record('Real pointer selection stores source pixel coordinates; Ctrl+S saves only the draft');

  stage = 'create and prepare';
  await click(sel('fwv-assets-create'));
  let change = await waitDisk(async () => await latestChange(), 'created change');
  assert.equal(change.source.assetId, sourceId); assert.equal(change.source.revisionId, sourceRevision);
  assert.equal(change.title, '只把圈选位置的图案改为蓝色');
  assert.deepEqual(change.anchors.region, { x: 24, y: 32, width: 32, height: 40 });
  await wait(`document.querySelector('[data-testid="fwv-assets-handoff"]').value.includes(${q(sourceRevision)})`);
  const handoff = await value('fwv-assets-handoff');
  assert.match(handoff, /保留黄色底色/); assert.match(handoff, /SHA-256/); assert.ok(handoff.includes(projectRoot));
  record('One prompt action automatically titles the request and prepares the local AI handoff with the exact source, region and file hashes');

  stage = 'candidate upload and reject';
  await upload('fwv-assets-candidate-file', candidateFile);
  change = await waitDisk(async () => { const next = await latestChange(); return next.candidates.length === 1 ? next : null; }, 'first candidate');
  assert.equal((await project.snapshot()).assets.find(item => item.id === sourceId).selectedRevisionId, sourceRevision);
  await wait(`document.querySelector('[data-testid="fwv-assets-candidates"]').value === ${q(change.candidates[0].id)}`);
  await fill('fwv-assets-review-comment', '颜色改变正确，但希望边缘更精确'); await click(sel('fwv-assets-reject'));
  change = await waitDisk(async () => { const next = await latestChange(); return next.candidates[0].review.decision === 'rejected' ? next : null; }, 'rejected');
  assert.equal(await evaluate(cdp, `document.querySelector('[data-testid="fwv-assets-use"]').disabled`), true);
  record('Import creates a reviewable candidate without adopting it; rejected candidates cannot be adopted');

  stage = 'one action, partial failure and exact retry';
  await upload('fwv-assets-candidate-file', candidateFile);
  change = await waitDisk(async () => { const next = await latestChange(); return next.candidates.length === 2 ? next : null; }, 'second candidate');
  await wait(`document.querySelector('[data-testid="fwv-assets-candidates"]').value === ${q(change.candidates[1].id)}`);
  await wait(`(() => {const c=document.querySelector('[data-testid="fwv-assets-candidate-canvas"]'),s=Math.min((c.width-32)/128,(c.height-32)/128);return c.getContext('2d').getImageData((c.width-128*s)/2+40*s,(c.height-128*s)/2+50*s,1,1).data[2]>100;})()`);
  await screenshot('01-result-ready-1600');
  await fill('fwv-assets-review-comment', '局部修改通过，保持范围符合要求');
  await evaluate(cdp, `(() => {const original=window.fetch.bind(window);window.__useRequests=[];window.__failAdoptOnce=true;window.fetch=async function(url,options){if(String(url).includes('/api/fwv/commands')&&options?.body){const b=JSON.parse(options.body);if(['change.review','change.adopt'].includes(b.type))window.__useRequests.push(b);if(b.type==='change.adopt'&&window.__failAdoptOnce){window.__failAdoptOnce=false;return new Response(JSON.stringify({error:'隔离验收：采用暂时失败',code:'isolated-adopt-failure'}),{status:409,headers:{'Content-Type':'application/json'}})}if(b.type==='change.adopt'&&window.__loseAdoptResponse){window.__loseAdoptResponse=false;await original(url,options);throw new Error('隔离验收：采用响应丢失')}}return original(url,options)}})()`);
  await click(sel('fwv-assets-use'));
  await wait(`document.querySelector('[data-testid="fwv-status"]').textContent.includes('隔离验收：采用暂时失败')`);
  change = await latestChange(); assert.equal(change.candidates[1].review.decision, 'accepted'); assert.equal(change.adoption, null);
  assert.equal((await project.snapshot()).assets.find(item => item.id === sourceId).selectedRevisionId, sourceRevision);
  await wait(`!document.querySelector('[data-testid="fwv-assets-use"]').disabled`);
  await evaluate(cdp, `document.querySelector('[data-testid="fwv-assets-review-details"]').open=false`);
  await screenshot('01-candidate-review-1600');
  const decisionVisible = await evaluate(cdp, `(() => {const r=document.querySelector('[data-testid="fwv-assets-use"]').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()`);
  assert.equal(decisionVisible, true);
  await evaluate(cdp, 'window.__loseAdoptResponse=true');
  await click(sel('fwv-assets-use'));
  change = await waitDisk(async () => { const next = await latestChange(); return next.adoptedCandidateId ? next : null; }, 'adopted');
  const adopted = (await project.snapshot()).assets.find(item => item.id === sourceId);
  assert.equal(adopted.revisions.length, 2); assert.notEqual(adopted.selectedRevisionId, sourceRevision);
  assert.equal(change.source.revisionId, sourceRevision); assert.equal(change.candidates[0].review.decision, 'rejected');
  assert.equal(await value('fwv-assets-revision'), sourceRevision);
  await wait(`document.querySelector('[data-testid="fwv-status"]').textContent.includes('已保存为新版本') && document.querySelector('[data-testid="fwv-status"]').getAttribute('data-error') === 'false'`);
  const useRequests = await evaluate(cdp, 'window.__useRequests');
  assert.deepEqual(useRequests.map(item=>item.type), ['change.review','change.adopt','change.adopt']);
  for (const call of useRequests) { assert.equal(call.payload.changeId, change.id); assert.equal(call.payload.candidateId, change.candidates[1].id); }
  assert.equal(useRequests[0].payload.expectedReview.decision, 'pending'); assert.equal(useRequests[1].payload.expectedAdoption, null); assert.equal(useRequests[2].payload.expectedAdoption, null);
  record('Use retries only the exact adoption after partial failure, and a lost success response is confirmed by rereading instead of reporting failure', {useRequests,decisionVisible});

  stage = 'persistence and layout';
  await click('#saveButton'); await wait('window.fwe.resources.current().dirty === false');
  await cdp.call('Page.reload', { ignoreCache: true });
  await wait(`document.querySelector('[data-testid="fwv-assets-changes"]')?.value === ${q(change.id)}`);
  await wait(`document.querySelector('[data-testid="fwv-assets-candidates"]')?.value === ${q(change.candidates[1].id)}`);
  assert.equal(await value('fwv-assets-revision'), sourceRevision);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1100, deviceScaleFactor: 1, mobile: false });
  await screenshot('02-assets-1000');
  const overflow = await evaluate(cdp, `({page:document.documentElement.scrollWidth-innerWidth,panel:document.querySelector('[data-testid="fwv-assets"]').scrollWidth-document.querySelector('[data-testid="fwv-assets"]').clientWidth})`);
  assert.ok(overflow.page <= 2 && overflow.panel <= 2, JSON.stringify(overflow));
  await click('button[data-workspace-id="fwv-tools"]');
  for (const section of ['images', 'spine', 'rig', 'reskin', 'generate']) await wait(`document.querySelector('button[data-section-id="${section}"]')`);
  await click('button[data-workspace-id="fwv"]'); await wait(`document.querySelector('[data-testid="fwv-assets-source"]')`);
  record('Reload restores source and results; the native Tools workspace retains every legacy route and the narrow layout has no overflow', overflow);

  stage = 'source-aware API generation';
  await click(sel('fwv-assets-continue'));
  await wait(`document.querySelector('[data-testid="fwv-assets-revision"]').value === ${q(adopted.selectedRevisionId)}`);
  assert.equal(await value('fwv-assets-revision'), adopted.selectedRevisionId);
  await fill('fwv-assets-request', '把选区改为红色，保持完整构图');
  await fill('fwv-assets-preserve', '选区外的像素必须完全不变');
  for (const [id, number] of [['x',24],['y',32],['width',32],['height',40]]) await fill('fwv-assets-region-' + id, number);
  const adoptedRevision = adopted.revisions.find(item => item.id === adopted.selectedRevisionId), sourceFile = adoptedRevision.files.find(item => item.role === 'image');
  expectedReference = (await project.readArtifact({ assetId: sourceId, revisionId: adoptedRevision.id, fileName: sourceFile.name })).buffer;
  await fill('fwv-assets-mode', 'api', 'change'); await click(sel('fwv-assets-create'));
  const nextChange = await waitDisk(async () => { const next = await latestChange(); return next.id !== change.id ? next : null; }, 'API issue');
  await wait(`document.querySelector('[data-testid="fwv-assets-recover"]') && !document.querySelector('[data-testid="fwv-assets-recover"]').hidden`);
  await click(sel('fwv-assets-recover'));
  const apiChange = await waitDisk(async () => { const next = await latestChange(); return next.id === nextChange.id && next.candidates.length ? next : null; }, 'recovered API candidate');
  assert.equal(apiChange.candidates[0].scope.mode, 'preserve-outside');
  assert.equal(apiChange.candidates[0].scope.outsidePixels, 'preserved');
  assert.equal((await project.snapshot()).assets.find(item => item.id === sourceId).selectedRevisionId, adopted.selectedRevisionId);
  assert.deepEqual(modelRequests, [{ path: '/v1/images/edits', hasReference: true, authenticated: true }]);
  await wait(`document.querySelector('[data-testid="fwv-assets-scope-info"]').textContent.includes('1024')`);
  record('The API path edits the exact current source, recovers one candidate and locks outside-region pixels without adopting it', { modelRequests, scope: apiChange.candidates[0].scope });
  stage = 'concurrent review conflict';
  const rejectedElsewhere = await fetch(editor.url + '/api/fwv/commands', { method: 'POST', headers: { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWV-CSRF': session.csrfToken },
    body: JSON.stringify({ type: 'change.review', payload: { changeId: apiChange.id, candidateId: apiChange.candidates[0].id, decision: 'rejected', comment: '另一窗口已决定不用这版' } }) });
  assert.equal(rejectedElsewhere.status, 200);
  await click(sel('fwv-assets-use'));
  await wait(`document.querySelector('[data-testid="fwv-assets-use"]').disabled`);
  await wait(`document.querySelector('[data-testid="fwv-status"]').getAttribute('data-error')==='true'`);
  const concurrent = await latestChange(); assert.equal(concurrent.candidates[0].review.decision, 'rejected'); assert.equal(concurrent.adoption, null);
  assert.equal((await project.snapshot()).assets.find(item => item.id === sourceId).selectedRevisionId, adopted.selectedRevisionId);
  record('A stale Use click cannot overwrite another window\'s rejection; the same result is refreshed and remains unadopted');
  stage = 'unconfigured provider';
  const beforeConfiguration = (await project.snapshot()).changes.length;
  const cleared = await fetch(editor.url + '/api/fwv/commands', { method: 'POST', headers: { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWV-CSRF': session.csrfToken },
    body: JSON.stringify({ type: 'provider.configure', payload: { baseUrl: 'https://images.invalid/v1', protocol: 'gpt-image', model: 'gpt-image-2', clearKey: true } }) });
  assert.equal(cleared.status, 200);
  await click(sel('fwv-assets-continue')); await fill('fwv-assets-request', '配置服务后再修改，不要提前派发');
  await click('#saveButton'); await wait('window.fwe.resources.current().dirty === false');
  await cdp.call('Page.reload', { ignoreCache: true });
  await wait(`document.querySelector('[data-testid="fwv-assets-create"]')?.textContent==='配置图像服务'`);
  await click(sel('fwv-assets-create')); await wait(`window.fwe.navigation.current().collectionId==='generationDrafts'`);
  assert.equal((await project.snapshot()).changes.length, beforeConfiguration); assert.equal(modelRequests.length, 1);
  await click('button[data-workspace-id="fwv"]');
  await wait(`document.querySelector('[data-testid="fwv-assets-request"]')?.value==='配置服务后再修改，不要提前派发'`);
  record('Without a configured provider, the primary action opens real settings, retains the prompt, and creates no request or model call');
  assert.deepEqual(report.browserErrors, []); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failureStage = stage; report.error = error.stack || String(error); process.exitCode = 1;
  if (cdp) try { report.visibleStatus = await evaluate(cdp, `document.querySelector('[data-testid="fwv-status"]')?.textContent`); await screenshot('failure'); } catch {}
  console.error(`[FWV assets] FAILED at ${stage}: ${error.message}`);
} finally {
  if (cdp) cdp.close(); if (chrome) await stopProcess(chrome); if (editor) await editor.close();
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2));
}
