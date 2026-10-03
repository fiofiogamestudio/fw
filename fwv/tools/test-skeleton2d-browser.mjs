import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { importSkeleton2d, inspectSkeleton2d } from '../src/skeleton2d/application.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { readAuthoring } from '../src/editor/authoring.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fwePath = path.resolve(process.env.FWV_BROWSER_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url)));
const require = createRequire(import.meta.url);
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test/browser-smoke.js'));
const output = path.join(root, '.local/reports/skeleton2d-browser'); await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project');
const project = new FwvProject(projectRoot), initial = await project.init({ name: '通用 2D 骨骼工作台验收' });
const texture = await sharp({ create: { width: 80, height: 100, channels: 4, background: '#499fd4' } }).png().toBuffer();
const document = { format: 'fwd-skeleton2d', schemaVersion: 1, coordinateSystem: 'y-up', bones: [{ name: 'root' }, { name: 'body', parent: 'root', y: 50 }, { name: 'arm', parent: 'body', x: 45, y: 15 }],
  slots: [{ name: 'body-slot', bone: 'body', attachment: 'body' }, { name: 'arm-slot', bone: 'arm', attachment: 'arm' }],
  skins: [{ name: 'blue', attachments: { 'body-slot': { body: { type: 'region', path: 'body', width: 80, height: 100 } }, 'arm-slot': { arm: { type: 'region', path: 'body', width: 25, height: 65, y: 25 } } } }],
  animations: { idle: { bones: { body: { translate: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 0, y: 6 }, { time: 2, x: 0, y: 0 }] }, arm: { rotate: [{ time: 0, value: -15 }, { time: 1, value: 35 }, { time: 2, value: -15 }] } } } },
  animationDurations: { idle: 2 }, loopAnimations: ['idle'], textures: { body: 'body.png' }, bounds: { x: -65, y: 0, width: 150, height: 165 } };
document.skins.push({ ...structuredClone(document.skins[0]), name: 'alternate' });
const actor = await importSkeleton2d(project, { name: 'Demo robot', document, textures: [{ name: 'body.png', buffer: texture }] });
const alternate = structuredClone(document); alternate.skinBones = { blue: structuredClone(alternate.bones) }; alternate.skinBones.blue[2].rotation = 3; alternate.skinAnimations = { blue: { action: 'idle' } };
alternate.skins[0].attachments['body-slot'].body = { type: 'mesh', path: 'body', width: 80, height: 100,
  uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3],
  vertices: [1, 1, -40, 50, 1, 2, 1, 40, 50, 0.5, 2, -5, 35, 0.5, 1, 1, 40, -50, 1, 1, 1, -40, -50, 1] };
const secondActor = await importSkeleton2d(project, { name: 'Second actor', document: alternate, textures: [{ name: 'body.png', buffer: texture }] });
const report = { status: 'running', runRoot, projectRoot, checks: [], thumbnailChecks: [], canvasChecks: [], browserErrors: [], screenshots: [] };
let editor, chrome, cdp, stage = 'start';
const q = JSON.stringify, selector = id => `[data-testid="${id}"]`, wait = expr => waitForExpression(cdp, expr, 25000);
const read = expr => evaluate(cdp, expr);
const formReady = () => wait(`document.querySelector('[data-testid="s2d-canvas"]')?.dataset.ready === 'true' && document.querySelector('[data-testid="fwv-skeleton2d"]')?.inert === false`);
async function reveal(css) { await wait(`document.querySelector(${q(css)})`); await read(`(() => { const node=document.querySelector(${q(css)}); for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;node.scrollIntoView({block:'center'}); })()`); }
async function click(css) { await reveal(css); await wait(`!document.querySelector(${q(css)}).disabled`); await read(`document.querySelector(${q(css)}).click()`); }
async function fill(css, value) { await reveal(css); await read(`(() => {const node=document.querySelector(${q(css)});node.focus();node.value=${q(String(value))};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function set(id, value) { await fill(selector(id), value); }
async function saveDraft() { await click('#saveButton'); await wait('window.fwe.resources.current().dirty === false'); await formReady(); }
async function selectActor(assetId) { await click(`.collection-item[data-collection-id="skeleton2dDrafts"][data-item-id="${assetId}"]`); await wait(`document.querySelector('[data-testid="s2d-canvas"]')?.dataset.assetId===${q(assetId)}`); }
async function assertNativeThumbnail(presentation, assetId, revisionId) {
  const itemClass = presentation === 'grid' ? 'collection-grid-card' : 'collection-item';
  const css = `.${itemClass}[data-collection-id="skeleton2dDrafts"][data-item-id="${assetId}"] img.collection-thumbnail--${presentation}`;
  await reveal(css);
  await wait(`(() => { const image=document.querySelector(${q(css)});return image?.complete && image.naturalWidth>0 && image.naturalHeight>0; })()`);
  const image = await read(`(() => { const image=document.querySelector(${q(css)}),url=new URL(image.currentSrc || image.src,location.href);return {origin:url.origin,pageOrigin:location.origin,path:url.pathname,query:Object.fromEntries(url.searchParams),width:image.naturalWidth,height:image.naturalHeight,loading:image.loading}; })()`);
  assert.equal(image.origin, image.pageOrigin, 'Native actor thumbnails load from the same-origin framework API');
  assert.equal(image.path, '/api/fwv/skeleton2d-thumbnail', 'Native actor thumbnails use the assembled pose API instead of a component texture');
  assert.deepEqual(image.query, { assetId, revisionId }, 'The thumbnail must follow the exact native row revision');
  assert.equal(image.loading, 'lazy', 'FWE owns lazy image loading in detail lists and grids');
  report.thumbnailChecks.push({ stage, presentation, assetId, revisionId, width: image.width, height: image.height });
}
async function screenshot(name, css) {
  let clip;
  if (css) { await reveal(css); clip = await read(`(() => { const rect=document.querySelector(${q(css)}).getBoundingClientRect();return {x:rect.x+scrollX,y:rect.y+scrollY,width:rect.width,height:rect.height,scale:1}; })()`); }
  const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip } : {}) });
  const file = path.join(runRoot, `${name}.png`); await fs.writeFile(file, Buffer.from(result.data, 'base64')); report.screenshots.push(file);
}
async function clickCanvasPixel(id, locate) {
  const css = selector(id); await reveal(css);
  const point = await read(`(() => { const canvas=document.querySelector(${q(css)}),rect=canvas.getBoundingClientRect(),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    const local=(${locate})(pixels,canvas.width,canvas.height,rect);const x=rect.left+local.x/canvas.width*rect.width,y=rect.top+local.y/canvas.height*rect.height;
    return {x,y,visible:document.elementFromPoint(x,y)===canvas}; })()`);
  assert.equal(point.visible, true, 'The rendered canvas target must be visible for a real pointer click');
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}
async function verifyResponsiveCanvases() {
  const initialData = await read('JSON.stringify(window.fwe.resources.current().data)');
  for (const viewport of [{ width: 1500, height: 1050, deviceScaleFactor: 1 }, { width: 2200, height: 1200, deviceScaleFactor: 2 }, { width: 1000, height: 850, deviceScaleFactor: 2 }, { width: 1500, height: 1050, deviceScaleFactor: 1 }]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { ...viewport, mobile: false });
    await wait(`devicePixelRatio===${viewport.deviceScaleFactor} && ['s2d-canvas','s2d-timeline'].every(id=>{const canvas=document.querySelector('[data-testid="'+id+'"]'),rect=canvas?.getBoundingClientRect();return rect?.width>0 && canvas.width===Math.round(rect.width*devicePixelRatio) && canvas.height===Math.round(rect.height*devicePixelRatio);})`);
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const canvases = await read(`['s2d-canvas','s2d-timeline'].map(id=>{const canvas=document.querySelector('[data-testid="'+id+'"]'),rect=canvas.getBoundingClientRect(),context=canvas.getContext('2d'),matrix=context.getTransform();return {id,width:canvas.width,height:canvas.height,cssWidth:rect.width,cssHeight:rect.height,dpr:devicePixelRatio,font:context.font,transform:{a:matrix.a,b:matrix.b,c:matrix.c,d:matrix.d}};})`);
    for (const canvas of canvases) {
      assert.equal(canvas.width, Math.round(canvas.cssWidth * viewport.deviceScaleFactor));
      assert.equal(canvas.height, Math.round(canvas.cssHeight * viewport.deviceScaleFactor));
    }
    const timeline = canvases.find(canvas => canvas.id === 's2d-timeline');
    assert.ok(Math.abs(timeline.cssHeight - 112) < 0.1, 'Timeline rows retain a 112 CSS pixel drawing surface at every width and DPR');
    assert.equal(timeline.font, '12px sans-serif', 'Timeline text stays at its logical 12px font size');
    assert.ok(Math.abs(timeline.transform.a - viewport.deviceScaleFactor) < 0.01 && Math.abs(timeline.transform.d - viewport.deviceScaleFactor) < 0.01, 'Timeline applies DPR once without CSS stretching its font');
    assert.equal(timeline.transform.b, 0); assert.equal(timeline.transform.c, 0);
    await set('s2d-animation', ''); await set('s2d-bone', 'root');
    // Locate the rendered rightmost non-selected bone dot instead of repeating
    // the renderer's camera formula: in this fixture that is the arm bone.
    await clickCanvasPixel('s2d-canvas', `(pixels,width,height,rect)=>{
      const dots=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;if(pixels[i]===154&&pixels[i+1]===191&&pixels[i+2]===231&&pixels[i+3]===255)dots.push({x,y});}
      if(!dots.length)throw new Error('No non-selected bone dots were rendered');const right=Math.max(...dots.map(point=>point.x)),arm=dots.filter(point=>point.x>=right-8*width/rect.width);
      return {x:(Math.min(...arm.map(point=>point.x))+right+1)/2,y:(Math.min(...arm.map(point=>point.y))+Math.max(...arm.map(point=>point.y))+1)/2};}`);
    await wait(`document.querySelector('[data-testid="s2d-bone"]').value==='arm'`);
    await set('s2d-animation', 'idle'); await set('s2d-frame', -1); await set('s2d-seek', 0);
    // Find the three actual rotate diamonds by color, then click the middle
    // one. This checks input mapping against the pixels the user sees.
    await clickCanvasPixel('s2d-timeline', `(pixels,width,height,rect)=>{
      const columns=[];for(let x=0;x<width;x++){let found=false;for(let y=Math.floor(45*height/rect.height);y<Math.ceil(59*height/rect.height);y++){const i=(y*width+x)*4;if(pixels[i]===105&&pixels[i+1]===181&&pixels[i+2]===215&&pixels[i+3]===255){found=true;break;}}if(found)columns.push(x);}
      const groups=[];for(const x of columns){const last=groups.at(-1);if(!last||x-last.end>4*width/rect.width)groups.push({start:x,end:x});else last.end=x;}
      if(groups.length!==3)throw new Error('Expected three rendered rotate keyframes, found '+groups.length);return {x:(groups[1].start+groups[1].end+1)/2,y:52*height/rect.height};}`);
    await wait(`document.querySelector('[data-testid="s2d-frame"]').value==='1' && document.querySelector('[data-testid="s2d-channel"]').value==='rotate' && Number(document.querySelector('[data-testid="s2d-canvas"]').dataset.time)===1`);
    assert.equal(await read('window.fwe.resources.current().dirty'), false, 'Resizing and pointer selection remain read-only browsing');
    assert.equal(await read('document.querySelector("#undoButton").disabled'), true, 'Canvas resize and selection must not enter Undo history');
    assert.equal(await read('JSON.stringify(window.fwe.resources.current().data)'), initialData);
    report.canvasChecks.push({ viewport, canvases, selectedBone: 'arm', selectedFrame: 1, time: 1 });
    if (viewport.deviceScaleFactor === 2) await screenshot(`timeline-${viewport.width}-dpr2`, selector('s2d-timeline'));
  }
  await set('s2d-bone', 'body');
}
const record = name => { report.checks.push(name); console.log(`[skeleton2d] ${name}`); };
const draft = () => readAuthoring({ projectRoot, expectedProjectId: initial.id });
try {
  editor = await startEditor({ projectRoot, fwePath, port: 0 }); const port = await getFreePort(); chrome = startChrome(editor.url, port); const target = await waitForTarget(port, editor.url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  for (const domain of ['Runtime', 'Page', 'DOM', 'Network']) await cdp.call(domain + '.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1050, deviceScaleFactor: 1, mobile: false });
  await wait('window.fwe?.navigation && window.fwe.resources.current().domain?.id === "fwv-catalog" && window.fwe.resources.current().data?.images?.length === 2 && document.querySelector("#collectionSearch") && !document.querySelector("[aria-busy=true]")');
  await read("window.fwe.navigation.navigate({domainId:'fwv-authoring',fileName:'authoring.json',collectionId:'skeleton2dDrafts',mode:'edit'},{updateUrl:true})");
  await wait('document.querySelectorAll(\'.collection-item[data-collection-id="skeleton2dDrafts"]\').length === 2');
  await selectActor(actor.id);
  await wait(`document.querySelector('[data-testid="s2d-canvas"]')?.dataset.ready === 'true'`);
  for (const asset of [actor, secondActor]) await assertNativeThumbnail('list', asset.id, asset.selectedRevisionId);
  assert.equal(await read(`(() => { const c=document.querySelector('[data-testid="s2d-canvas"]'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let colored=0;for(let i=0;i<p.length;i+=4)if(p[i]===73&&p[i+1]===159&&p[i+2]===212&&p[i+3]===255)colored++;return colored>1000;})()`), true, 'A ready canvas must contain the actor pixels after all UI state updates');
  assert.equal(await read(`(() => { const c=document.querySelector('[data-testid="s2d-canvas"]'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let top=c.height,bottom=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(p[i]===73&&p[i+1]===159&&p[i+2]===212){top=Math.min(top,y);bottom=Math.max(bottom,y);}}return top>20&&bottom<c.height-20&&bottom-top>150;})()`), true, 'Zero-valued fixed camera origin preserves the full actor inside canvas margins');
  assert.equal(await read(`document.querySelectorAll('[data-testid="s2d-search"], [data-testid="s2d-asset"]').length`), 0, 'The professional form must not reimplement native FWE asset selection');
  assert.equal(await read(`document.querySelector('[data-testid="s2d-save-draft"]')`), null, 'Draft saving belongs to the native FWE toolbar');
  assert.equal(await read('typeof window.FwvPanels'), 'undefined', 'Professional forms use the native FWE registry');
  assert.equal(await read(`document.querySelector('[data-testid="s2d-bone"]').options.length`), 3);
  await screenshot('01-framework-actor'); record('Generic assets render in the native FWE 2D workspace without host names or assets');
  stage = 'native catalog'; await fill('#collectionSearch', 'Demo');
  assert.equal(await read(`document.querySelectorAll('.collection-item[data-collection-id="skeleton2dDrafts"]').length`), 1);
  await formReady(); await fill('#collectionSearch', ''); await formReady(); await click('#collectionGridButton');
  await wait('document.querySelectorAll(\'.collection-grid-card[data-collection-id="skeleton2dDrafts"]\').length === 2');
  for (const asset of [actor, secondActor]) await assertNativeThumbnail('grid', asset.id, asset.selectedRevisionId);
  await click(`.collection-grid-card[data-collection-id="skeleton2dDrafts"][data-item-id="${secondActor.id}"]`);
  await click('#collectionDetailButton'); await wait(`document.querySelector('[data-testid="s2d-canvas"]')?.dataset.assetId === ${q(secondActor.id)}`);
  await selectActor(actor.id); record('Native FWE search, detail list and grid own actor selection and load assembled pose thumbnails; the professional form only edits the selected actor');
  stage = 'native bone graph';
  assert.equal(await read(`document.querySelectorAll('[data-testid="s2d-bone-graph"] .fg-node').length`), 3);
  assert.equal(await read(`document.querySelectorAll('[data-testid="s2d-bone-graph"] [data-edge-id]').length`), 2);
  await click('[data-testid="s2d-bone-graph"] [data-node-id="arm"]');
  assert.equal(await read(`document.querySelector('[data-testid="s2d-bone"]').value`), 'arm');
  await set('s2d-bone', 'body');
  assert.equal(await read(`document.querySelector('[data-testid="s2d-bone-graph"] .is-selected').dataset.nodeId`), 'body');
  assert.equal(await read('window.fwe.resources.current().dirty'), false);
  await screenshot('02-native-bone-graph');
  record('Native FWE DAG displays bone parent relations and synchronizes selection without creating edits');
  stage = 'responsive canvases'; await verifyResponsiveCanvases();
  stage = 'playback';
  await set('s2d-animation', ''); await wait(`document.querySelector('[data-testid="s2d-canvas"]').dataset.animation === ''`);
  await set('s2d-animation', 'idle'); await click(selector('s2d-play')); await wait(`Number(document.querySelector('[data-testid="s2d-canvas"]').dataset.time) > 0.1`); await click(selector('s2d-play'));
  await set('s2d-speed', 0.5); await set('s2d-seek', 0.75); record('Setup pose, play/pause, speed and seek work; responsive DPR 1/2 canvases retain sharp timeline text and accurate keyframe/bone pointer selection without edits');
  await set('s2d-speed', 5);
  assert.equal(await read(`document.querySelector('[data-testid="s2d-speed"]').validity.rangeOverflow`), true);
  await set('s2d-seek', 0.75);
  assert.equal(await read(`document.querySelector('[data-testid="s2d-speed"]').value`), '0.5', 'Native validation rejects invalid speed without changing the playback state');
  stage = 'read-only browsing'; await set('s2d-skin', 'alternate'); await set('s2d-skin', 'blue'); await set('s2d-bone', 'arm'); await set('s2d-slot', 'arm-slot');
  await set('s2d-channel', 'rotate'); await set('s2d-frame', 1); await set('s2d-seek', 0.75); await click(selector('s2d-show-bones')); await click(selector('s2d-show-bones'));
  await read(`window.retiredSkeletonControls = ['s2d-canvas', 's2d-timeline'].map(id=>document.querySelector('[data-testid="'+id+'"]'))`);
  await selectActor(secondActor.id);
  assert.equal(await read(`(() => {const before=JSON.stringify(window.fwe.resources.current().data);window.retiredSkeletonControls.forEach(node=>node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:100,clientY:30})));delete window.retiredSkeletonControls;return JSON.stringify(window.fwe.resources.current().data)===before;})()`), true, 'Disposed canvas gestures cannot change another actor draft');
  await selectActor(actor.id);
  assert.equal(await read(`document.querySelector('[data-testid="s2d-bone"]').value`), 'arm', 'Browsing state is retained in memory across asset selection');
  assert.equal(await read('window.fwe.resources.current().dirty'), false, 'Skin, animation, bone, frame, seek, speed and display selection must not mark a draft dirty');
  assert.equal(await read('document.querySelector("#undoButton").disabled'), true, 'Browsing must not create Undo history entries');
  const catalog = await read('window.fwe.resources.current()');
  assert.equal(catalog.data.skeleton2dDrafts.length, 2, 'Read-only Source projects every registered actor into the native catalog');
  assert.equal(catalog.data.skeleton2dDrafts.every(entry => !entry.data.document), true);
  assert.equal((await draft()).data.skeleton2dDrafts.length, 0, 'Unedited native rows are derived and must not be persisted as drafts');
  assert.equal(await fs.access(path.join(projectRoot, '.fwv/editor-drafts.json')).then(() => true, () => false), false, 'Browsing must not create a persisted authoring file');
  record('Read-only character browsing stays clean and keeps view selection in memory without creating drafts or history');
  stage = 'bone history'; await set('s2d-bone', 'arm'); await set('s2d-seek', 0); await click(selector('s2d-play'));
  await wait(`Number(document.querySelector('[data-testid="s2d-canvas"]').dataset.time)>0.05`);
  await set('s2d-bone-rotation', '');
  await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await read(`document.querySelector('[data-testid="s2d-bone-rotation"]').value`), '', 'Focusing an edit field pauses playback before frame updates can overwrite typing');
  assert.equal(await read('window.fwe.resources.current().dirty'), false, 'Incomplete typing does not commit a draft');
  await set('s2d-bone-rotation', 12); await set('s2d-bone-rotation', 18);
  assert.equal(await read('window.fwe.resources.current().dirty'), true, 'A real bone edit still marks the FWE draft dirty');
  await click('#undoButton'); await wait(`document.querySelector('[data-testid="s2d-bone-rotation"]')?.value === '12'`);
  await click('#redoButton'); await wait(`document.querySelector('[data-testid="s2d-bone-rotation"]')?.value === '18'`);
  record('Bone setup edits participate in native FWE Undo and Redo');
  stage = 'native field validation'; await set('s2d-bone-rotation', 18.125);
  assert.equal(await read(`document.querySelector('[data-testid="s2d-bone-rotation"]').validity.stepMismatch`), false, 'Native validation must retain the skeleton format\'s arbitrary finite decimal precision');
  assert.equal(await read(`window.fwe.resources.current().data.skeleton2dDrafts.find(row=>row.id===${q(actor.id)}).data.document.bones.find(bone=>bone.name==='arm').rotation`), 18.125);
  await set('s2d-channel', 'rotate'); await set('s2d-frame-time', 0.125); await set('s2d-frame-time', '');
  assert.equal(await read(`document.querySelector('[data-testid="s2d-frame-time"]').required`), true);
  await click(selector('s2d-key-add'));
  assert.equal(await read(`document.querySelector('[data-testid="s2d-frame"]').options.length`), 4, 'Native form validity blocks an empty required keyframe time');
  record('Native field and form validity reject invalid playback and empty keyframe values while accepting finite decimal setup values');
  stage = 'keyframes'; await set('s2d-frame-time', 0.125); await set('s2d-frame-value', 48); await set('s2d-curve', 'stepped'); await click(selector('s2d-key-add'));
  await wait(`document.querySelector('[data-testid="s2d-frame"]').options.length === 5`);
  await set('s2d-frame-value', 52); await click(selector('s2d-key-update'));
  await set('s2d-channel', 'translate'); await set('s2d-frame-time', 0.75); await set('s2d-frame-x', 8); await set('s2d-frame-y', -3); await click(selector('s2d-key-add'));
  await set('s2d-channel', 'scale'); await set('s2d-frame-time', 0.75); await set('s2d-frame-x', 1.2); await set('s2d-frame-y', 0.9); await click(selector('s2d-key-add'));
  await set('s2d-channel', 'rotate'); await set('s2d-frame', 1);
  await saveDraft();
  let stored = (await draft()).data.skeleton2dDrafts.find(entry => entry.id === actor.id).data;
  assert.equal(stored.document.animations.idle.bones.arm.rotate[1].value, 52); assert.equal(stored.document.animations.idle.bones.arm.rotate[1].curve, 'stepped');
  assert.equal(stored.document.animations.idle.bones.arm.rotate[1].time, 0.125, 'Native draft save preserves sub-centisecond keyframe timing');
  assert.deepEqual(stored.document.animations.idle.bones.arm.translate[0], { time: 0.75, x: 8, y: -3, curve: 'linear' });
  assert.deepEqual(stored.document.animations.idle.bones.arm.scale[0], { time: 0.75, x: 1.2, y: 0.9, curve: 'linear' });
  assert.equal((await project.snapshot()).assets.find(asset => asset.id === actor.id).revisions.length, 1);
  record('Typed keyframe add/update and stepped interpolation persist as a draft without mutating assets');
  stage = 'reload'; await cdp.call('Page.reload', { ignoreCache: true }); await wait(`document.querySelector('[data-testid="s2d-bone-rotation"]')?.value === '18.125'`);
  assert.equal(await read(`document.querySelector('[data-testid="s2d-channel"]').value`), stored.channel);
  assert.deepEqual((await draft()).data.skeleton2dDrafts.find(entry=>entry.id===actor.id).data.document, stored.document);
  await set('s2d-channel', 'rotate'); await set('s2d-frame', 1);
  await wait(`document.querySelector('[data-testid="s2d-frame-value"]')?.value === '52'`); record('Full browser reload restores the native saved actor, bone and exact animation keyframe document');
  stage = 'binding'; await set('s2d-slot', 'arm-slot'); await set('s2d-slot-bone', 'body'); await set('s2d-part-rotation', 9); await set('s2d-part-x', 4);
  await saveDraft();
  stage = 'revision';
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*/api/fwv/commands', requestStage: 'Request' }] });
  const commandPaused = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Revision save command did not reach the transport')), 25000);
    cdp.on('Fetch.requestPaused', event => { clearTimeout(timer); resolve(event); });
  });
  const [, paused] = await Promise.all([click(selector('s2d-create-revision')), commandPaused]);
  assert.equal(JSON.parse(paused.request.postData).type, 'skeleton2d.save');
  assert.equal(await read(`document.querySelector('[data-testid="fwv-skeleton2d"]').inert`), true, 'The professional form cannot receive edits while its revision transaction is pending');
  await click(`.collection-item[data-collection-id="skeleton2dDrafts"][data-item-id="${secondActor.id}"]`);
  assert.equal(await read('window.fwe.resources.current().selection.itemId'), actor.id, 'A pending revision transaction keeps its selected native actor');
  const navigation = await read("window.fwe.navigation.navigate({domainId:'fwv-catalog',fileName:'catalog.json',collectionId:'images',mode:'preview'},{updateUrl:true})");
  assert.equal(navigation, false, 'A pending revision transaction blocks leaving the editor domain');
  assert.equal(await read('window.fwe.resources.current().domain.id'), 'fwv-authoring');
  await cdp.call('Fetch.continueRequest', { requestId: paused.requestId }); await cdp.call('Fetch.disable');
  await wait(`document.querySelector('[data-testid="s2d-canvas"]')?.dataset.ready === 'true' && document.querySelector('[data-testid="s2d-canvas"]').dataset.revisionId !== ${q(actor.selectedRevisionId)} && document.querySelector('[data-testid="s2d-revision"]').options.length === 2 && window.fwe.resources.current().dirty === false`);
  const updated = (await project.snapshot()).assets.find(asset => asset.id === actor.id); assert.equal(updated.revisions.length, 2); assert.notEqual(updated.selectedRevisionId, actor.selectedRevisionId);
  assert.equal(await read(`window.fwe.resources.current().data.skeleton2dDrafts.find(row=>row.id===${q(actor.id)}).revisionLabel`), 'v2');
  await assertNativeThumbnail('list', actor.id, updated.selectedRevisionId);
  record('Revision save holds native actor/domain selection until exact-version readback and draft persistence complete');
  const readback = await inspectSkeleton2d(project, { assetId: actor.id, revisionId: updated.selectedRevisionId });
  assert.equal(readback.document.bones.find(bone => bone.name === 'arm').rotation, 18.125); assert.equal(readback.document.slots[1].bone, 'body'); assert.equal(readback.document.skins[0].attachments['arm-slot'].arm.rotation, 9);
  assert.equal(readback.document.animations.idle.bones.arm.rotate[1].time, 0.125);
  await click('#undoButton'); await wait(`document.querySelector('[data-testid="s2d-canvas"]')?.dataset.revisionId === ${q(actor.selectedRevisionId)}`);
  assert.equal(await read(`window.fwe.resources.current().data.skeleton2dDrafts.find(row=>row.id===${q(actor.id)}).data.revisionId`), actor.selectedRevisionId, 'Undo restores the native draft revision identity');
  assert.equal(await read(`window.fwe.resources.current().data.skeleton2dDrafts.find(row=>row.id===${q(actor.id)}).revisionLabel`), 'v1', 'Undo restores the corresponding native version label');
  await assertNativeThumbnail('list', actor.id, actor.selectedRevisionId);
  await click('#redoButton'); await wait(`document.querySelector('[data-testid="s2d-canvas"]')?.dataset.revisionId === ${q(updated.selectedRevisionId)}`);
  assert.equal(await read(`window.fwe.resources.current().data.skeleton2dDrafts.find(row=>row.id===${q(actor.id)}).data.revisionId`), updated.selectedRevisionId, 'Redo restores the new revision without a stale view selection overriding history');
  assert.equal(await read(`window.fwe.resources.current().data.skeleton2dDrafts.find(row=>row.id===${q(actor.id)}).revisionLabel`), 'v2', 'Redo restores the new native version label');
  await assertNativeThumbnail('list', actor.id, updated.selectedRevisionId);
  await saveDraft();
  await click('#collectionGridButton');
  await assertNativeThumbnail('grid', actor.id, updated.selectedRevisionId);
  await assertNativeThumbnail('grid', secondActor.id, secondActor.selectedRevisionId);
  await click('#collectionDetailButton'); await formReady();
  record('Part binding/transforms create a distinct immutable revision with exact readback; native thumbnails follow creation, Undo/Redo and grid remount');
  stage = 'export'; await click(selector('s2d-export')); await wait(`document.querySelector('[data-testid="s2d-status"]').textContent.includes('已导出')`); assert.equal((await project.snapshot()).exports.length, 1);
  await read(`document.querySelector('[data-testid="fwv-skeleton2d"]').scrollIntoView()`); await screenshot('02-edited-and-exported'); record('The verified exact actor revision exports through the framework application command');
  stage = 'delete history'; await set('s2d-bone', 'arm'); await set('s2d-channel', 'rotate'); await set('s2d-frame', 1); await click(selector('s2d-key-delete')); await wait(`document.querySelector('[data-testid="s2d-frame"]').options.length === 4`);
  await click('#undoButton'); await wait(`document.querySelector('[data-testid="s2d-frame"]').options.length === 5`); record('Keyframe deletion is reversible through the FWE history');
  stage = 'skin overrides'; await selectActor(secondActor.id); await wait(`document.querySelector('[data-testid="s2d-animation"]').options.length === 3`);
  await set('s2d-animation', 'action'); await set('s2d-bone', 'arm'); await wait(`document.querySelector('[data-testid="s2d-bone-rotation"]').value === '3'`);
  await set('s2d-bone-rotation', 33); await saveDraft();
  const alternateDraft = (await draft()).data.skeleton2dDrafts.find(entry => entry.id === secondActor.id).data;
  assert.equal(alternateDraft.document.skinBones.blue[2].rotation, 33); assert.equal(alternateDraft.document.bones[2].rotation, undefined);
  assert.equal(alternateDraft.animation, 'action'); record('Independent actor drafts preserve animation aliases and edit the active skin setup without changing shared bones');
  stage = 'weighted mesh'; await set('s2d-slot', 'body-slot'); await set('s2d-mesh-vertex', 0);
  const meshPart = `window.fwe.resources.current().data.skeleton2dDrafts.find(row=>row.id===${q(secondActor.id)}).data.document.skins[0].attachments['body-slot'].body`;
  const meshBefore = await read(`JSON.stringify(${meshPart})`);
  assert.deepEqual(JSON.parse(await read(`document.querySelector('[data-testid="s2d-mesh-influences"]').value`)), [{ bone: 'body', x: -40, y: 50, weight: 1 }]);
  await set('s2d-mesh-influences', JSON.stringify([{ bone: 'body', x: -32, y: 50, weight: 0.4 }]));
  await click(selector('s2d-mesh-apply-vertex'));
  assert.equal(await read(`document.querySelector('[data-testid="s2d-status"]').dataset.error`), 'true');
  assert.equal(await read(`JSON.stringify(${meshPart})`), meshBefore, 'Invalid vertex weight transaction leaves the previous document intact');
  assert.equal(await read('window.fwe.resources.current().dirty'), false);
  await set('s2d-mesh-influences', JSON.stringify([{ bone: 'body', x: -32, y: 50, weight: 0.5 }, { bone: 'root', x: -32, y: 100, weight: 0.5 }]));
  await click(selector('s2d-mesh-apply-vertex'));
  assert.equal(await read('window.fwe.resources.current().dirty'), true);
  assert.deepEqual(await read(`${meshPart}.vertices.slice(0,9)`), [2, 1, -32, 50, 0.5, 0, -32, 100, 0.5]);
  await click('#undoButton'); await formReady(); assert.equal(await read(`JSON.stringify(${meshPart})`), meshBefore);
  await click('#redoButton'); await formReady();
  await saveDraft(); await set('s2d-animation', ''); await set('s2d-slot', 'body-slot'); await set('s2d-mesh-vertex', 0);
  assert.deepEqual((await draft()).data.skeleton2dDrafts.find(row => row.id === secondActor.id).data.document.skins[0].attachments['body-slot'].body.vertices.slice(0,9), [2, 1, -32, 50, 0.5, 0, -32, 100, 0.5]);
  await screenshot('03-weighted-mesh-editor');
  record('Weighted mesh renders in the professional Canvas; native vertex fields reject invalid weights atomically, preserve valid edits, and participate in Undo/Redo and draft saving');
  assert.equal(report.browserErrors.length, 0, report.browserErrors.join('\n')); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.stage = stage; report.error = error.stack; process.exitCode = 1; console.error(error); if (cdp) try { await screenshot('failure'); report.pageText = await read('document.body.innerText'); } catch {} }
finally { cdp?.close(); if (chrome) await stopProcess(chrome); if (editor) await editor.close(); report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') })); }
