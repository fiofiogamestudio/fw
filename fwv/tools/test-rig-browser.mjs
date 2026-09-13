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
import { saveRigDraft } from '../src/rig/application.mjs';
import { createRigFixture } from '../examples/rig-fixture/create.mjs';

// Repeatable acceptance with an owned Chrome profile, ephemeral ports and no model service.
const require = createRequire(import.meta.url), fwvRoot = fileURLToPath(new URL('../', import.meta.url));
const fwePath = await fs.realpath(process.env.FWV_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url)));
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test', 'browser-smoke.js'));
let outputArgument;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] !== '--output' || !process.argv[index + 1]) throw new Error('Usage: node tools/test-rig-browser.mjs [--output directory]');
  outputArgument = process.argv[++index];
}
const output = path.resolve(outputArgument || path.join(fwvRoot, '.local', 'reports', 'rig-browser'));
await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project'), sourceRoot = path.join(runRoot, 'source');
const project = new FwvProject(projectRoot), fixture = await createRigFixture(sourceRoot);
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', runRoot, projectRoot, checks: [], screenshots: [], browserErrors: [], expectedErrors: [], modelRequests: [], dialogs: [] };
const digest = buffer => createHash('sha256').update(buffer).digest('hex'), q = JSON.stringify, sel = id => `[data-testid="${id}"]`, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let editor, chrome, cdp, stage = 'setup', draftId;
const provider = http.createServer((request, response) => {
  report.modelRequests.push({ method: request.method, url: request.url });
  request.resume(); response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Rig acceptance must not call any model.' } }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
function passed(name, details = {}) { report.checks.push({ name, status: 'passed', ...details }); console.log(`[FWV rig] ${name}`); }
async function waitFor(fn, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(80); }
  throw new Error(`Timed out: ${label}`);
}
const expression = value => waitForExpression(cdp, value, 25000);
async function deadline(promise, milliseconds, label) {
  let timeout; try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds); })]); } finally { clearTimeout(timeout); }
}
async function reveal(id, { picker = false } = {}) {
  await expression(`document.querySelector(${q(sel(id))})`);
  await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel(id))});const ancestors=[];for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')ancestors.unshift(parent);for(const details of ancestors)if(!details.open){const summary=details.querySelector(':scope > summary');if(!summary)throw new Error('Details has no summary');summary.click();}})()`);
  if (!picker) await expression(`(() => {const node=document.querySelector(${q(sel(id))});return node.getClientRects().length > 0 && !node.closest('[hidden],details:not([open])');})()`);
}
async function click(id) {
  await expression(`document.querySelector(${q(sel(id))}) && !document.querySelector(${q(sel(id))}).disabled`);
  await reveal(id);
  await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel(id))});node.scrollIntoView({block:'center'});node.click();})()`);
}
async function fill(id, value) {
  await expression(`document.querySelector(${q(sel(id))}) && !document.querySelector(${q(sel(id))}).disabled`);
  await reveal(id);
  await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel(id))});node.value=${q(String(value))};node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function choose(id, value) {
  await expression(`document.querySelector(${q(sel(id))}) && !document.querySelector(${q(sel(id))}).disabled`);
  await reveal(id);
  await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel(id))});node.value=${q(String(value))};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function panel(name) {
  await expression(`document.querySelector('button[data-workspace-id="fwv-tools"]') && !document.querySelector('button[data-workspace-id="fwv-tools"]').disabled`);
  await evaluate(cdp, `(() => {const tab=document.querySelector('button[data-workspace-id="fwv-tools"]');if(tab.getAttribute('aria-selected')!=='true')tab.click();})()`);
  await expression(`(() => {const tab=document.querySelector('button[data-section-id="${name}"]');if(!tab || tab.disabled)return false;tab.click();return true;})()`);
  await expression(name === 'images' ? `document.querySelector('[data-testid=fwv-width]')` : `document.querySelector(${q(sel('fwv-' + name))})`);
}
async function upload(id, files) {
  await reveal(id, { picker: true });
  const tree = await cdp.call('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: tree.root.nodeId, selector: sel(id) });
  assert.ok(nodeId, `Missing actual picker ${id}`); await cdp.call('DOM.setFileInputFiles', { nodeId, files });
}
async function screenshot(name, focus = 'fwv-rig') {
  await evaluate(cdp, `(() => {let node=document.querySelector(${q(sel(focus))});while(node){node.scrollTop=0;node.scrollLeft=0;node=node.parentElement;}window.scrollTo(0,0);})()`);
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(runRoot, name + '.png'); await fs.writeFile(target, Buffer.from(shot.data, 'base64')); report.screenshots.push(target);
}
async function collapseSections(focus = 'fwv-rig') {
  await evaluate(cdp, `(() => {const root=document.querySelector(${q(sel(focus))});for(const details of root.querySelectorAll('details[open]'))details.querySelector(':scope > summary').click();})()`);
}
async function screenshotPreview(name) {
  await reveal('fwv-rig-preview-canvas');
  await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-preview-canvas'))}).scrollIntoView({block:'center'})`);
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(runRoot, name + '.png'); await fs.writeFile(target, Buffer.from(shot.data, 'base64')); report.screenshots.push(target);
}
async function draft() {
  const asset = (await project.snapshot()).assets.find(asset => asset.id === draftId);
  const revision = asset?.revisions.find(revision => revision.id === asset.selectedRevisionId);
  return asset ? { asset, revision, document: revision.metadata.rig } : null;
}
async function sourcePoint(point) {
  return evaluate(cdp, `(() => {const node=document.querySelector(${q(sel('fwv-rig-overlay'))});node.scrollIntoView({block:'center'});const matrix=node.getScreenCTM();const point=new DOMPoint(${point.x},${point.y}).matrixTransform(matrix);return {x:point.x,y:point.y};})()`);
}
async function point(point) {
  const position = await sourcePoint(point);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
}
async function dragVertex(index, destination) {
  const target = await sourcePoint(destination);
  const position = await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel('fwv-rig-overlay') + ` circle[data-vertex-index="${index}"]`)});const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 5; step++) await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: position.x + (target.x - position.x) * step / 5, y: position.y + (target.y - position.y) * step / 5, button: 'left', buttons: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', clickCount: 1 });
}
async function save() {
  const before = (await draft()).revision.id;
  await click('fwv-rig-save');
  const saved = await waitFor(async () => { const current = await draft(); return current.revision.id !== before ? current : false; }, 'edited rig revision saved');
  await expression(`!document.querySelector(${q(sel('fwv-rig-build'))}).disabled`);
  return saved;
}
async function build() {
  const before = new Set((await project.snapshot()).assets.filter(asset => asset.kind === 'spine').map(asset => asset.id));
  await click('fwv-rig-build');
  const asset = await waitFor(async () => (await project.snapshot()).assets.find(asset => asset.kind === 'spine' && !before.has(asset.id)), 'local Spine candidate created');
  const revision = asset.revisions.find(revision => revision.id === asset.selectedRevisionId);
  if (!before.size) {
    await expression(`document.querySelector('[data-testid="fwv-rig-preview"]')?.hidden === false`);
    assert.equal(await evaluate(cdp, `document.querySelector('[data-testid="fwv-rig-preview"]').open`),true,'The first generated candidate opens its animation preview without a manual expand.');
  }
  await reveal('fwv-rig-preview-canvas');
  await expression(`document.querySelector(${q(sel('fwv-rig-preview-canvas'))})?.dataset.rendered === 'true'`);
  await expression(`document.querySelector(${q(sel('fwv-rig'))})?.getAttribute('aria-busy') === 'false'`);
  const skeleton = revision.files.find(file => file.role === 'skeleton');
  const bytes = (await project.readArtifact({ assetId: asset.id, revisionId: revision.id, fileName: skeleton.name })).buffer;
  return { asset, revision, json: JSON.parse(bytes), bytes, ref: { assetId: asset.id, revisionId: revision.id } };
}
async function canvas(name) {
  await reveal('fwv-rig-preview-canvas');
  await expression(`document.querySelector(${q(sel('fwv-rig-preview-canvas'))})?.dataset.rendered === 'true'`);
  const png = Buffer.from(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-preview-canvas'))}).toDataURL('image/png').split(',')[1]`), 'base64');
  const file = path.join(runRoot, name + '.png'); await fs.writeFile(file, png); report.screenshots.push(file);
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let painted = 0; for (let offset = 3; offset < data.length; offset += 4) if (data[offset] > 30) painted++;
  assert.ok(painted > 500, `Actual preview contains only ${painted} painted pixels.`);
  return { sha256: digest(png), painted, width: info.width, height: info.height };
}

try {
  if (typeof WebSocket !== 'function') throw new Error('Rig browser acceptance needs Node.js 22 or newer.');
  await project.init({ name: 'FWV · 单图拆分与规则骨骼验收' });
  editor = await startEditor({ projectRoot, fwePath, port: 0 }); report.url = editor.url;
  const session = await fetch(editor.url + '/api/fwv/session').then(response => response.json());
  const configuration = await fetch(editor.url + '/api/fwv/commands', { method: 'POST', headers: { Origin: editor.url, 'X-FWV-CSRF': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'provider.configure', payload: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, protocol: 'openai-compatible', clearKey: true } }) });
  assert.equal(configuration.status, 200);
  const debugPort = await getFreePort(); chrome = startChrome(editor.url, debugPort);
  const target = await waitForTarget(debugPort, editor.url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Page.javascriptDialogOpening', event => {
    report.dialogs.push({ stage, type: event.type, message: event.message });
    void cdp.call('Page.handleJavaScriptDialog', { accept: event.type === 'beforeunload' }).catch(error => report.browserErrors.push(error.message));
  });
  cdp.on('Log.entryAdded', event => {
    if (event.entry?.level !== 'error') return;
    const detail = `${event.entry.text} @ ${event.entry.url || ''}`;
    if (stage === 'failed save' && /400|503/.test(detail) || stage === 'concurrent draft recovery' && /409/.test(detail)) report.expectedErrors.push(detail); else report.browserErrors.push(detail);
  });
  for (const domain of ['Runtime', 'Log', 'Page', 'DOM']) await cdp.call(domain + '.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1180, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.reload', { ignoreCache: true });
  await panel('rig');

  stage = 'image import';
  await upload('fwv-rig-import-input', [path.join(sourceRoot, fixture.fileName)]);
  const source = await waitFor(async () => (await project.snapshot()).assets.find(asset => asset.kind === 'image'), 'source image imported by picker');
  const sourceRef = { assetId: source.id, revisionId: source.selectedRevisionId, fileName: fixture.fileName };
  const originalHash = digest((await project.readArtifact(sourceRef)).buffer);
  assert.equal(originalHash, digest(fixture.buffer));
  await expression(`document.querySelector(${q(sel('fwv-rig-source-asset'))})?.value === ${q(source.id)}`);
  await fill('fwv-rig-name', '猫咪游侠 · 可修改骨骼'); await click('fwv-rig-create');
  const created = await waitFor(async () => (await project.snapshot()).assets.find(asset => asset.kind === 'rig'), 'six-part rig draft created'); draftId = created.id;
  await expression(`document.querySelector(${q(sel('fwv-rig-part'))})?.options.length === 6 && document.querySelector(${q(sel('fwv-rig-source-image'))})?.naturalWidth === ${fixture.width}`);
  assert.equal((await draft()).document.parts.length, 6); assert.equal(report.modelRequests.length, 0);
  passed('Actual file picker imports immutable source and creates a six-part local rig draft', { source: sourceRef, sourceSha256: originalHash, draftId });
  const focusedEditor = await evaluate(cdp, `(() => {const root=document.querySelector('[data-testid="fwv-rig"]'),stage=root.querySelector('[data-testid="fwv-rig-stage"]');const shown=node=>Boolean(node.getClientRects().length)&&!node.closest('[hidden],details:not([open])');return {openSections:root.querySelectorAll('details[open]').length,primaryActions:[...root.querySelectorAll('button')].filter(node=>shown(node)&&node.dataset.tone==='primary').length,canvasWidth:stage.clientWidth,canvasHeight:stage.clientHeight,currentPartShown:shown(root.querySelector('[data-testid="fwv-rig-part"]')),pivotFolded:!shown(root.querySelector('[data-testid="fwv-rig-pivot-x"]'))};})()`);
  assert.equal(focusedEditor.openSections, 0); assert.equal(focusedEditor.primaryActions, 1); assert.equal(focusedEditor.currentPartShown, true); assert.equal(focusedEditor.pivotFolded, true); assert.ok(focusedEditor.canvasWidth >= 300 && focusedEditor.canvasHeight >= 340, JSON.stringify(focusedEditor));
  await screenshot('00-focused-editor');
  passed('Initial rig workspace emphasizes canvas and current part with advanced sections folded', focusedEditor);

  stage = 'draw polygons';
  for (const part of fixture.parts) {
    await choose('fwv-rig-part', part.id); await click('fwv-rig-draw');
    for (const vertex of part.polygon) await point(vertex);
    await click('fwv-rig-close'); await fill('fwv-rig-part-name', part.name);
    await click('fwv-rig-set-pivot'); await point(part.pivot);
  }
  await choose('fwv-rig-part', 'head');
  for (let index = 0; index < 6; index++) {
    if (await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-forward'))}).disabled`)) break;
    await click('fwv-rig-forward');
  }
  const masked = await save();
  for (const part of fixture.parts) {
    const saved = masked.document.parts.find(item => item.id === part.id);
    assert.deepEqual(saved.polygon, part.polygon); assert.deepEqual(saved.pivot, part.pivot);
  }
  assert.equal(masked.document.parts.at(-1).id, 'head');
  passed('Six masks and joint pivots are drawn using real pointer events; head draw order is corrected');
  await screenshot('01-six-part-draft');

  stage = 'build and animate';
  const first = await build();
  await evaluate(cdp, `document.querySelector('[data-testid="fwv-rig-preview"] > summary').click()`);
  await click('fwv-rig-set-pivot'); await click('fwv-rig-select-mode');
  assert.equal(await evaluate(cdp, `document.querySelector('[data-testid="fwv-rig-preview"]').open`),false,'Subsequent editor updates preserve a manually collapsed preview.');
  assert.deepEqual(Object.keys(first.json.animations).sort(), ['idle', 'walk', 'wave']);
  assert.equal(first.json.slots.length, 6); assert.equal(first.json.bones.length, 7);
  assert.deepEqual(first.json.slots.map(slot => slot.name), masked.document.parts.map(part => `slot_${part.id}`));
  const firstFrame = await canvas('02-built-frame'); await pause(350); const laterFrame = await canvas('03-animated-frame');
  assert.notEqual(firstFrame.sha256, laterFrame.sha256, 'Playing the actual Spine skeleton must change visible pixels.');
  passed('Local build generates six actual attachments and three playable animations', { candidate: first.ref, frames: [firstFrame, laterFrame] });
  await screenshot('04-built-character');
  const motionFrames = {};
  for (const animation of ['walk', 'wave']) {
    await choose('fwv-rig-animation', animation);
    const start = await canvas(`04-${animation}-start`); await pause(320); const moved = await canvas(`04-${animation}-moved`);
    assert.notEqual(start.sha256, moved.sha256, `${animation} must change the actual rendered attachment pixels.`);
    motionFrames[animation] = [start, moved];
  }
  await screenshotPreview('04-rule-motion-preview');
  passed('Walk and wave controls each animate the actual generated skeleton', { frames: motionFrames });

  stage = 'FWE draft navigation';
  await choose('fwv-rig-part', 'head');
  const headPolygon = sel('fwv-rig-overlay') + ' polygon[data-part-id="head"]';
  const originalPoints = await evaluate(cdp, `document.querySelector(${q(headPolygon)}).getAttribute('points')`);
  await dragVertex(0, { x: 142, y: 48 });
  const draggedPoints = await evaluate(cdp, `document.querySelector(${q(headPolygon)}).getAttribute('points')`);
  assert.equal(draggedPoints.split(' ')[0], '142,48');
  await expression(`!document.querySelector('#undoButton').disabled`); await evaluate(cdp, `document.querySelector('#undoButton').click()`);
  await expression(`document.querySelector(${q(headPolygon)})?.getAttribute('points') === ${q(originalPoints)}`);
  await expression(`!document.querySelector('#redoButton').disabled`); await evaluate(cdp, `document.querySelector('#redoButton').click()`);
  await expression(`document.querySelector(${q(headPolygon)})?.getAttribute('points') === ${q(draggedPoints)}`);
  passed('One FWE toolbar undo restores the complete original polygon after a real multi-move drag; redo restores exact edited coordinates');
  await click('fwv-rig-set-pivot'); await point({ x: 205, y: 151 });
  await expression(`document.querySelector(${q(sel('fwv-rig-build'))}).disabled`);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-draft'))}).disabled`), false, 'FWE retains edits separately for each rig asset, so switching drafts remains available.');
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-draft-revision'))}).disabled`), true, 'Unsaved geometry must not be silently replaced by another revision.');
  await panel('images');
  assert.equal(await evaluate(cdp, `Boolean(document.querySelector(${q(sel('fwv-rig'))}))`), false, 'Leaving the rig panel must really dispose its editor.');
  await panel('rig');
  await expression(`document.querySelector(${q(sel('fwv-rig-part'))})?.value === 'head'`);
  assert.equal(Number(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-pivot-x'))}).value`)), 205);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-overlay') + ' polygon[data-part-id="head"]')}).getAttribute('points').split(' ')[0]`), '142,48');
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-build'))}).disabled`), true);
  passed('FWE retains dirty polygon and pivot edits across actual panel disposal; building and revision switching still require saving');

  stage = 'save parameter semantics';
  const beforeParameterSave = (await draft()).revision.id;
  await cdp.call('Input.dispatchKeyEvent', { type:'keyDown', key:'s', code:'KeyS', modifiers:2, windowsVirtualKeyCode:83 });
  await cdp.call('Input.dispatchKeyEvent', { type:'keyUp', key:'s', code:'KeyS', modifiers:2, windowsVirtualKeyCode:83 });
  await expression(`document.querySelector('#saveButton').disabled`);
  assert.equal((await draft()).revision.id, beforeParameterSave);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-build'))}).disabled`), true);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-save'))}).textContent`), '创建拆件版本');
  assert.match(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-dirty'))}).textContent`), /顶部保存.*进度.*创建拆件版本/);
  passed('Ctrl+S saves editor parameters while visible guidance distinguishes creating a rig revision for generation');

  stage = 'failed save';
  const beforeFailure = await draft();
  await choose('fwv-rig-part', 'torso');
  assert.equal(await evaluate(cdp, `Array.from(document.querySelector(${q(sel('fwv-rig-parent'))}).options).some(option=>option.value==='head')`), false, 'Parent menu must prevent a descendant cycle.');
  await choose('fwv-rig-part', 'head'); await click('fwv-rig-draw');
  const crossed = [{ x: 142, y: 48 }, { x: 266, y: 165 }, { x: 134, y: 165 }, { x: 266, y: 44 }];
  for (const vertex of crossed) await point(vertex);
  await click('fwv-rig-close'); await click('fwv-rig-save');
  await expression(`document.querySelector(${q(sel('fwv-rig-status'))})?.dataset.error === 'true' && !document.querySelector(${q(sel('fwv-rig-save'))}).disabled`);
  assert.equal((await draft()).revision.id, beforeFailure.revision.id);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-overlay') + ' polygon[data-part-id="head"]')}).getAttribute('points')`), crossed.map(vertex => `${vertex.x},${vertex.y}`).join(' '));
  assert.equal(Number(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-pivot-x'))}).value`)), 205);
  await click('fwv-rig-draw');
  for (const vertex of [{ x: 142, y: 48 }, ...fixture.parts.find(part => part.id === 'head').polygon.slice(1)]) await point(vertex);
  await click('fwv-rig-close');
  const corrected = await save();
  assert.deepEqual(corrected.document.parts.find(part => part.id === 'head').pivot, { x: 205, y: 151 });
  assert.deepEqual(corrected.document.parts.find(part => part.id === 'head').polygon[0], { x: 142, y: 48 });
  passed('A self-intersecting mask is rejected by the real API without losing edits; a corrected mask saves successfully');

  stage = 'rebuild changed rig';
  const second = await build();
  assert.notEqual(second.asset.id, first.asset.id); assert.notEqual(digest(second.bytes), digest(first.bytes));
  assert.notDeepEqual(second.json.bones, first.json.bones, 'Edited pivot must change generated bone offsets.');
  assert.notDeepEqual(second.json.skins, first.json.skins, 'Edited polygon must change generated attachment data.');
  const textureFile = first.revision.files.find(file => file.role === 'texture').name;
  assert.notDeepEqual((await project.readArtifact({ ...second.ref, fileName: textureFile })).buffer, (await project.readArtifact({ ...first.ref, fileName: textureFile })).buffer, 'Dragging a mask vertex must change the cropped texture pixels.');
  assert.equal(digest((await project.readArtifact(sourceRef)).buffer), originalHash);
  passed('Rebuilding edited polygon and pivot changes generated JSON while original source hash stays exact', { candidate: second.ref, skeletonSha256: digest(second.bytes) });

  stage = 'reload draft';
  const savedRevision = (await draft()).revision.id;
  await deadline(cdp.call('Page.reload', { ignoreCache: true }), 15000, 'reload saved rig draft'); await panel('rig');
  await expression(`document.querySelector(${q(sel('fwv-rig-draft'))})?.value === ${q(draftId)}`);
  await choose('fwv-rig-part', 'head');
  assert.equal(Number(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-pivot-x'))}).value`)), 205);
  assert.equal((await draft()).revision.id, savedRevision);
  await expression(`document.querySelector(${q(sel('fwv-rig-preview-canvas'))})?.dataset.rendered === 'true'`);
  passed('Reload restores saved masks, joints, exact draft revision and generated candidate');

  stage = 'candidate routes and export';
  await click('fwv-rig-open-spine');
  await expression(`document.querySelector(${q(sel('fwv-spine-asset'))})?.value === ${q(second.asset.id)} && document.querySelector(${q(sel('fwv-spine-revision'))})?.value === ${q(second.revision.id)}`);
  await choose('fwv-spine-animation', 'wave'); await screenshot('05-spine-candidate', 'fwv-spine');
  await panel('rig'); await click('fwv-rig-export');
  const exported = await waitFor(async () => (await project.snapshot()).exports.find(item => item.assetId === second.asset.id && item.revisionId === second.revision.id), 'exact candidate exported');
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, exported.path, 'manifest.json')));
  for (const file of manifest.files) assert.equal(digest(await fs.readFile(path.join(projectRoot, exported.path, file.path))), file.sha256);
  assert.equal(manifest.validation.status, 'passed'); assert.equal(manifest.validation.humanAcceptance, 'not-reviewed');
  await click('fwv-rig-open-reskin');
  await expression(`document.querySelector(${q(sel('fwv-reskin-template'))})?.value === ${q(second.asset.id)}`);
  await fill('fwv-reskin-name', '新骨骼 · 换皮接入验收'); await fill('fwv-reskin-brief', '保持猫咪结构，仅建立后续换皮方案。');
  await click('fwv-reskin-create');
  const workflow = await waitFor(async () => (await project.snapshot()).assets.find(asset => asset.kind === 'reskin'), 'generated candidate accepted as a new reskin template');
  const workflowDocument = workflow.revisions.at(-1).metadata.reskin;
  assert.equal(workflowDocument.template.assetId, second.asset.id); assert.equal(workflowDocument.template.revisionId, second.revision.id); assert.equal(workflowDocument.parts.length, 6);
  assert.equal(report.modelRequests.length, 0);
  passed('Exact generated revision opens in Spine and reskin; its verified resource package exports with no model calls', { exported: path.join(projectRoot, exported.path), workflowId: workflow.id });

  stage = 'invalid FWE geometry recovery';
  await panel('rig');
  await expression(`document.querySelector(${q(sel('fwv-rig-draft'))})?.value === ${q(draftId)} && !document.querySelector(${q(sel('fwv-rig-part'))}).disabled`);
  await evaluate(cdp, `(() => {const ctx=window.fwe.context();ctx.pushHistory('验收：未完成的 JSON 参数');ctx.data.rigDrafts.find(item=>item.id===${q(draftId)}).data.document={};ctx.markDirty('未完成的 JSON 参数');})()`);
  await expression(`document.querySelector(${q(sel('fwv-rig-status'))})?.dataset.error === 'true' && document.querySelector(${q(sel('fwv-rig-status'))}).textContent.includes('原草稿已保留')`);
  assert.deepEqual(await evaluate(cdp, `window.fwe.context().data.rigDrafts.find(item=>item.id===${q(draftId)}).data.document`), {});
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-build'))}).disabled`), true);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-part'))}).options.length`), 6, 'The immutable saved asset remains viewable while an invalid parameter draft is preserved.');
  await evaluate(cdp, `document.querySelector('#undoButton').click()`);
  await expression(`document.querySelector(${q(sel('fwv-rig-status'))})?.dataset.error === 'false' && !document.querySelector(${q(sel('fwv-rig-part'))}).disabled`);
  assert.equal(await evaluate(cdp, `window.fwe.context().data.rigDrafts.find(item=>item.id===${q(draftId)}).data.document.parts.length`), 6);
  passed('A malformed unsaved FWE JSON geometry draft is preserved and shown as read-only saved geometry; native Undo restores the editable draft');

  stage = 'historical fork';
  const originalDraftId = draftId, sourceBeforeFork = (await draft()).asset;
  const historicalRevision = sourceBeforeFork.revisions[0], historicalDocument = historicalRevision.metadata.rig;
  await choose('fwv-rig-draft-revision', historicalRevision.id);
  await expression(`document.querySelector(${q(sel('fwv-rig-fork'))})?.getClientRects().length > 0 && !document.querySelector(${q(sel('fwv-rig-fork'))}).disabled`);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-draw'))}).disabled`), true);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-part-name'))}).disabled`), true);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-save'))}).hidden`), true);
  assert.equal(await evaluate(cdp, `document.querySelectorAll(${q(sel('fwv-rig-overlay')+' circle[data-vertex-index]')}).length`), 0, 'Historical geometry must not show draggable handles.');
  const historicalBeforePointer = await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-overlay'))}).outerHTML`);
  const historyPointer=await sourcePoint({x:142,y:48});
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',...historyPointer,button:'left',clickCount:1});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:historyPointer.x+20,y:historyPointer.y+20,buttons:1,button:'left'});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:historyPointer.x+20,y:historyPointer.y+20,button:'left',clickCount:1});
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-overlay'))}).outerHTML`), historicalBeforePointer, 'Historical handles must not edit saved or cached geometry.');
  await screenshot('08-historical-readonly');
  const beforeForkIds = new Set((await project.snapshot()).assets.map(item=>item.id));
  await click('fwv-rig-fork');
  const forked = await waitFor(async ()=>(await project.snapshot()).assets.find(item=>item.kind==='rig'&&!beforeForkIds.has(item.id)), 'historical copy created');
  draftId=forked.id;
  await expression(`document.querySelector(${q(sel('fwv-rig-draft'))})?.value === ${q(draftId)} && !document.querySelector(${q(sel('fwv-rig-part-name'))}).disabled`);
  const forkedDocument=(await draft()).document;
  assert.deepEqual(forkedDocument.forkedFrom,{assetId:originalDraftId,revisionId:historicalRevision.id});
  assert.deepEqual(forkedDocument.parts,historicalDocument.parts);
  assert.deepEqual((await project.readArtifact({assetId:draftId,revisionId:forked.selectedRevisionId,fileName:forkedDocument.source.referenceFile})).buffer,fixture.buffer);
  await fill('fwv-rig-part-name','副本中的独立部件'); const savedFork=await save();
  assert.ok(savedFork.document.parts.some(item=>item.name==='副本中的独立部件'));
  assert.deepEqual((await project.snapshot()).assets.find(item=>item.id===originalDraftId),sourceBeforeFork);
  passed('Historical version is read-only and its explicit continuation creates an editable independent copy with exact source pixels and provenance',{source:{assetId:originalDraftId,revisionId:historicalRevision.id},fork:{assetId:draftId,revisionId:savedFork.revision.id}});
  await choose('fwv-rig-draft',originalDraftId);draftId=originalDraftId;
  await choose('fwv-rig-draft-revision',sourceBeforeFork.selectedRevisionId);

  stage = 'concurrent draft recovery';
  const currentBeforeConflict=await draft();
  await fill('fwv-rig-part-name','保留的本页编辑');
  const externallySaved=await saveRigDraft(project,{assetId:draftId,revisionId:currentBeforeConflict.revision.id,parts:currentBeforeConflict.document.parts,motion:currentBeforeConflict.document.motion});
  await click('fwv-rig-save');
  await expression(`document.querySelector(${q(sel('fwv-rig-status'))})?.dataset.error === 'true' && !document.querySelector(${q(sel('fwv-rig-fork'))}).disabled`);
  assert.equal(await evaluate(cdp, `document.querySelector(${q(sel('fwv-rig-part-name'))}).value`),'保留的本页编辑');
  const beforeRecoveryIds=new Set((await project.snapshot()).assets.map(item=>item.id));
  await click('fwv-rig-fork');
  const recovered=await waitFor(async ()=>(await project.snapshot()).assets.find(item=>item.kind==='rig'&&!beforeRecoveryIds.has(item.id)), 'conflicted edits recovered into independent copy');
  const recoveredDocument=recovered.revisions[0].metadata.rig;
  assert.ok(recoveredDocument.parts.some(item=>item.name==='保留的本页编辑'));
  assert.deepEqual(recoveredDocument.forkedFrom,{assetId:originalDraftId,revisionId:currentBeforeConflict.revision.id});
  assert.equal((await draft()).revision.id,externallySaved.revision.id);
  await expression(`document.querySelector(${q(sel('fwv-rig-draft'))})?.value === ${q(recovered.id)} && document.querySelector('#saveButton').disabled`);
  assert.notEqual(await evaluate(cdp, `document.querySelector(${q(sel('fwv-status'))})?.dataset.error`), 'true', 'Successful recovery must clear the obsolete global conflict error.');
  passed('A concurrent save still returns 409; the preserved local edits can continue in an independent copy without changing the externally saved current version');
  await choose('fwv-rig-draft',originalDraftId);
  await click('fwv-rig-discard');
  await choose('fwv-rig-draft-revision',externallySaved.revision.id);
  await evaluate(cdp, `document.querySelector('#saveButton').click()`);await expression(`document.querySelector('#saveButton').disabled`);

  stage = 'narrow layout';
  await panel('rig');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false }); await pause(180);
  const overflow = await evaluate(cdp, `(() => {const node=document.querySelector(${q(sel('fwv-rig'))});return {page:document.documentElement.scrollWidth-innerWidth,panel:node.scrollWidth-node.clientWidth};})()`);
  assert.ok(overflow.page <= 2 && overflow.panel <= 2, JSON.stringify(overflow)); await collapseSections(); await screenshot('06-narrow-rig');
  const narrowFocus = await evaluate(cdp, `(() => {const stage=document.querySelector('[data-testid="fwv-rig-stage"]').getBoundingClientRect(),part=document.querySelector('[data-testid="fwv-rig-part"]').getBoundingClientRect(),primary=document.querySelector('[data-testid="fwv-rig-build"]').getBoundingClientRect();return {sideBySide:stage.right<=part.left,primaryInViewport:primary.top>=0&&primary.bottom<=innerHeight};})()`);
  assert.deepEqual(narrowFocus, {sideBySide:true,primaryInViewport:true});
  await screenshotPreview('07-narrow-preview');
  passed('Rig authoring and generated preview fit a 1000px viewport', {...overflow,...narrowFocus});
  assert.equal(digest((await project.readArtifact(sourceRef)).buffer), originalHash);
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.modelRequests, []); assert.deepEqual(report.dialogs, [], 'All intentionally reloaded editor drafts must have been saved through FWE.'); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failureStage = stage; report.error = error.stack || String(error); process.exitCode = 1;
  if (cdp) try { await deadline(screenshot('failure'), 5000, 'failure screenshot'); report.visibleStatus = await deadline(evaluate(cdp, `({rig:document.querySelector(${q(sel('fwv-rig-status'))})?.textContent,global:document.querySelector(${q(sel('fwv-status'))})?.textContent})`), 5000, 'failure status'); } catch {}
  console.error(`[FWV rig] FAILED at ${stage}: ${error.message}`);
} finally {
  if (cdp) cdp.close(); if (chrome) await stopProcess(chrome); if (editor) await editor.close();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2));
}
