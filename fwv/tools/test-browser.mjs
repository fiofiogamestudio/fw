import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { createSpineFixture } from '../examples/spine-fixture/create.mjs';

// This is a repeatable repository acceptance test, using FWE's existing isolated
// Chrome/CDP harness. It never attaches to the user's browser or personal profile.
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
let outputArgument;
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--output' || !args[i + 1]) throw new Error('Usage: node tools/test-browser.mjs [--output directory]');
  outputArgument = args[++i];
}
const fwvRoot = fileURLToPath(new URL('../', import.meta.url));
const selectedFwe = process.env.FWV_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url));
if (!path.isAbsolute(selectedFwe)) throw new Error('FWV_FWE_PATH must select an absolute FWE checkout path.');
const fwePath = await fs.realpath(selectedFwe);
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } =
  require(path.join(fwePath, 'test', 'browser-smoke.js'));
const outputRoot = path.resolve(outputArgument || path.join(fwvRoot, '.local', 'reports', 'browser'));
await fs.mkdir(outputRoot, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(outputRoot, 'run-'));
const projectRoot = path.join(runRoot, 'project'), sourceRoot = path.join(runRoot, 'source');
const project = new FwvProject(projectRoot);
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
  fwePath, runRoot, projectRoot, sourceRoot, checks: [], screenshots: [], browserErrors: [], consoleWarnings: [] };
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const selector = id => `[data-testid="${id}"]`;
const quote = value => JSON.stringify(value);
const spineJsonFile = 'character.JSON', spineAtlasFile = 'character.ATLAS';
let editor, chrome, cdp, stage = 'setup';
function passed(name, details = {}) { report.checks.push({ name, status: 'passed', ...details }); console.log(`[FWV browser] ${name}`); }
async function waitDisk(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await project.snapshot();
    if (predicate(current)) return current;
    await pause(80);
  }
  throw new Error(`Timed out waiting for disk state: ${label}`);
}
async function expression(text, timeoutMs = 15000) { return waitForExpression(cdp, text, timeoutMs); }
async function ready() {
  await expression(`document.querySelector(${quote(selector('fwv-workbench'))}) && !document.querySelector(${quote(selector('fwv-import'))})?.disabled`);
  await expression(`document.querySelector('button[data-workspace-id="fwv-tools"]') && !document.querySelector('button[data-workspace-id="fwv-tools"]').disabled`);
  await evaluate(cdp, `(() => {const tab=document.querySelector('button[data-workspace-id="fwv-tools"]');if(tab.getAttribute('aria-selected')!=='true')tab.click();})()`);
  await expression(`document.querySelector('button[data-section-id="images"]') && !document.querySelector('button[data-section-id="images"]').disabled`);
}
async function reload() {
  const previousDocument = await evaluate(cdp, 'performance.timeOrigin');
  await cdp.call('Page.reload', { ignoreCache: true });
  await expression(`performance.timeOrigin !== ${quote(previousDocument)}`);
  await ready();
  await expression(`document.querySelector('button[data-section-id="images"]') && !document.querySelector('button[data-section-id="images"]').disabled`);
}
async function reveal(id) {
  await evaluate(cdp, `(() => {const node=document.querySelector(${quote(selector(id))});const ancestors=[];for(let item=node?.parentElement;item;item=item.parentElement)if(item.tagName==='DETAILS')ancestors.unshift(item);for(const item of ancestors)if(!item.open)item.querySelector(':scope > summary').click();node?.scrollIntoView({block:'nearest'});})()`);
}
async function click(id) {
  await expression(`document.querySelector(${quote(selector(id))}) && !document.querySelector(${quote(selector(id))}).disabled`);
  await reveal(id);
  await evaluate(cdp, `(() => { const node = document.querySelector(${quote(selector(id))}); node.scrollIntoView({block:'center'}); node.click(); })()`);
}
async function selectValue(id, value) {
  await expression(`document.querySelector(${quote(selector(id))}) && !document.querySelector(${quote(selector(id))}).disabled`);
  await reveal(id);
  await evaluate(cdp, `(() => { const node = document.querySelector(${quote(selector(id))}); node.value = ${quote(value)}; node.dispatchEvent(new Event('change',{bubbles:true})); })()`);
}
async function upload(id, files) {
  await reveal(id);
  const tree = await cdp.call('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: tree.root.nodeId, selector: selector(id) });
  assert.ok(nodeId, `File input missing: ${id}`);
  await cdp.call('DOM.setFileInputFiles', { nodeId, files: files.map(file => path.resolve(file)) });
}
async function screenshot(name) {
  const data = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(runRoot, name + '.png'); await fs.writeFile(target, Buffer.from(data.data, 'base64')); report.screenshots.push(target);
}
async function screenshotTop(name) {
  await evaluate(cdp, `(() => { let node=document.querySelector(${quote(selector('fwv-workbench'))}); while(node){node.scrollTop=0;node.scrollLeft=0;node=node.parentElement;} window.scrollTo(0,0); })()`);
  await pause(80); await screenshot(name);
}
async function canvasImage(id, name) {
  await expression(`document.querySelector(${quote(selector(id))})?.dataset.rendered === 'true'`);
  const data = await evaluate(cdp, `document.querySelector(${quote(selector(id))}).toDataURL('image/png').split(',')[1]`);
  const buffer = Buffer.from(data, 'base64'); await fs.writeFile(path.join(runRoot, name + '.png'), buffer);
  const raw = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let visible = 0, orange = 0, purple = 0;
  for (let i = 0; i < raw.data.length; i += raw.info.channels) {
    const [r, g, b, a] = raw.data.subarray(i, i + 4);
    if (a > 30) { visible++; if (r > 180 && g > 85 && g < 205 && b < 115) orange++; if (b > 120 && r < 165 && b > r + 25) purple++; }
  }
  return { sha256: digest(buffer), width: raw.info.width, height: raw.info.height, visible, orange, purple };
}
async function scrub(value) {
  await evaluate(cdp, `(() => { const node = document.querySelector(${quote(selector('fwv-spine-seek'))}); node.value = ${quote(String(value))}; node.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await expression(`Math.abs(Number(document.querySelector(${quote(selector('fwv-spine-current'))})?.dataset.time) - ${value}) < 0.015`);
  await pause(60);
}
async function enterSpine() {
  await expression(`document.querySelector('button[data-section-id="spine"]') && !document.querySelector('button[data-section-id="spine"]').disabled`);
  await evaluate(cdp, `document.querySelector('button[data-section-id="spine"]').click()`);
  await expression(`document.querySelector(${quote(selector('fwv-spine'))}) && document.querySelector(${quote(selector('fwv-spine-asset'))})?.options.length`);
}
async function overflowCheck(name) {
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
  await pause(150);
  const overflow = await evaluate(cdp, `(() => {
    const root = document.querySelector(${quote(selector('fwv-workbench'))});
    return { page: Math.max(0,document.documentElement.scrollWidth-innerWidth), workspace: Math.max(0,root.scrollWidth-root.clientWidth),
      controls:[...root.querySelectorAll('button,input,select')].filter(node=>node.getClientRects().length && node.getBoundingClientRect().width)
        .filter(node=> { const r=node.getBoundingClientRect(),p=node.parentElement.getBoundingClientRect(); return r.right>p.right+3 || r.left<p.left-3; })
        .map(node=>({testId:node.dataset.testid||'',tag:node.tagName,width:node.clientWidth,parentWidth:node.parentElement.clientWidth})) };
  })()`);
  await screenshot(name + '-1000');
  assert.ok(overflow.page <= 2 && overflow.workspace <= 2 && overflow.controls.length === 0, `Narrow viewport overflow: ${JSON.stringify(overflow)}`);
  passed(name + ' 1000 px layout', overflow);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
}

try {
  if (typeof WebSocket !== 'function') throw new Error('Browser acceptance requires Node.js 22 or newer.');
  await project.init({ name: 'FWV · 浏览器验收项目' });
  const fixture = await createSpineFixture(sourceRoot);
  // Exercise format dispatch by declared roles, not case-sensitive suffixes, and
  // initialization of a valid named skin when there is no skin called default.
  const skeletonData = JSON.parse(fixture.json); skeletonData.skins[0].name = 'painted';
  fixture.json = Buffer.from(JSON.stringify(skeletonData, null, 2) + '\n');
  fixture.atlas = Buffer.from(fixture.atlas.toString() + 'other\nbounds:0,0,8,8\n');
  fixture.files = [{ name: spineJsonFile, buffer: fixture.json }, { name: spineAtlasFile, buffer: fixture.atlas },
    { name: 'fixture.png', buffer: fixture.pages.get('fixture.png') }];
  for (const file of fixture.files) await fs.writeFile(path.join(sourceRoot, file.name), file.buffer);
  const icon = await sharp(fixture.replacement).extend({ top: 22, bottom: 22, left: 20, right: 20, background: '#00000000' }).png().toBuffer();
  const iconFile = path.join(sourceRoot, 'icon.png'); await fs.writeFile(iconFile, icon);
  editor = await startEditor({ projectRoot, fwePath, port: 0 }); report.url = editor.url;
  const debugPort = await getFreePort(); chrome = startChrome(editor.url, debugPort);
  const target = await waitForTarget(debugPort, editor.url, 15000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Runtime exception'));
  cdp.on('Log.entryAdded', event => {
    const entry = event.entry;
    if (entry?.level === 'error') report.browserErrors.push(`${entry.text}${entry.url ? ' @ ' + entry.url : ''}`);
    if (entry?.level === 'warning') report.consoleWarnings.push(entry.text);
  });
  await cdp.call('Runtime.enable'); await cdp.call('Log.enable'); await cdp.call('Page.enable'); await cdp.call('DOM.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  // Reload after instrumentation so startup exceptions are captured as evidence.
  await reload();
  await evaluate(cdp, `document.querySelector('button[data-section-id="images"]').click()`); await screenshot('01-empty');

  stage = 'image import';
  await upload('fwv-import-input', [iconFile]);
  let snapshot = await waitDisk(data => data.assets.some(asset => asset.kind === 'image'), 'image import');
  let imageAsset = snapshot.assets.find(asset => asset.kind === 'image'); const originalId = imageAsset.selectedRevisionId;
  await expression(`document.querySelector(${quote(selector('fwv-current-preview'))})?.naturalWidth === 120`);
  assert.equal(digest((await project.readArtifact({ assetId: imageAsset.id, revisionId: originalId, fileName: 'icon.png' })).buffer), digest(icon));
  passed('Image imported through file input', { assetId: imageAsset.id, originalId, originalSha256: digest(icon) });
  const imageLayout = await evaluate(cdp, `(() => {const root=document.querySelector(${quote(selector('fwv-workbench'))});return {fields:[...root.querySelectorAll('input,textarea,select')].filter(node=>node.checkVisibility()).map(node=>node.dataset.testid),primary:document.querySelector(${quote(selector('fwv-process'))}).checkVisibility(),advanced:document.querySelector(${quote(selector('fwv-image-background-options'))}).open,library:document.querySelector(${quote(selector('fwv-image-library'))}).open,versions:document.querySelector(${quote(selector('fwv-image-versions'))}).open};})()`);
  assert.deepEqual(imageLayout.fields.sort(),['fwv-fit','fwv-height','fwv-padding','fwv-trim','fwv-width']); assert.equal(imageLayout.primary,true); assert.equal(imageLayout.advanced,false); assert.equal(imageLayout.library,false); assert.equal(imageLayout.versions,false);
  await screenshotTop('01-focused-image'); passed('Image first screen keeps one preview and essential size controls; history and background tools remain discoverable',imageLayout);

  stage = 'image processing';
  await click('fwv-color-key');
  assert.equal(await evaluate(cdp, `document.querySelector(${quote(selector('fwv-key-color'))}).checkVisibility() && document.querySelector(${quote(selector('fwv-tolerance'))}).checkVisibility()`),true);
  await click('fwv-color-key');
  await evaluate(cdp, `document.querySelector(${quote(selector('fwv-image-background-options'))}).querySelector(':scope > summary').click()`);
  await evaluate(cdp, `(() => {
    for (const [id,value] of [['fwv-width',96],['fwv-height',96],['fwv-padding',12]]) document.querySelector('[data-testid="'+id+'"]').value=String(value);
    document.querySelector(${quote(selector('fwv-trim'))}).checked=true;
  })()`);
  await click('fwv-process');
  snapshot = await waitDisk(data => data.assets.find(asset => asset.id === imageAsset.id)?.revisions.length === 2, 'image processing');
  imageAsset = snapshot.assets.find(asset => asset.id === imageAsset.id); const imageRevision = imageAsset.selectedRevisionId;
  await expression(`document.querySelector(${quote(selector('fwv-current-preview'))})?.naturalWidth === 96 && document.querySelector(${quote(selector('fwv-current-preview'))})?.naturalHeight === 96`);
  const processedBuffer = (await project.readArtifact({ assetId: imageAsset.id, revisionId: imageRevision, fileName: 'image.png' })).buffer;
  const processedMeta = await sharp(processedBuffer).metadata(); assert.equal(processedMeta.width, 96); assert.equal(processedMeta.height, 96);
  assert.equal(imageAsset.revisions[1].recipe.padding, 12); assert.equal(imageAsset.revisions[1].recipe.trim, true);
  assert.equal(digest((await project.readArtifact({ assetId: imageAsset.id, revisionId: originalId, fileName: 'icon.png' })).buffer), digest(icon));
  passed('Image processed through form; original hash preserved', { revisionId: imageRevision, width: 96, height: 96, padding: 12, sha256: digest(processedBuffer) });
  stage = 'image validation';
  await click('fwv-validate');
  snapshot = await waitDisk(data => data.assets.find(asset => asset.id === imageAsset.id)?.revisions.at(-1).validation?.status === 'passed', 'image validation');
  assert.equal(snapshot.assets.find(asset => asset.id === imageAsset.id).revisions.at(-1).validation.humanAcceptance, 'not-reviewed');
  await expression(`!document.querySelector(${quote(selector('fwv-export'))})?.disabled`);
  await screenshotTop('02-image-processed-top'); await overflowCheck('03-image');
  stage = 'image export';
  await click('fwv-export');
  snapshot = await waitDisk(data => data.exports.some(pkg => pkg.assetId === imageAsset.id && pkg.revisionId === imageRevision), 'image export');
  const imagePackage = snapshot.exports.find(pkg => pkg.assetId === imageAsset.id && pkg.revisionId === imageRevision);
  assert.equal(digest(await fs.readFile(path.join(projectRoot, imagePackage.path, 'resources/image.png'))), digest(processedBuffer));
  passed('Image exported from UI', { path: path.join(projectRoot, imagePackage.path) });
  stage = 'image history';
  await selectValue('fwv-revision', originalId); await click('fwv-select-revision');
  await waitDisk(data => data.assets.find(asset => asset.id === imageAsset.id)?.selectedRevisionId === originalId, 'image historical selection');
  await ready(); await reload();
  await evaluate(cdp, `document.querySelector('button[data-section-id="images"]').click()`);
  await expression(`document.querySelector(${quote(selector('fwv-revision'))})?.value === ${quote(originalId)}`);
  await expression(`document.querySelector(${quote(selector('fwv-current-preview'))})?.naturalWidth === 120`);
  passed('Historical image selection survives page reload', { revisionId: originalId });

  stage = 'Spine import';
  const runtimeAvailable = (await fetch(editor.url + '/api/fwv/spine-runtime')).ok;
  report.spineRuntime = runtimeAvailable ? 'available' : 'not-installed';
  await enterSpine();
  const emptySpine = await evaluate(cdp, `(() => {const root=document.querySelector('[data-testid="fwv-spine"]');return {importExpanded:root.querySelector('[data-testid="fwv-spine-history"]').open,importVisible:root.querySelector('[data-testid="fwv-spine-import"]').checkVisibility(),importPrimary:root.querySelector('[data-testid="fwv-spine-import"]').dataset.tone==='primary',replaceVisible:root.querySelector('[data-testid="fwv-spine-replace"]').checkVisibility()};})()`);
  assert.deepEqual(emptySpine,{importExpanded:true,importVisible:true,importPrimary:true,replaceVisible:false});
  await screenshotTop('03-empty-spine');
  await upload('fwv-spine-import-input', fixture.files.map(file => path.join(sourceRoot, file.name)));
  snapshot = await waitDisk(data => data.assets.some(asset => asset.kind === 'spine'), 'Spine import');
  let spineAsset = snapshot.assets.find(asset => asset.kind === 'spine'); const spineOriginalId = spineAsset.selectedRevisionId;
  await expression(`document.querySelector(${quote(selector('fwv-spine-region'))})?.value === 'body' && !document.querySelector(${quote(selector('fwv-spine-import'))})?.disabled`);
  passed('Spine JSON, Atlas and PNG imported through file input', { assetId: spineAsset.id, revisionId: spineOriginalId });
  assert.equal(await evaluate(cdp, `document.querySelector('[data-testid="fwv-spine-history"]').open`),false,'Successful import folds the setup section.');
  const spineLayout = await evaluate(cdp, `(() => {const root=document.querySelector('[data-testid="fwv-spine"]');return {openSections:root.querySelectorAll('details[open]').length,partVisible:root.querySelector('[data-testid="fwv-spine-region"]').checkVisibility(),transformVisible:root.querySelector('[data-testid="fwv-spine-scale"]').checkVisibility(),primaryVisible:root.querySelector('[data-testid="fwv-spine-replace"]').checkVisibility(),replacementRequired:root.querySelector('[data-testid="fwv-spine-replace"]').disabled};})()`);
  assert.deepEqual(spineLayout, {openSections:0,partVisible:true,transformVisible:false,primaryVisible:true,replacementRequired:true});
  await screenshotTop('03-focused-spine'); passed('Spine workspace keeps current part and one primary action visible with advanced sections folded', spineLayout);
  if (runtimeAvailable) {
    await expression(`document.querySelector(${quote(selector('fwv-spine-original'))})?.dataset.rendered === 'true' && document.querySelector(${quote(selector('fwv-spine-current'))})?.dataset.rendered === 'true'`);
    assert.equal(await evaluate(cdp, `document.querySelector(${quote(selector('fwv-spine-skin'))}).value`), 'painted');
    const playFrom = await evaluate(cdp, `Number(document.querySelector(${quote(selector('fwv-spine-current'))}).dataset.time)`);
    await expression(`Number(document.querySelector(${quote(selector('fwv-spine-current'))})?.dataset.time) > ${playFrom + 0.08}`);
    const playTo = await evaluate(cdp, `Number(document.querySelector(${quote(selector('fwv-spine-current'))}).dataset.time)`);
    await scrub(0.1); const first = await canvasImage('fwv-spine-original', '04-original-at-010');
    await scrub(0.5); const second = await canvasImage('fwv-spine-original', '05-original-at-050');
    assert.ok(first.visible > 100 && first.orange > 100, `Original canvas is blank or missing fixture colors: ${JSON.stringify(first)}`);
    assert.notEqual(first.sha256, second.sha256, 'Animation scrub must change rendered pixels.');
    passed('Official Spine runtime renders moving fixture pixels with uppercase files and named skin', { jsonFile: spineJsonFile, atlasFile: spineAtlasFile, skin: 'painted', playback: { from: playFrom, to: playTo }, at010: first, at050: second });
  } else report.checks.push({ name: 'Official Spine runtime rendering', status: 'skipped', reason: 'Optional @esotericsoftware/spine-webgl is not installed. Import, replacement and export are still tested.' });

  stage = 'Spine replacement';
  await upload('fwv-spine-replacement-input', [path.join(sourceRoot, 'replacement.png')]);
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  assert.equal((await project.snapshot()).assets.find(item=>item.id===spineAsset.id).revisions.length,1);
  let previewBeforeApply;
  if(runtimeAvailable) { await scrub(.2); previewBeforeApply=await canvasImage('fwv-spine-current','05-calibration-before-apply'); assert.ok(previewBeforeApply.purple>100); }
  const fillSpine=async(id,value)=>{await reveal(id);await evaluate(cdp,`(()=>{const n=document.querySelector(${quote(selector(id))});n.value=${quote(String(value))};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
  await fillSpine('fwv-spine-scale',.6);
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  if(runtimeAvailable) { const scaled=await canvasImage('fwv-spine-current','05-calibration-scaled');assert.notEqual(scaled.sha256,previewBeforeApply.sha256); }
  await screenshotTop('05-calibration-workspace');
  await selectValue('fwv-spine-region','other');
  await expression(`!document.querySelector('[data-testid="fwv-spine-region"]').disabled`);
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-scale"]').value`),'1');
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-replace"]').disabled`),true);
  await fillSpine('fwv-spine-scale',.4);
  await selectValue('fwv-spine-region','body');
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-scale"]').value`),'0.6');
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-replace"]').disabled`),false);
  await fillSpine('fwv-spine-scale',1);
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  if(runtimeAvailable) { await scrub(.2);previewBeforeApply=await canvasImage('fwv-spine-current','05-calibration-final'); }
  assert.equal((await project.snapshot()).assets.find(item=>item.id===spineAsset.id).revisions.length,1);
  passed('Temporary calibration changes animated pixels without revisions; regions preserve independent transforms and replacement references');
  await click('fwv-spine-replace');
  snapshot = await waitDisk(data => data.assets.find(asset => asset.id === spineAsset.id)?.revisions.length === 2, 'Spine replacement');
  spineAsset = snapshot.assets.find(asset => asset.id === spineAsset.id); const spineRevision = spineAsset.selectedRevisionId;
  await expression(`!document.querySelector(${quote(selector('fwv-spine-region'))})?.disabled && document.querySelector(${quote(selector('fwv-spine-revision'))})?.value === ${quote(spineRevision)}`);
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-replace"]').disabled`),true,'A new revision must not inherit a pending replacement from its parent.');
  const oldPage = (await project.readArtifact({ assetId: spineAsset.id, revisionId: spineOriginalId, fileName: 'fixture.png' })).buffer;
  const newPage = (await project.readArtifact({ assetId: spineAsset.id, revisionId: spineRevision, fileName: 'fixture.png' })).buffer;
  assert.notEqual(digest(oldPage), digest(newPage)); assert.equal(digest(oldPage), digest(fixture.pages.get('fixture.png')));
  const newPixel = await sharp(newPage).extract({ left: 64, top: 76, width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...newPixel], [105, 91, 212, 255]);
  for (const [name, originalBuffer] of [[spineJsonFile, fixture.json], [spineAtlasFile, fixture.atlas]]) {
    assert.equal(digest((await project.readArtifact({ assetId: spineAsset.id, revisionId: spineRevision, fileName: name })).buffer), digest(originalBuffer));
  }
  passed('Spine replacement changes actual texture pixels and preserves skeleton/Atlas', { revisionId: spineRevision, pixel: [...newPixel], pageSha256: digest(newPage) });
  if (runtimeAvailable) {
    await scrub(0.2);
    const originalCanvas = await canvasImage('fwv-spine-original', '06-original-color');
    const replacedCanvas = await canvasImage('fwv-spine-current', '07-replaced-color');
    assert.ok(originalCanvas.orange > 100 && replacedCanvas.purple > 100, `Original/replaced colors missing: ${JSON.stringify({ originalCanvas, replacedCanvas })}`);
    assert.notEqual(originalCanvas.sha256, replacedCanvas.sha256);
    assert.equal(replacedCanvas.sha256,previewBeforeApply.sha256,'Applied runtime pixels match temporary preview exactly.');
    await selectValue('fwv-spine-animation', 'wave'); await scrub(0.1);
    const waveFirst = await canvasImage('fwv-spine-current', '08-wave-at-010');
    await scrub(0.3); const waveSecond = await canvasImage('fwv-spine-current', '09-wave-at-030');
    assert.notEqual(waveFirst.sha256, waveSecond.sha256);
    passed('Original and replaced canvases differ; second animation and scrub work', { originalCanvas, replacedCanvas, waveFirst, waveSecond });
  }
  await evaluate(cdp, `(() => {for(const details of document.querySelectorAll('[data-testid="fwv-spine"] details[open]'))details.querySelector(':scope > summary').click();})()`);
  await screenshotTop('10-spine-replaced-top'); await overflowCheck('11-spine');
  stage = 'Spine validation';
  await click('fwv-spine-validate');
  await waitDisk(data => data.assets.find(asset => asset.id === spineAsset.id)?.revisions.at(-1).validation?.status === 'passed', 'Spine validation');
  stage = 'Spine export';
  await click('fwv-spine-export');
  snapshot = await waitDisk(data => data.exports.some(pkg => pkg.assetId === spineAsset.id && pkg.revisionId === spineRevision), 'Spine export');
  const spinePackage = snapshot.exports.find(pkg => pkg.assetId === spineAsset.id && pkg.revisionId === spineRevision);
  assert.deepEqual(await fs.readFile(path.join(projectRoot, spinePackage.path, 'resources', spineJsonFile)), fixture.json);
  assert.deepEqual(await fs.readFile(path.join(projectRoot, spinePackage.path, 'resources', spineAtlasFile)), fixture.atlas);
  assert.equal(digest(await fs.readFile(path.join(projectRoot, spinePackage.path, 'resources', 'fixture.png'))), digest(newPage));
  passed('Spine export preserves animation and Atlas files', { path: path.join(projectRoot, spinePackage.path) });

  stage = 'Spine history';
  await selectValue('fwv-spine-revision', spineOriginalId);
  await waitDisk(data => data.assets.find(asset => asset.id === spineAsset.id)?.selectedRevisionId === spineOriginalId, 'Spine historical selection');
  await expression(`!document.querySelector(${quote(selector('fwv-spine-import'))})?.disabled`);
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-scale"]').value`),'1');
  passed('Returning to a base revision restores its own pending replacement instead of borrowing another revision');
  await reload(); await enterSpine();
  await expression(`document.querySelector(${quote(selector('fwv-spine-revision'))})?.value === ${quote(spineOriginalId)} && !document.querySelector(${quote(selector('fwv-spine-import'))})?.disabled`);
  if (runtimeAvailable) {
    await scrub(0.2); const restored = await canvasImage('fwv-spine-current', '12-history-restored');
    assert.ok(restored.orange > 100 && restored.purple === 0);
  }
  passed('Historical Spine selection survives page reload', { revisionId: spineOriginalId });

  stage = 'Spine draft persistence and migration';
  const saveParameters=async()=>{
    await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS',modifiers:2,windowsVirtualKeyCode:83});
    await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS',modifiers:2,windowsVirtualKeyCode:83});
    await expression(`window.fwe.resources.current().dirty===false && window.fwe.resources.current().file.exists===true`);
  };
  await selectValue('fwv-spine-library-image',imageAsset.id); await click('fwv-spine-use-library');
  await fillSpine('fwv-spine-scale',.8);
  await selectValue('fwv-spine-region','other');
  await expression(`!document.querySelector('[data-testid="fwv-spine-region"]').disabled`);
  await fillSpine('fwv-spine-scale',.35);
  await selectValue('fwv-spine-region','body');
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  await saveParameters(); await reload(); await enterSpine();
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-scale"]').value`),'0.8');
  await selectValue('fwv-spine-region','other');
  await expression(`!document.querySelector('[data-testid="fwv-spine-region"]').disabled`);
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-scale"]').value`),'0.35');
  await selectValue('fwv-spine-region','body');
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  await saveParameters();
  const authoringPath=path.join(projectRoot,'.fwv','editor-drafts.json'), legacy=JSON.parse(await fs.readFile(authoringPath,'utf8'));
  const legacyPart=legacy.spineDrafts.find(row=>row.id===spineAsset.id).data;
  assert.equal(legacyPart.partDrafts.find(item=>item.regionName==='other'&&item.revisionId===spineOriginalId).transform.scale,.35);
  delete legacyPart.partDrafts; await fs.writeFile(authoringPath,JSON.stringify(legacy,null,2)+'\n');
  await reload(); await enterSpine();
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-scale"]').value`),'0.8');
  await selectValue('fwv-spine-region','other');
  await expression(`!document.querySelector('[data-testid="fwv-spine-region"]').disabled`);
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-scale"]').value`),'1');
  await selectValue('fwv-spine-region','body');
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-scale"]').value`),'0.8');
  passed('Native FWE save/reload preserves independent part inputs; legacy one-part drafts migrate without leaking into other regions');

  stage = 'Spine stale calibration response';
  await evaluate(cdp,`(()=>{window.restorePreviewFetch=window.fetch;let hold=true;let release;const delayed=new Promise(resolve=>release=resolve);window.releasePreview=release;window.fetch=async(...args)=>{const response=await window.restorePreviewFetch(...args);if(hold&&String(args[0])==='/api/fwv/commands'&&JSON.parse(args[1]?.body||'{}').type==='spine.preview'){hold=false;const body=await response.json();window.heldPreview=body;await delayed;return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});}return response;};})()`);
  await fillSpine('fwv-spine-scale',.45); await expression('Boolean(window.heldPreview)');
  await fillSpine('fwv-spine-scale',.9);
  await expression(`document.querySelector('[data-testid="fwv-spine-current"]')?.dataset.calibration==='ready'`);
  if(runtimeAvailable) await scrub(.2);
  const latestPreview=runtimeAvailable?await canvasImage('fwv-spine-current','13-latest-calibration'):null;
  await evaluate(cdp,'window.releasePreview();window.fetch=window.restorePreviewFetch');await pause(160);
  if(runtimeAvailable) assert.equal((await canvasImage('fwv-spine-current','14-after-stale-response')).sha256,latestPreview.sha256);
  assert.equal(await evaluate(cdp,`document.querySelector('[data-testid="fwv-spine-scale"]').value`),'0.9');
  assert.equal((await project.snapshot()).assets.find(item=>item.id===spineAsset.id).revisions.length,2);
  passed('A delayed real preview response cannot overwrite newer transform pixels or create a revision');

  stage = 'Spine pending request navigation';
  let resolvePending;
  const pendingArtifact = new Promise(resolve => { resolvePending = resolve; });
  cdp.on('Fetch.requestPaused', event => resolvePending(event));
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*/api/fwv/artifact?*', requestStage: 'Response' }] });
  await selectValue('fwv-spine-library-image', imageAsset.id);
  await click('fwv-spine-use-library');
  let artifactTimeout;
  const pausedArtifact = await Promise.race([pendingArtifact, new Promise((_, reject) => { artifactTimeout = setTimeout(() => reject(new Error('Spine library read was not intercepted.')), 15000); })]).finally(() => clearTimeout(artifactTimeout));
  assert.ok(pausedArtifact.request.url.includes(imageAsset.id), 'The delayed response must be the chosen real library image.');
  await expression(`document.querySelector(${quote(selector('fwv-spine-import'))})?.disabled`);
  await evaluate(cdp, `document.querySelector('button[data-section-id="images"]').click()`);
  await expression(`document.querySelector('[data-testid="fwv-width"]') && !document.querySelector('[data-testid="fwv-spine"]')`);
  await cdp.call('Fetch.continueResponse', { requestId: pausedArtifact.requestId });
  await cdp.call('Fetch.disable'); await pause(160);
  assert.equal(await evaluate(cdp, `Boolean(document.querySelector('[data-testid="fwv-spine"]'))`), false);
  assert.equal(report.browserErrors.length, 0, 'A completed asynchronous read must not update the disposed Spine surface.');
  passed('Navigation safely disposes Spine while an actual library image response is pending');
  // An unavailable optional runtime produces expected network errors, recorded as
  // skips; every other browser exception or error remains a failing acceptance.
  const failures = report.browserErrors.filter(error => !(report.spineRuntime === 'not-installed' && error.includes('/api/fwv/spine-runtime')));
  assert.equal(failures.length, 0, `Browser errors: ${failures.join('\n')}`);
  report.status = runtimeAvailable ? 'passed' : 'passed-with-spine-render-skipped';
} catch (error) {
  report.status = 'failed'; report.failureStage = stage; report.error = error.stack || String(error); process.exitCode = 1;
  if (cdp) {
    try { await screenshot('failure'); report.visibleStatus = await evaluate(cdp, `({workbench:document.querySelector(${quote(selector('fwv-status'))})?.textContent,spine:document.querySelector(${quote(selector('fwv-spine-status'))})?.textContent})`); } catch {}
  }
  console.error(`[FWV browser] FAILED at ${stage}: ${error.message}`);
} finally {
  report.finishedAt = new Date().toISOString();
  if (cdp) cdp.close();
  if (chrome) await stopProcess(chrome);
  if (editor) await editor.close();
  await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(outputRoot, 'latest.json'), JSON.stringify({ status: report.status, runRoot, report: path.join(runRoot, 'report.json') }, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json'), projectRoot }, null, 2));
}
