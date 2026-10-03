import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { importSkeleton2d } from '../src/skeleton2d/application.mjs';
import { startEditor } from '../src/editor/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Exercise this workbench's FWE unless a host explicitly selects another checkout.
const fwePath = path.resolve(process.env.FWV_BROWSER_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url)));
const require = createRequire(import.meta.url);
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test/browser-smoke.js'));
const output = path.join(root, '.local/reports/gallery2d-browser'); await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project');
const project = new FwvProject(projectRoot); await project.init({ name: 'FWE 原生 2D 素材目录验收' });
const texture = await sharp({ create: { width: 80, height: 100, channels: 4, background: '#499fd4' } }).png().toBuffer();
const flashTexture = await sharp({ create: { width: 80, height: 100, channels: 4, background: '#fff0cc' } }).png().toBuffer();
const stoneTexture = await sharp({ create: { width: 80, height: 100, channels: 4, background: '#757575' } }).png().toBuffer();
const jpeg = await sharp({ create: { width: 96, height: 72, channels: 3, background: '#bc704a' } }).jpeg().toBuffer();
const webp = await sharp({ create: { width: 72, height: 96, channels: 4, background: '#70bc4a' } }).webp().toBuffer();
const files = Array.from({ length: 58 }, (_, index) => ({ name: `part-${String(index).padStart(2, '0')}.png`, mime: 'image/png', role: 'texture', buffer: texture }));
files.push({ name: 'part-58-portrait.jpg', mime: 'image/jpeg', role: 'reference', buffer: jpeg }, { name: 'part-59-logo.webp', mime: 'image/webp', role: 'image', buffer: webp }, { name: 'actor.json', mime: 'application/json', role: 'document', buffer: Buffer.from('{"note":"hidden non-image"}') });
const group = await project.importAsset({ name: 'Historical multipart actor', kind: 'custom-pack', files });
const historicalRevision = group.selectedRevisionId;
const updated = await project.addRevision({ assetId: group.id, parentRevisionId: historicalRevision, files: [
  { name: 'current-poster.jpg', mime: 'image/jpeg', role: 'image', buffer: jpeg }, { name: 'current-logo.webp', mime: 'image/webp', role: 'image', buffer: webp }
] });
const selectedRevision = updated.selectedRevisionId;
const image = await project.importAsset({ name: 'Seascape', kind: 'image', files: [
  { name: 'sea.png', mime: 'image/png', role: 'source', buffer: texture },
  { name: 'sea__flash.png', mime: 'image/png', role: 'texture', buffer: flashTexture },
  { name: 'sea__stone.png', mime: 'image/png', role: 'texture', buffer: stoneTexture }
] });
await project.importAsset({ name: 'No artwork', kind: 'metadata', files: [{ name: 'data.json', mime: 'application/json', role: 'data', buffer: Buffer.from('{}') }] });
const document = { format: 'fwd-skeleton2d', schemaVersion: 1, coordinateSystem: 'y-up', bones: [{ name: 'root' }],
  slots: [{ name: 'body', bone: 'root', attachment: 'body' }], skins: [{ name: 'blue', attachments: { body: { body: { type: 'region', path: 'body', width: 80, height: 100 } } } }],
  animations: { idle: {} }, animationDurations: { idle: 1 }, loopAnimations: ['idle'], textures: { body: 'body.png' }, bounds: { x: -50, y: -60, width: 100, height: 120 } };
const actor = await importSkeleton2d(project, { name: 'Demo 2D actor', document, textures: [{ name: 'body.png', buffer: texture }] });
const initialSnapshot = await project.snapshot();
const report = { status: 'running', fwePath, runRoot, projectRoot, checks: [], browserErrors: [], screenshots: [], imageRequests: [], legacyRequests: [], mutationRequests: [] };
let editor, chrome, cdp, stage = 'start';
const q = JSON.stringify, selector = id => `[data-testid="${id}"]`, wait = expr => waitForExpression(cdp, expr, 25000), read = expr => evaluate(cdp, expr);
const settled = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
async function reveal(css) { await wait(`document.querySelector(${q(css)})`); await read(`document.querySelector(${q(css)}).scrollIntoView({block:'center'})`); }
async function click(css) { await reveal(css); await wait(`!document.querySelector(${q(css)}).disabled`); await read(`document.querySelector(${q(css)}).click()`); await settled(); }
async function set(id, value) { const css = selector(id); await reveal(css); await read(`(() => {const node=document.querySelector(${q(css)});node.focus();node.value=${q(String(value))};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`); await settled(); }
async function filter(id, values) { await read(`document.querySelector(${q(`[data-filter-id="${id}"]`)}).dispatchEvent(new CustomEvent('change',{detail:{values:${q(values)}}}))`); await settled(); }
async function search(value) { await read(`(() => {const node=document.querySelector('#collectionSearch');node.value=${q(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`); await settled(); }
const rowId = (assetId, revisionId, file) => `${assetId}/${revisionId}/${file}`;
async function navigate(assetId, revisionId, file) { assert.equal(await read(`window.fwe.navigation.navigate(${q({ domainId: 'fwv-catalog', fileName: 'catalog.json', collectionId: 'images', itemId: rowId(assetId, revisionId, file), mode: 'preview' })},{updateUrl:true})`), true); await settled(); }
const ready = (assetId, revisionId, file) => wait(`(() => {const c=document.querySelector('[data-testid="g2d-canvas"]');return c?.dataset.ready==='true'&&c.dataset.assetId===${q(assetId)}&&c.dataset.revisionId===${q(revisionId)}&&c.dataset.fileName===${q(file)};})()`);
async function screenshot(name) { await read(`(() => {for(let node=document.querySelector('#collectionWorkbench');node;node=node.parentElement)node.scrollTop=0;})()`); await settled(); const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const file = path.join(runRoot, `${name}.png`); await fs.writeFile(file, Buffer.from(result.data, 'base64')); report.screenshots.push(file); }
const record = name => { report.checks.push(name); console.log(`[gallery2d] ${name}`); };
const listCount = () => read('document.querySelectorAll("#collectionList .collection-item").length');
const cardCount = () => read('document.querySelectorAll(".collection-grid-card").length');
const pageInfo = () => read('document.querySelector("#collectionPageInfo").textContent');
const centerPixel = () => read(`(() => {const c=document.querySelector('[data-testid="g2d-canvas"]');return Array.from(c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data);})()`);
const blueBounds = () => read(`(() => {const c=document.querySelector('[data-testid="g2d-canvas"]'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let minX=c.width,minY=c.height,maxX=-1,maxY=-1;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(p[i]>=70&&p[i]<=76&&p[i+1]>=155&&p[i+1]<=163&&p[i+2]>=207&&p[i+2]<=216){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)}}return {minX,minY,maxX,maxY};})()`);
try {
  editor = await startEditor({ projectRoot, fwePath, port: 0 }); const port = await getFreePort(); chrome = startChrome(editor.url, port); const target = await waitForTarget(port, editor.url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (request.url.includes('/api/fwv/image?')) report.imageRequests.push(request.url);
    if (/\/api\/fwv\/(gallery2d|artifact)\?/.test(request.url)) report.legacyRequests.push(request.url);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) report.mutationRequests.push({ method: request.method, url: request.url });
  });
  for (const domain of ['Runtime', 'Page', 'DOM', 'Network']) await cdp.call(domain + '.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1050, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.navigate', { url: editor.url });
  await wait('document.querySelector("#collectionSearch") && document.querySelectorAll("#collectionList .collection-item").length>0');
  assert.equal(await listCount(), 4, 'The native default current filter must exclude all 60 historical rows');
  assert.equal(await cardCount(), 4, 'The native catalog starts in grid mode with current versions only');
  assert.equal(await read('Array.from(document.querySelectorAll(".collection-grid-card")).some(card=>/__flash|__stone/.test(card.dataset.itemId))'), false, 'State variants must not appear as independent native grid cards');
  assert.match(await read(`document.querySelector(${q(`.collection-grid-card[data-item-id="${rowId(image.id, image.selectedRevisionId, 'sea.png')}"]`)}).textContent`), /原图 \+ 2 种状态/);
  await navigate(image.id, image.selectedRevisionId, 'sea.png'); await click('#collectionDetailButton'); await ready(image.id, image.selectedRevisionId, 'sea.png');
  assert.equal(await read('typeof window.FwvPanels'), 'undefined', 'Professional forms must use the FWE registry directly');
  assert.equal(await read('typeof window.fwe.getForm("fwd-image-preview")?.render'), 'function');
  assert.equal(await read('typeof window.fwe.getForm("fwd-skeleton2d")?.render'), 'function');
  assert.equal(await listCount(), 4);
  assert.equal(await read('document.querySelectorAll("#collectionList .collection-thumbnail[loading=lazy]").length'), 4);
  await wait('Array.from(document.querySelectorAll("#collectionList img")).some(image=>image.naturalWidth>0)');
  assert.equal(await read(`Boolean(document.querySelector('[data-testid="g2d-search"],[data-testid="g2d-asset"],[data-testid="g2d-revision"],[data-testid="g2d-files"],[data-testid="g2d-file-search"],[data-testid="g2d-next"],[data-testid="g2d-previous"]'))`), false);
  assert.equal(await read('document.querySelector("#collectionList").textContent.includes("data.json")'), false);
  assert.match(await pageInfo(), /1 \/ 1.*4/);
  record('FWE native list owns the current-version catalog, lazy thumbnails and selection; no custom gallery browser or non-image rows remain');

  stage = 'grouped image states and native search';
  assert.equal(await read(`document.querySelector('[data-testid="g2d-variants"]').open`), false, 'Derived states stay collapsed until explicitly opened');
  assert.match(await read(`document.querySelector('[data-testid="g2d-variants"] summary').textContent`), /原图 \+ 2 种状态 · 展开查看/);
  await search('__stone'); await ready(image.id, image.selectedRevisionId, 'sea.png');
  assert.equal(await listCount(), 1, 'Searching a state filename must find its single original image row');
  assert.equal(await read('document.querySelector("#collectionList .collection-item").dataset.itemId'), rowId(image.id, image.selectedRevisionId, 'sea.png'));
  await click('[data-testid="g2d-variants"] summary');
  assert.deepEqual(await read(`Array.from(document.querySelector('[data-testid="g2d-variant"]').options, option=>({value:option.value,label:option.textContent}))`), [
    { value: 'sea.png', label: '原图' }, { value: 'sea__flash.png', label: '受击闪亮' }, { value: 'sea__stone.png', label: '石化' }
  ]);
  await set('g2d-variant', 'sea__stone.png'); await ready(image.id, image.selectedRevisionId, 'sea__stone.png');
  assert.deepEqual(await centerPixel(), [117, 117, 117, 255]);
  assert.match(await read(`document.querySelector('[data-testid="g2d-preview-info"]').textContent`), /^sea__stone\.png · 80 × 100 px · PNG$/);
  await set('g2d-variant', 'sea__flash.png'); await ready(image.id, image.selectedRevisionId, 'sea__flash.png');
  assert.deepEqual(await centerPixel(), [255, 240, 204, 255]);
  await screenshot('03-grouped-state-detail');
  record('One original card contains collapsed state previews; native suffix search finds the original and state selection renders exact filenames and pixel colors');

  stage = 'state selection loading race';
  await set('g2d-variant', 'sea.png'); await ready(image.id, image.selectedRevisionId, 'sea.png');
  // Hold an already received blob after fetch completes, so an aborted old selection
  // can finish later and exercise the preview loader sequence guard deterministically.
  await read(`(() => {window.galleryRace={fetch:window.fetch};const race=window.galleryRace;race.pending=new Promise(resolve=>race.release=resolve);window.fetch=async(...args)=>{const response=await race.fetch.apply(window,args);const url=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href);if(url.pathname==='/api/fwv/image'&&url.searchParams.get('file')==='sea__flash.png'&&!url.searchParams.has('thumbnail')){const blob=response.blob.bind(response);response.blob=async()=>{const result=await blob();race.entered=true;await race.pending;race.released=true;return result;};}return response;};})()`);
  await set('g2d-variant', 'sea__flash.png'); await wait('window.galleryRace.entered===true');
  await set('g2d-variant', 'sea__stone.png'); await ready(image.id, image.selectedRevisionId, 'sea__stone.png');
  await read('window.galleryRace.release()'); await wait('window.galleryRace.released===true'); await settled();
  assert.equal(await read(`document.querySelector('[data-testid="g2d-canvas"]').dataset.fileName`), 'sea__stone.png');
  assert.equal(await read(`document.querySelector('[data-testid="g2d-variant"]').value`), 'sea__stone.png');
  assert.deepEqual(await centerPixel(), [117, 117, 117, 255], 'A late former selection must not overwrite the current state image');
  assert.match(await read(`document.querySelector('[data-testid="g2d-preview-info"]').textContent`), /^sea__stone\.png/);
  await read('window.fetch=window.galleryRace.fetch;delete window.galleryRace');
  await set('g2d-variant', 'sea.png'); await ready(image.id, image.selectedRevisionId, 'sea.png');
  assert.deepEqual(await centerPixel(), [73, 159, 212, 255]);
  assert.equal(await listCount(), 1, 'Preview state changes must preserve the native catalog search');
  await search(''); await ready(image.id, image.selectedRevisionId, 'sea.png');
  assert.equal(await listCount(), 4);
  record('Rapid state changes keep the newest filename, selector and pixels even when an older image response finishes late');

  stage = 'native history filters and pagination';
  await filter('current', ['historical']); await filter('assetId', [group.id]); await filter('kind', ['custom-pack']);
  assert.equal(await listCount(), 48); assert.match(await pageInfo(), /1 \/ 2.*1–48 \/ 60/);
  assert.equal(await read('document.querySelector("#collectionPreviousPageButton").disabled'), true);
  await click('#collectionGridButton'); assert.equal(await cardCount(), 48);
  assert.equal(await read('document.querySelectorAll(".collection-grid-card img[loading=lazy]").length'), 48);
  assert.equal(await read(`Boolean(document.querySelector('[data-testid="g2d-canvas"]'))`), false, 'Grid mode should contain only the native catalog, without a mounted detail renderer');
  await screenshot('01-native-history-grid');
  await click('#collectionNextPageButton'); assert.equal(await cardCount(), 12); assert.match(await pageInfo(), /2 \/ 2.*49–60 \/ 60/);
  assert.equal(await read('document.querySelector("#collectionNextPageButton").disabled'), true);
  assert.equal(await read('document.querySelector("#collectionList").textContent.includes("actor.json")'), false);
  record('Native version/asset/type filters reveal all 60 historical images across shared 48-item list/grid pages');

  stage = 'native selection and image formats';
  await click(`.collection-grid-card[data-item-id="${rowId(group.id, historicalRevision, 'part-58-portrait.jpg')}"]`);
  assert.equal(await cardCount(), 12, 'Selecting a native grid card must preserve grid mode');
  await click('#collectionDetailButton'); await ready(group.id, historicalRevision, 'part-58-portrait.jpg');
  assert.equal(await listCount(), 12); assert.match(await pageInfo(), /2 \/ 2/);
  assert.match(await read(`document.querySelector('[data-testid="g2d-preview-info"]').textContent`), /96 × 72 px.*JPEG/);
  await click(`.collection-item[data-item-id="${rowId(group.id, historicalRevision, 'part-59-logo.webp')}"]`); await ready(group.id, historicalRevision, 'part-59-logo.webp');
  assert.match(await read(`document.querySelector('[data-testid="g2d-preview-info"]').textContent`), /72 × 96 px.*WEBP/);
  assert.equal(await read(`(() => {const c=document.querySelector('[data-testid="g2d-canvas"]'),p=c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data;return p[1]>150&&p[0]<150&&p[2]<150;})()`), true);
  await navigate(group.id, historicalRevision, 'part-00.png'); await ready(group.id, historicalRevision, 'part-00.png');
  assert.match(await pageInfo(), /1 \/ 2/); assert.match(await read(`document.querySelector('[data-testid="g2d-preview-info"]').textContent`), /80 × 100 px.*PNG/);
  record('Native grid selection/detail transition and list selection load exact historical PNG, JPEG and WebP files with decoded dimensions and pixels');

  stage = 'professional preview zoom and drag';
  await set('g2d-background', 'dark'); assert.deepEqual(await read(`Array.from(document.querySelector('[data-testid="g2d-canvas"]').getContext('2d').getImageData(0,0,1,1).data)`), [32, 39, 53, 255]);
  const fitted = await blueBounds(); assert.ok(fitted.maxX > fitted.minX);
  await set('g2d-zoom', '2'); assert.equal(await read(`document.querySelector('[data-testid="g2d-canvas"]').dataset.zoom`), '2');
  const enlarged = await blueBounds(); assert.ok(enlarged.maxX - enlarged.minX > (fitted.maxX - fitted.minX) * 1.8);
  await click(selector('g2d-reset-view')); assert.equal(await read(`document.querySelector('[data-testid="g2d-canvas"]').dataset.zoom`), '1');
  await reveal(selector('g2d-canvas')); await settled();
  const beforeDrag = await blueBounds();
  const pointer = await read(`(() => {const r=document.querySelector('[data-testid="g2d-canvas"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointer });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...pointer, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x + 70, y: pointer.y + 35, buttons: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pointer.x + 70, y: pointer.y + 35, button: 'left', buttons: 0, clickCount: 1 }); await settled();
  const dragged = await blueBounds(); assert.ok(dragged.minX - beforeDrag.minX > 40 && dragged.minY - beforeDrag.minY > 20, 'Real pointer dragging must visibly move image pixels');
  await click(selector('g2d-reset-view')); assert.deepEqual(await blueBounds(), beforeDrag);
  await read(`window.retiredGalleryControl = {zoom:document.querySelector('[data-testid="g2d-zoom"]'),canvas:document.querySelector('[data-testid="g2d-canvas"]')}`);
  await screenshot('02-native-image-detail');
  record('The professional detail Form renders transparent backdrops, pixel-verified zoom, real pointer panning and reset without changing catalog state');

  stage = 'native search deep links and read-only browsing';
  await search('portrait'); await ready(group.id, historicalRevision, 'part-58-portrait.jpg'); assert.equal(await listCount(), 1); assert.match(await pageInfo(), /1 \/ 1.*1/);
  await search('does-not-exist'); assert.equal(await listCount(), 0); assert.equal(await read(`Boolean(document.querySelector('[data-testid="g2d-canvas"]'))`), false);
  await navigate(group.id, historicalRevision, 'part-59-logo.webp'); await ready(group.id, historicalRevision, 'part-59-logo.webp');
  assert.equal(await read('document.querySelector("#collectionSearch").value'), ''); assert.match(await pageInfo(), /2 \/ 2/);
  await navigate(image.id, image.selectedRevisionId, 'sea.png'); await ready(image.id, image.selectedRevisionId, 'sea.png');
  assert.equal(await read(`(() => {const old=window.retiredGalleryControl;old.zoom.value='4';old.zoom.dispatchEvent(new Event('change',{bubbles:true}));return !old.zoom.isConnected&&old.canvas.dataset.zoom==='1';})()`), true, 'Native Surface disposal must release retired field bindings');
  const retiredControl = await cdp.call('Runtime.evaluate', { expression: 'window.retiredGalleryControl.zoom' });
  const retiredListeners = await cdp.call('DOMDebugger.getEventListeners', { objectId: retiredControl.result.objectId });
  assert.deepEqual(retiredListeners.listeners, [], 'Detached gallery fields must retain no event listeners');
  await cdp.call('Runtime.releaseObject', { objectId: retiredControl.result.objectId });
  assert.equal(await read('window.fwe.resources.current().dirty'), false);
  assert.equal((await project.snapshot()).assets.find(asset => asset.id === group.id).selectedRevisionId, selectedRevision);
  assert.deepEqual(report.legacyRequests, []);
  assert.ok(report.imageRequests.some(url => new URL(url).searchParams.get('thumbnail') === '1'));
  assert.ok(report.imageRequests.some(url => !new URL(url).searchParams.has('thumbnail')));
  record('Native search/filter/deep-link selection reconciles pages and empty results; thumbnails and full previews use the image endpoint without dirtying resources');

  stage = 'skeleton navigation and zero writes';
  await navigate(actor.id, actor.selectedRevisionId, 'body.png'); await ready(actor.id, actor.selectedRevisionId, 'body.png');
  await click(selector('g2d-open-skeleton')); await wait(`document.querySelector('[data-testid="s2d-canvas"]')?.dataset.assetId===${q(actor.id)}&&document.querySelector('[data-testid="s2d-canvas"]').dataset.ready==='true'`);
  assert.equal(await read('window.fwe.resources.current().domain.id'), 'fwv-authoring');
  assert.equal(await read('window.fwe.resources.current().dirty'), false);
  assert.equal(await read(`document.querySelector('[data-testid="s2d-canvas"]').dataset.revisionId`), actor.selectedRevisionId);
  assert.deepEqual(await project.snapshot(), initialSnapshot, 'All browsing must leave project assets and selected revisions unchanged');
  assert.deepEqual(report.mutationRequests, [], 'Browsing images, history, filters and skeletons must not send writes');
  record('A skeleton texture opens the exact asset/revision in the native animation collection; all browse scenarios including state previews issue zero writes and preserve the project');
  assert.deepEqual(report.browserErrors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.stage = stage; report.error = error.stack; process.exitCode = 1; console.error(error); if (cdp) try { await screenshot('failure'); report.pageText = await read('document.body.innerText'); } catch {} }
finally { cdp?.close(); if (chrome) await stopProcess(chrome); if (editor) await editor.close(); report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') })); }
