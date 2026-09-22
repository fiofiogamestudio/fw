import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startEditor } from '../src/editor/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), fwePath = fileURLToPath(new URL('../../fwe', import.meta.url));
const require = createRequire(import.meta.url);
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test/browser-smoke.js'));
const sourceRoot = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(root, '.local/demo'));
const output = path.join(root, '.local/reports/demo-ui-browser'); await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project');
const sourceBytes = await fs.readFile(path.join(sourceRoot, 'fwv.project.json'));
const manifest = JSON.parse(sourceBytes), hash = bytes => createHash('sha256').update(bytes).digest('hex');
await fs.cp(sourceRoot, projectRoot, { recursive: true });
const report = { status: 'running', sourceRoot, sourceManifestSha256: hash(sourceBytes), assets: manifest.assets.length, checks: [], screenshots: [], browserErrors: [] };
let editor, chrome, cdp, stage = 'setup';
const q = JSON.stringify, selector = id => `[data-testid="${id}"]`;
const wait = expression => waitForExpression(cdp, expression, 15000);
const checkMetrics = process.argv.includes('--metrics');
async function metrics(ids) {
  return evaluate(cdp, `Object.fromEntries(${q(ids)}.map(id=>{const el=document.querySelector('[data-testid="'+id+'"]'),r=el.getBoundingClientRect(),s=getComputedStyle(el),label=el.closest('.field')?.querySelector('.field__label');return [id,{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,font:s.fontSize,lineHeight:s.lineHeight,rows:el.tagName==='TEXTAREA'?el.rows:null,labelFont:label?getComputedStyle(label).fontSize:null}]}))`);
}
function checkControls(data, ids) {
  for (const id of ids) { assert.equal(data[id].height, 36, id + ' height'); assert.equal(data[id].font, '14px', id + ' font'); if(data[id].labelFont)assert.equal(data[id].labelFont,'12px',id+' label'); }
}
async function checkExpanded(name) {
  await evaluate(cdp, `document.querySelector('[data-testid="fwv-assets"]').querySelectorAll('details').forEach(el=>el.open=true)`);
  const result = await evaluate(cdp, `(() => {const root=document.querySelector('[data-testid="fwv-assets"]'),controls=Array.from(root.querySelectorAll('button,select,input:not([type="checkbox"]):not([type="file"]):not([type="color"])')).filter(el=>el.getClientRects().length);return {count:controls.length,bad:controls.filter(el=>{const r=el.getBoundingClientRect();return Math.abs(r.height-36)>.1||getComputedStyle(el).fontSize!=='14px'||r.right>1280||r.left<0}).map(el=>({id:el.dataset.testid,text:el.textContent.slice(0,60),height:el.getBoundingClientRect().height,right:el.getBoundingClientRect().right})),overflow:document.documentElement.scrollWidth>1280};})()`);
  assert.deepEqual(result.bad, [], name); assert.equal(result.overflow, false); await capture(name);
  await evaluate(cdp, `document.querySelector('[data-testid="fwv-assets"]').querySelectorAll('details').forEach(el=>el.open=false)`);
  record(name + ' keeps all visible controls at 36px with no horizontal overflow', result);
}
async function capture(name) {
  await evaluate(cdp, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await evaluate(cdp, `(() => {for(const e of document.querySelectorAll('*'))if(e.scrollTop)e.scrollTop=0;window.scrollTo(0,0)})()`);
  const data = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(runRoot, name + '.png'); await fs.writeFile(file, Buffer.from(data.data, 'base64')); report.screenshots.push(file);
}
async function navigate(collectionId) {
  await evaluate(cdp, `window.fwe.navigation.navigate({domainId:'fwv-authoring',fileName:'authoring.json',collectionId:${q(collectionId)}})`);
}
async function select(id, value) {
  await wait(`document.querySelector(${q(selector(id))})`);
  await evaluate(cdp, `(() => {const e=document.querySelector(${q(selector(id))});e.value=${q(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
function record(name, detail = {}) { report.checks.push({ name, ...detail }); console.log('[FWV demo UI] ' + name); }
try {
  editor = await startEditor({ projectRoot, fwePath, port: 0 }); report.url = editor.url;
  const port = await getFreePort(); chrome = startChrome(editor.url, port);
  const target = await waitForTarget(port, editor.url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  for (const domain of ['Runtime', 'Page', 'DOM']) await cdp.call(domain + '.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.reload', { ignoreCache: true });
  await wait(`document.querySelector('[data-testid="fwv-assets-source"]')?.options.length === ${manifest.assets.length}`);
  const firstImage = manifest.assets.find(a => a.kind === 'image');
  await select('fwv-assets-source', firstImage.id);
  await wait(`(() => {const c=document.querySelector('[data-testid="fwv-assets-source-canvas"]'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;const colors=new Set();for(let i=0;i<p.length;i+=400)colors.add(p.slice(i,i+3).join());return colors.size>8;})()`);
  await capture('01-image-1280x800');
  const first = await evaluate(cdp, `(() => {const get=id=>document.querySelector('[data-testid="'+id+'"]');return {asset:get('fwv-assets-source').selectedOptions[0].textContent,buttonBottom:get('fwv-assets-create').getBoundingClientRect().bottom,promptBottom:get('fwv-assets-request').getBoundingClientRect().bottom,importText:get('fwv-assets-import').textContent,accept:get('fwv-import-input').accept,regionVisible:get('fwv-assets-region-info').getClientRects().length,text:document.body.innerText};})()`);
  assert.ok(first.buttonBottom <= 800, `Primary action below first viewport: ${first.buttonBottom}`);
  assert.ok(first.promptBottom <= 800); assert.match(first.importText, /3D/); assert.match(first.accept, /\.glb/); assert.equal(first.regionVisible, 0);
  assert.doesNotMatch(first.text, /顶部保存与撤销只影响|未圈选时修改|准备后复制给当前 AI|当前采用版本保持不变/);
  delete first.text; record('Real demo image opens with prompt and primary action inside 800px, no default gray instructions, and reachable GLB import', first);
  let imageMetrics;
  if(checkMetrics) {
    imageMetrics=await metrics(['fwv-assets-source','fwv-assets-import','fwv-assets-zoom','fwv-assets-backdrop','fwv-assets-create','fwv-assets-request','fwv-assets-source-canvas']);
    checkControls(imageMetrics,['fwv-assets-source','fwv-assets-import','fwv-assets-zoom','fwv-assets-backdrop','fwv-assets-create']);
    assert.equal(imageMetrics['fwv-assets-request'].rows,4); assert.equal(imageMetrics['fwv-assets-request'].font,'14px'); assert.equal(imageMetrics['fwv-assets-request'].labelFont,'12px');
    assert.equal(imageMetrics['fwv-assets-source'].bottom,imageMetrics['fwv-assets-import'].bottom);
    record('Image control metrics at 1280x800',imageMetrics); await checkExpanded('01-image-expanded-1280x800');
  }
  stage = 'real Spine';
  const spine = manifest.assets.find(a => a.kind === 'spine'); await select('fwv-assets-source', spine.id);
  await wait(`document.querySelector('[data-testid="fwv-spine-repair-source"]')?.dataset.rendered === 'true'`);
  await wait(`!document.querySelector('[data-testid="fwv-assets-create"]').disabled`);
  await capture('02-spine-1280x800');
  const spineState = await evaluate(cdp, `({toolsOpen:document.querySelector('[data-testid="fwv-spine-repair-tools"]').open,buttonBottom:document.querySelector('[data-testid="fwv-assets-create"]').getBoundingClientRect().bottom,promptRight:document.querySelector('[data-testid="fwv-assets-request"]').getBoundingClientRect().right})`);
  assert.equal(spineState.toolsOpen, false); assert.ok(spineState.buttonBottom <= 800, `Spine action below first viewport: ${spineState.buttonBottom}`);
  assert.ok(spineState.promptRight <= 1280, `Spine prompt overflows: ${spineState.promptRight}`);
  record('Real demo Spine renders with closed specialist controls and the request action in the first viewport', spineState);
  if(checkMetrics) {
    const spineMetrics=await metrics(['fwv-assets-source','fwv-assets-import','fwv-spine-repair-animation','fwv-spine-repair-time','fwv-assets-create','fwv-assets-request','fwv-spine-repair-source']);
    checkControls(spineMetrics,['fwv-assets-source','fwv-assets-import','fwv-spine-repair-animation','fwv-spine-repair-time','fwv-assets-create']);
    assert.deepEqual(spineMetrics['fwv-assets-request'],imageMetrics['fwv-assets-request']);
    assert.equal(spineMetrics['fwv-spine-repair-source'].y,imageMetrics['fwv-assets-source-canvas'].y);
    assert.equal(spineMetrics['fwv-spine-repair-source'].height,imageMetrics['fwv-assets-source-canvas'].height);
    record('Spine request and viewport geometry matches image geometry at 1280x800',spineMetrics); await checkExpanded('02-spine-expanded-1280x800');
  }
  for (const [collection, id, name] of [['imageDrafts','fwv-image-library','03-image-tool'],['spineDrafts','fwv-spine-asset','04-spine-tool'],['rigDrafts','fwv-rig-draft','05-rig-tool'],['reskinDrafts','fwv-reskin','06-reskin-tool'],['generationDrafts','fwv-generation-job-status','07-generation-tool']]) {
    stage = collection; await navigate(collection); await wait(`document.querySelector(${q(selector(id))})`);
    if (collection === 'rigDrafts') { await select('fwv-rig-draft', manifest.assets.find(a => a.kind === 'rig').id); await wait(`document.querySelector('[data-testid="fwv-rig-source-image"]')?.naturalWidth > 0`); }
    if (collection === 'imageDrafts') await wait(`document.querySelector('[data-testid="fwv-current-preview"]')?.naturalWidth > 0`);
    if (['spineDrafts','reskinDrafts'].includes(collection)) await wait(`document.querySelector('canvas[data-rendered="true"]')`);
    await capture(name); record('Existing tool remains reachable: ' + collection);
  }
  assert.deepEqual(await fs.readFile(path.join(sourceRoot, 'fwv.project.json')), sourceBytes);
  assert.deepEqual(await fs.readFile(path.join(projectRoot, 'fwv.project.json')), sourceBytes);
  assert.deepEqual(report.browserErrors, []); record('Original and copied demo manifests are unchanged; no browser runtime errors'); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.stage = stage; report.error = error.stack; process.exitCode = 1;
  if (cdp) try { await capture('failure'); } catch {}
  console.error(`[FWV demo UI] ${stage}: ${error.message}`);
} finally {
  if (cdp) cdp.close(); if (chrome) await stopProcess(chrome); if (editor) await editor.close();
  const file = path.join(runRoot, 'report.json'); await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: file }));
}
