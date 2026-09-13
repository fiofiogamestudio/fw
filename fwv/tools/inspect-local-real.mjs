import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { extractSpinePart } from '../src/spine/application.mjs';

// Read-only evidence for a completed real generation. No model calls or project commands.
const require = createRequire(import.meta.url), fwvRoot = fileURLToPath(new URL('../', import.meta.url));
const argumentsMap = {};
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (!['--project', '--workflow', '--attempt', '--output'].includes(key) || !process.argv[index + 1]) throw new Error('Usage: node tools/inspect-local-real.mjs --project <path> [--workflow <id>] [--attempt <id>] [--output <directory>]');
  if (Object.hasOwn(argumentsMap, key)) throw new Error(`Duplicate option: ${key}`);
  argumentsMap[key] = process.argv[++index];
}
if (!argumentsMap['--project']) throw new Error('Explicit --project is required. The existing project will only be read.');
const projectRoot = await fs.realpath(path.resolve(argumentsMap['--project']));
const workflowId = argumentsMap['--workflow'] || 'asset_4efd212133b84bf78f783e252b87d363';
const attemptId = argumentsMap['--attempt'] || 'attempt_44d8e37e9b1940dbae21da37d1a5a287';
const output = path.resolve(argumentsMap['--output'] || path.join(fwvRoot, '.local', 'reports', 'local-real', 'runtime'));
const relation = path.relative(projectRoot, output);
if (!relation || !relation.startsWith('..' + path.sep) && relation !== '..' && !path.isAbsolute(relation)) throw new Error('Evidence directory must be outside the inspected project.');
await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-'));
const fwePath = await fs.realpath(process.env.FWV_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url)));
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test', 'browser-smoke.js'));
const project = new FwvProject(projectRoot), digest = bytes => createHash('sha256').update(bytes).digest('hex');
const q = JSON.stringify, selector = name => `[data-testid="fwv-reskin-${name}"]`;
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', scope: 'read-only-runtime-evidence',
  projectRoot, workflowId, attemptId, runRoot, visualAcceptance: 'not-reviewed', visualQualityAutomaticallyAccepted: false,
  checks: [], animations: [], parts: [], sheets: [], screenshots: [], browserErrors: [], blockedRequests: [], artifactRequests: [], instrumentationErrors: [] };
let editor, chrome, cdp, projectBefore, stage = 'preflight';
const requests = new Map();
async function fingerprint() {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Read-only project fingerprint does not follow symlinks.');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push({ path: path.relative(projectRoot, file).replaceAll('\\', '/'), sha256: digest(await fs.readFile(file)) });
    }
  }
  await walk(projectRoot); files.sort((a, b) => a.path.localeCompare(b.path));
  return { files: files.length, treeSha256: digest(Buffer.from(JSON.stringify(files))) };
}
const expression = value => waitForExpression(cdp, value, 25000);
async function choose(name, value) {
  await expression(`document.querySelector(${q(selector(name))}) && !document.querySelector(${q(selector(name))}).disabled`);
  await evaluate(cdp, `(() => {const node=document.querySelector(${q(selector(name))});node.value=${q(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function screenshot(name) {
  await evaluate(cdp, `(() => {let node=document.querySelector('[data-testid="fwv-workbench"]');while(node){node.scrollTop=0;node.scrollLeft=0;node=node.parentElement;}window.scrollTo(0,0);})()`);
  const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(runRoot, name + '.png'); await fs.writeFile(target, Buffer.from(result.data, 'base64')); report.screenshots.push(target); return target;
}
async function framePair(animation, number) {
  const values = await evaluate(cdp, `['original','candidate'].map(side=>{const canvas=document.querySelector('[data-testid="fwv-reskin-'+side+'-canvas"]');return {side,time:Number(canvas.dataset.time),rendered:canvas.dataset.rendered,png:canvas.toDataURL('image/png').split(',')[1]};})`);
  assert.equal(values[0].time, values[1].time, 'Original and candidate must use the same animation clock.');
  const result = [];
  for (const value of values) {
    assert.equal(value.rendered, 'true');
    const buffer = Buffer.from(value.png, 'base64'), { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visiblePixels = 0; for (let offset = 3; offset < data.length; offset += 4) if (data[offset] > 20) visiblePixels++;
    assert.ok(visiblePixels > 100, `${value.side} ${animation} has too few visible pixels.`);
    const file = path.join(runRoot, `${animation}-${number}-${value.side}.png`); await fs.writeFile(file, buffer); report.screenshots.push(file);
    result.push({ side: value.side, time: value.time, width: info.width, height: info.height, visiblePixels, sha256: digest(buffer), screenshot: file });
  }
  return result;
}
function passed(name, details = {}) { report.checks.push({ name, status: 'passed', ...details }); console.log(`[FWV real runtime] ${name}`); }

try {
  projectBefore = await fingerprint(); report.projectBefore = projectBefore;
  const snapshot = await project.snapshot(), workflow = snapshot.assets.find(asset => asset.id === workflowId && asset.kind === 'reskin');
  assert.ok(workflow, 'Requested workflow does not exist.');
  const document = workflow.revisions.find(revision => revision.id === workflow.selectedRevisionId)?.metadata.reskin;
  const attempt = document?.attempts.find(attempt => attempt.id === attemptId);
  assert.equal(attempt?.mode, 'local'); assert.equal(attempt.status, 'succeeded', 'Wait for the real candidate to complete before running this inspection.');
  const candidate = snapshot.assets.find(asset => asset.id === attempt.candidateAssetId && asset.kind === 'spine');
  const candidateRevision = candidate?.revisions.find(revision => revision.id === attempt.candidateRevisionId);
  assert.ok(candidateRevision); report.template = { assetId: document.template.assetId, revisionId: document.template.revisionId };
  report.candidate = { assetId: candidate.id, revisionId: candidateRevision.id };
  const actualAnimations = candidateRevision.metadata.spine?.animations || [];
  for (const animation of ['idle', 'walk', 'wave']) assert.ok(actualAnimations.includes(animation), `Candidate does not contain ${animation}.`);
  passed('Exact completed local attempt resolves to a registered Spine candidate', { candidate: report.candidate });
  for (const [index, region] of candidateRevision.metadata.spine.regions.entries()) {
    const entry = { regionName: region.name, visualAcceptance: 'not-reviewed' };
    for (const [side, reference] of [['original', report.template], ['candidate', report.candidate]]) {
      const buffer = await extractSpinePart(project, { ...reference, regionName: region.name });
      const target = path.join(runRoot, `part-${index + 1}-${side}.png`); await fs.writeFile(target, buffer);
      entry[side] = { screenshot: target, sha256: digest(buffer) }; report.screenshots.push(target);
    }
    report.parts.push(entry);
  }
  for (const [label, reference] of [['reference-guide', attempt.guide], ['generated-sheet', { assetId: attempt.sheetAssetId, revisionId: attempt.sheetRevisionId }]]) {
    const asset = snapshot.assets.find(item => item.id === reference?.assetId), revision = asset?.revisions.find(item => item.id === reference?.revisionId);
    const file = reference?.fileName || revision?.files.find(file => ['image', 'source'].includes(file.role))?.name;
    if (!file) continue; const artifact = await project.readArtifact({ assetId: asset.id, revisionId: revision.id, fileName: file });
    const target = path.join(runRoot, `${label}${path.extname(file)}`); await fs.writeFile(target, artifact.buffer);
    report.sheets.push({ label, file: target, assetId: asset.id, revisionId: revision.id, sha256: digest(artifact.buffer) }); report.screenshots.push(target);
  }
  passed('Original/candidate parts and exact reference/output sheets retained for manual edge inspection', { parts: report.parts.length });

  editor = await startEditor({ projectRoot, fwePath, port: 0 }); report.inspectionUrl = editor.url;
  assert.notEqual(Number(new URL(editor.url).port), 3230, 'Inspection must use its own ephemeral port.');
  const debugPort = await getFreePort(); chrome = startChrome('about:blank', debugPort); const target = await waitForTarget(debugPort, 'about:blank', 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Log.entryAdded', event => { if (event.entry?.level === 'error') report.browserErrors.push(`${event.entry.text} @ ${event.entry.url || ''}`); });
  cdp.on('Fetch.requestPaused', event => {
    const request = event.request, local = request.url.startsWith(editor.url + '/') || request.url.startsWith('data:') || request.url.startsWith('blob:');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) || !local) {
      report.blockedRequests.push({ method: request.method, url: request.url });
      void cdp.call('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(error => report.instrumentationErrors.push(error.message));
    } else void cdp.call('Fetch.continueRequest', { requestId: event.requestId }).catch(error => report.instrumentationErrors.push(error.message));
  });
  cdp.on('Network.requestWillBeSent', event => {
    const url = new URL(event.request.url);
    if (url.origin === editor.url && url.pathname === '/api/fwv/artifact') {
      const artifact = Object.fromEntries(url.searchParams); requests.set(JSON.stringify(artifact), artifact);
    }
  });
  for (const domain of ['Runtime', 'Log', 'Page', 'DOM', 'Network']) await cdp.call(domain + '.enable');
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1160, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.navigate', { url: editor.url });
  stage = 'select exact attempt';
  await expression(`document.querySelector(${q(selector('workflows'))}) && !document.querySelector(${q(selector('workflows'))}).disabled`);
  await choose('workflows', workflowId);
  await expression(`[...document.querySelectorAll(${q(selector('attempt'))})].some(node=>node.dataset.attemptId===${q(attemptId)})`);
  await evaluate(cdp, `document.querySelector(${q(selector('history'))}).querySelector(':scope > summary').click()`);
  await evaluate(cdp, `[...document.querySelectorAll(${q(selector('attempt'))})].find(node=>node.dataset.attemptId===${q(attemptId)}).click()`);
  await expression(`document.querySelector(${q(selector('original-canvas'))})?.dataset.rendered==='true' && document.querySelector(${q(selector('candidate-canvas'))})?.dataset.rendered==='true'`);
  await expression(`document.querySelector(${q(selector('attempt-status'))})?.textContent==='候选已组装'`);
  await evaluate(cdp, `document.querySelector(${q(selector('history'))}).querySelector(':scope > summary').click()`);
  const playbackText = (await fetch(editor.url + '/api/fwv/ui').then(response => response.json())).preview.texts;
  for (const animation of ['idle', 'walk', 'wave']) {
    stage = `capture ${animation}`;
    await choose('preview-animation', animation);
    await evaluate(cdp, `(() => {const node=document.querySelector(${q(selector('preview-play'))});if(node.textContent===${q(playbackText.play)})node.click();})()`);
    await expression(`Number(document.querySelector(${q(selector('candidate-canvas'))}).dataset.time)>=0.12`);
    const first = await framePair(animation, 1);
    await expression(`Number(document.querySelector(${q(selector('candidate-canvas'))}).dataset.time)>=${first[1].time + .28}`);
    const second = await framePair(animation, 2);
    for (let side = 0; side < 2; side++) assert.notEqual(first[side].sha256, second[side].sha256, `${first[side].side} ${animation} canvas did not animate.`);
    assert.notEqual(first[0].sha256, first[1].sha256, 'Original and generated candidate canvases should show different pixels.');
    await evaluate(cdp, `(() => {const node=document.querySelector(${q(selector('preview-play'))});if(node.textContent===${q(playbackText.pause)})node.click();})()`);
    const workspace = await screenshot(`${animation}-workspace`);
    report.animations.push({ animation, frames: [first, second], workspaceScreenshot: workspace, synchronized: true, movingPixelsObserved: true, visualAcceptance: 'not-reviewed' });
    passed(`Actual ${animation} preview has synchronized time and changing original/candidate pixels`);
  }
  stage = 'focused desktop and narrow layout';
  for (const width of [1280, 1000]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await screenshot(`focused-${width}`);
    const layout = await evaluate(cdp, `(() => {
      const root=document.querySelector('[data-testid="fwv-reskin"]');
      const visible=node=>!!node.getClientRects().length&&!node.closest('details:not([open])');
      const fields=[...root.querySelectorAll('input,textarea,select')].filter(visible).map(node=>node.dataset.testid);
      const button=root.querySelector('[data-testid="fwv-reskin-generate"]').getBoundingClientRect();
      const canvases=['original','candidate'].map(side=>{const box=root.querySelector('[data-testid="fwv-reskin-'+side+'-canvas"]').getBoundingClientRect();return {width:box.width,height:box.height,top:box.top,bottom:box.bottom};});
      return {fields,button:{top:button.top,bottom:button.bottom},canvases,overflow:Math.max(document.documentElement.scrollWidth-innerWidth,root.scrollWidth-root.clientWidth)};
    })()`);
    assert.deepEqual(layout.fields.sort(), ['fwv-reskin-workflows','fwv-reskin-preview-animation','fwv-reskin-brief','fwv-reskin-mode'].sort());
    assert.ok(layout.button.top >= 0 && layout.button.bottom <= 900, 'Main reskin action must remain in the first viewport.');
    assert.ok(layout.canvases.every(box=>box.width>120&&box.height>=250&&box.bottom<=900), 'Both actual character previews must remain usable and visible.');
    assert.ok(layout.overflow<=2, JSON.stringify(layout));
    passed(`${width}px first screen keeps character comparison and main action visible with four essential controls`, layout);
  }
  report.artifactRequests = [...requests.values()];
  for (const identity of [report.template, report.candidate]) assert.ok(report.artifactRequests.some(item => item.assetId === identity.assetId && item.revisionId === identity.revisionId), 'Preview did not request exact registered resource revision.');
  assert.equal(report.blockedRequests.length, 0, 'Inspection attempted a write or external request.');
  assert.equal(report.browserErrors.length, 0, report.browserErrors.join('\n'));
  assert.equal(report.instrumentationErrors.length, 0, report.instrumentationErrors.join('\n'));
  passed('Browser requested exact resource revisions with no mutation or external network requests');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failureStage = stage; report.error = error.stack || String(error); process.exitCode = 1;
  if (cdp) try { await screenshot('failure'); report.previewStatus = await evaluate(cdp, `document.querySelector(${q(selector('preview-status'))})?.textContent`); } catch {}
  console.error(`[FWV real runtime] FAILED at ${stage}: ${error.message}`);
} finally {
  if (cdp) { await cdp.call('Fetch.disable').catch(() => {}); cdp.close(); } if (chrome) await stopProcess(chrome); if (editor) await editor.close();
  if (projectBefore) try { report.projectAfter = await fingerprint(); assert.deepEqual(report.projectAfter, projectBefore); passed('Every project file remains unchanged during runtime inspection', report.projectAfter); }
  catch (error) { report.status = 'failed'; report.immutabilityError = error.message; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json'), visualAcceptance: report.visualAcceptance }, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json'), visualAcceptance: report.visualAcceptance }, null, 2));
}
