import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FwvProject } from '../src/core/project.mjs';
import { importSpine } from '../src/spine/application.mjs';
import { createSpineFixture } from '../examples/spine-fixture/create.mjs';
import { startEditor } from '../src/editor/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), fwePath = fileURLToPath(new URL('../../fwe', import.meta.url));
const require = createRequire(import.meta.url);
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test/browser-smoke.js'));
const output = path.join(root, '.local/reports/spine-repair-browser'); await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project'), project = new FwvProject(projectRoot);
const report = { status: 'running', runRoot, projectRoot, checks: [], screenshots: [], browserErrors: [] };
let editor, chrome, cdp, stage = 'setup';
const q = JSON.stringify, sel = id => `[data-testid="${id}"]`;
const wait = expression => waitForExpression(cdp, expression, 20000);
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
  const image = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), target = path.join(runRoot, name + '.png');
  await fs.writeFile(target, Buffer.from(image.data, 'base64')); report.screenshots.push(target);
}
const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log(`[FWD Spine repair] ${name}`); };
async function waitDisk(fn, label) {
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
}
try {
  await project.init({ name: 'Spine 骨骼与权重修复验收' });
  const fixture = await createSpineFixture(), skeleton = JSON.parse(fixture.json);
  skeleton.bones = [{ name: 'root' }, { name: 'pelvis', parent: 'root', x: 10, length: 30 }, { name: 'body', parent: 'root', y: 48, length: 45 }, { name: 'tip', parent: 'body', y: 30, length: 20 }];
  skeleton.skins[0].attachments['body-slot'].body = { type: 'mesh', path: 'body', uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 2, 3, 0], hull: 4,
    vertices: [-40, -48, 40, -48, 40, 48, -40, 48].flatMap((number, index, coordinates) => index % 2 ? [] : [2, 1, number, coordinates[index + 1], .5, 2, number, coordinates[index + 1], .5]) };
  const bytes = Buffer.from(JSON.stringify(skeleton, null, 2) + '\n');
  const source = await importSpine(project, { name: '加权角色基线', files: fixture.files.map(file => file.name.endsWith('.json') ? { ...file, buffer: bytes } : file) });
  const linkedSkeleton = structuredClone(skeleton); linkedSkeleton.skins[0].attachments['body-slot'].copy = { type: 'linkedmesh', path: 'body', parent: 'body' };
  const linked = await importSpine(project, { name: '关联网格边界检查', files: fixture.files.map(file => file.name.endsWith('.json') ? { ...file, buffer: Buffer.from(JSON.stringify(linkedSkeleton)) } : file) });
  editor = await startEditor({ projectRoot, fwePath, port: 0 }); report.url = editor.url;
  const debugPort = await getFreePort(); chrome = startChrome(editor.url, debugPort); const target = await waitForTarget(debugPort, editor.url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Log.entryAdded', event => { if (event.entry?.level === 'error') report.browserErrors.push(event.entry.text); });
  for (const domain of ['Runtime', 'Page', 'DOM', 'Log']) await cdp.call(domain + '.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.reload', { ignoreCache: true });
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-source"]')?.dataset.rendered === 'true'`);
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-summary"]')?.textContent.includes('4 个骨骼')`);
  assert.equal(await value('fwv-spine-repair-animation'), '');
  const initial = await evaluate(cdp, `({toolsOpen:document.querySelector('[data-testid="fwv-spine-repair-tools"]').open,bones:document.querySelector('[data-testid="fwv-spine-repair-showBones"]').checked,mesh:document.querySelector('[data-testid="fwv-spine-repair-showMesh"]').checked,candidateVisible:document.querySelector('[data-testid="fwv-spine-repair-candidate"]').getClientRects().length})`);
  assert.deepEqual(initial, {toolsOpen:false,bones:false,mesh:false,candidateVisible:0});
  await screenshot('00-spine-one-prompt-1600');
  await fill('fwv-spine-repair-bone', 'body', 'change');
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-y"]')?.value === '48'`);
  const parents = await evaluate(cdp, `Array.from(document.querySelector('[data-testid="fwv-spine-repair-parent"]').options).map(item=>item.value)`);
  assert.deepEqual(parents, ['root', 'pelvis']);
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-weights"]')?.textContent.includes('pelvis: 0.5')`);
  assert.match(await evaluate(cdp, `document.querySelector('[data-testid="fwv-spine-repair-mesh-summary"]').textContent`), /加权网格.*可编辑：是/);
  record('Before creating a request, the actual Spine setup pose, allowed parents, mesh and per-vertex weights are visible');

  stage = 'anchor and draft';
  await fill('fwv-spine-repair-animation', 'idle', 'change'); await fill('fwv-spine-repair-time', .6);
  await click(sel('fwv-spine-repair-anchor'));
  await fill('fwv-assets-request', '将身体移到正确位置并跟随髋部，修正顶点 0 对身体的权重');
  await fill('fwv-assets-preserve', '保留其他顶点、动画时间线、图集和贴图');
  await click(sel('fwv-assets-create'));
  let change = await waitDisk(async () => (await project.snapshot()).changes?.[0], 'change');
  assert.deepEqual(change.anchors.objects, ['body']); assert.deepEqual(change.anchors.animation, { name: 'idle', time: .6 });
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-y"]').value === '48'`);
  await fill('fwv-spine-repair-parent', 'pelvis', 'change'); await fill('fwv-spine-repair-x', 8); await fill('fwv-spine-repair-y', 53);
  await fill('fwv-spine-repair-influence', 'body', 'change'); await fill('fwv-spine-repair-weight', .75);
  await click('#undoButton'); await wait(`document.querySelector('[data-testid="fwv-spine-repair-weight"]')?.value === '0.5'`);
  await click('#redoButton'); await wait(`document.querySelector('[data-testid="fwv-spine-repair-weight"]')?.value === '0.75'`);
  await click('#saveButton'); await wait('window.fwe.resources.current().dirty === false');
  const draft = JSON.parse(await fs.readFile(path.join(projectRoot, '.fwv/editor-drafts.json'), 'utf8')).changeDrafts[0].data.spineRepair;
  assert.equal(draft.boneName, 'body'); assert.equal(draft.parent, 'pelvis'); assert.equal(draft.x, 8); assert.equal(draft.weight, .75);
  assert.equal(change.candidates.length, 0);
  record('Bone, animation and time anchors belong to the fixed request; repair parameters use FWE save, Undo and Redo');

  stage = 'repair candidate';
  await click(sel('fwv-spine-repair-create'));
  change = await waitDisk(async () => { const next = (await project.snapshot()).changes?.[0]; return next?.candidates.length ? next : null; }, 'repair candidate');
  const candidate = change.candidates[0], json = JSON.parse((await project.readArtifact({ assetId: candidate.assetId, revisionId: candidate.revisionId, fileName: 'fixture.json' })).buffer);
  assert.equal(candidate.review.decision, 'pending'); assert.equal(candidate.validation.status, 'passed');
  const body = json.bones.find(item => item.name === 'body'); assert.equal(body.parent, 'pelvis'); assert.equal(body.x, 8); assert.equal(body.y, 53);
  const vertices = json.skins[0].attachments['body-slot'].body.vertices;
  assert.equal(vertices[4], .25); assert.equal(vertices[8], .75);
  for (let index = 0; index < vertices.length; index++) if (![4, 8].includes(index)) assert.equal(vertices[index], skeleton.skins[0].attachments['body-slot'].body.vertices[index]);
  assert.deepEqual(json.animations, skeleton.animations);
  assert.deepEqual((await project.readArtifact({ assetId: source.id, revisionId: source.selectedRevisionId, fileName: 'fixture.json' })).buffer, bytes);
  for (const fileName of ['fixture.atlas', 'fixture.png']) assert.deepEqual((await project.readArtifact({ assetId: candidate.assetId, revisionId: candidate.revisionId, fileName })).buffer, fixture.files.find(file => file.name === fileName).buffer);
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-candidate"]')?.dataset.rendered === 'true'`);
  await fill('fwv-spine-repair-animation', '', 'change'); await fill('fwv-spine-repair-time', 0);
  const comparison = await evaluate(cdp, `(() => {const a=document.querySelector('[data-testid="fwv-spine-repair-source"]'),b=document.querySelector('[data-testid="fwv-spine-repair-candidate"]');return {sourceFrame:a.dataset.frame,candidateFrame:b.dataset.frame,sourceTime:a.dataset.time,candidateTime:b.dataset.time,pixelsDiffer:a.toDataURL()!==b.toDataURL()};})()`);
  assert.equal(comparison.sourceFrame, comparison.candidateFrame); assert.equal(comparison.sourceTime, '0.000'); assert.equal(comparison.candidateTime, '0.000'); assert.equal(comparison.pixelsDiffer, true);
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-candidate-edits"]').textContent.includes('0.75')`);
  await evaluate(cdp, `document.querySelector('[data-testid="fwv-spine-repair-tools"]').open=false`);
  await screenshot('01-setup-candidate-1600');
  record('The real repair changes one bone and one vertex, keeps source/animation/texture bytes, and renders a different setup pose with the exact same camera', comparison);

  stage = 'animation and adoption';
  await fill('fwv-spine-repair-animation', 'idle', 'change'); await fill('fwv-spine-repair-time', .6);
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-source"]').dataset.time === '0.600' && document.querySelector('[data-testid="fwv-spine-repair-candidate"]').dataset.time === '0.600'`);
  await fill('fwv-assets-review-comment', '初始姿势和 idle 0.6 秒对照通过'); await click(sel('fwv-assets-use'));
  const adopted = await waitDisk(async () => { const next = (await project.snapshot()).changes[0]; return next.adoption ? next : null; }, 'adoption');
  assert.deepEqual(JSON.parse((await project.readArtifact({ ...adopted.adoption, fileName: 'fixture.json' })).buffer), json);
  record('Both sides use the selected animation time, and the standard accepted-candidate adoption publishes the repaired skeleton');

  stage = 'unsupported binding scope';
  await fill('fwv-assets-source', linked.id, 'change');
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-mesh-summary"]').textContent.includes('关联网格')`);
  assert.equal(await evaluate(cdp, `document.querySelector('[data-testid="fwv-spine-repair-weight"]').disabled`), true);
  assert.equal(await evaluate(cdp, `document.querySelector('[data-testid="fwv-spine-repair-vertex"]').disabled`), true);
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-preview-status"]').textContent === ''`);
  assert.equal(await evaluate(cdp, `document.querySelector('[data-testid="fwv-spine-repair-candidate"]').getClientRects().length`), 0);
  record('Shared linked-mesh weights are visibly read-only, and switching to a source without candidates hides the previous candidate canvas');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1100, deviceScaleFactor: 1, mobile: false }); await screenshot('02-spine-1000');
  const overflow = await evaluate(cdp, `({page:document.documentElement.scrollWidth-innerWidth,panel:document.querySelector('[data-testid="fwv-assets"]').scrollWidth-document.querySelector('[data-testid="fwv-assets"]').clientWidth})`);
  assert.ok(overflow.page <= 2 && overflow.panel <= 2, JSON.stringify(overflow)); assert.deepEqual(report.browserErrors, []); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failureStage = stage; report.error = error.stack || String(error); process.exitCode = 1;
  if (cdp) try { report.visibleStatus = await evaluate(cdp, `document.querySelector('[data-testid="fwv-status"]')?.textContent`); await screenshot('failure'); } catch {}
  console.error(`[FWD Spine repair] FAILED at ${stage}: ${error.message}`);
} finally {
  if (cdp) cdp.close(); if (chrome) await stopProcess(chrome); if (editor) await editor.close();
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') }, null, 2));
}
