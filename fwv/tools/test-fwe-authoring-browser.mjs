import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FwvProject } from '../src/core/project.mjs';
import { importSpine } from '../src/spine/application.mjs';
import { createReskinFixture } from '../examples/reskin-fixture/create.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { readAuthoring, writeAuthoring } from '../src/editor/authoring.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), fwePath = fileURLToPath(new URL('../../fwe', import.meta.url));
const require = createRequire(import.meta.url);
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test/browser-smoke.js'));
const output = path.join(root, '.local/reports/fwe-authoring-browser'); await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project');
const project = new FwvProject(projectRoot); const initial = await project.init({ name: 'FWE 原生草稿生命周期验收' });
const fixture = await createReskinFixture();
await importSpine(project, fixture);
await project.importImage({ name: '图片配方草稿源图', fileName: 'parts.png', buffer: fixture.page });
const originalAssets = JSON.stringify((await project.snapshot()).assets);
const report = { status: 'running', runRoot, projectRoot, checks: [], browserErrors: [], screenshots: [], writes: [], modelCalls: 0 };
const q = JSON.stringify, selector = id => `[data-testid="${id}"]`;
let editor, chrome, cdp, stage = 'start', expectedConflict = false;
const wait = expr => waitForExpression(cdp, expr, 25000);
async function evalValue(expr) { return evaluate(cdp, expr); }
async function reveal(css) {
  await wait(`document.querySelector(${q(css)})`);
  await evaluate(cdp, `(() => {const node=document.querySelector(${q(css)}),details=[];for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open)details.unshift(parent);for(const parent of details)parent.querySelector(':scope > summary').click();node.scrollIntoView({block:'center'});})()`);
  await wait(`document.querySelector(${q(css)})?.getClientRects().length > 0`);
}
async function fill(id, value) { await reveal(selector(id));
  await wait(`document.querySelector(${q(selector(id))}) && !document.querySelector(${q(selector(id))}).disabled`);
  await evalValue(`(() => {const el=document.querySelector(${q(selector(id))});el.focus();el.value=${q(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function click(css) { await reveal(css); await wait(`document.querySelector(${q(css)}) && !document.querySelector(${q(css)}).disabled`); await evalValue(`document.querySelector(${q(css)}).click()`); }
async function panel(id) {
  await wait("window.fwe?.navigation && document.readyState === 'complete'");
  const collections = { reskin: 'reskinDrafts', rig: 'rigDrafts', images: 'imageDrafts', generate: 'generationDrafts', spine: 'spineDrafts' };
  await evalValue(`window.fwe.navigation.navigate({domainId:'fwv-authoring',fileName:'authoring.json',collectionId:${q(collections[id])},mode:'detail'},{updateUrl:true})`);
}
async function key(letter, modifiers = 2) {
  const code = letter.charCodeAt(0); await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: letter.toLowerCase(), code: `Key${letter}`, modifiers, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: letter.toLowerCase(), code: `Key${letter}`, modifiers, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}
async function saved() { await wait(`window.fwe.resources.current().dirty === false && window.fwe.resources.current().file.exists === true`); }
const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log(`[FWE authoring] ${name}`); };
async function screenshot(name) { const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const target = path.join(runRoot, name + '.png'); await fs.writeFile(target, Buffer.from(result.data, 'base64')); report.screenshots.push(target); }
const authoring = () => readAuthoring({ projectRoot, expectedProjectId: initial.id });
let reloadSequence = 0;
async function reload() {
  const nonce = ++reloadSequence;
  await evalValue(`window.__fwvReloadNonce = ${nonce}`);
  await cdp.call('Page.reload', { ignoreCache: true });
  await wait(`window.__fwvReloadNonce !== ${nonce} && window.fwe?.navigation && document.readyState === 'complete'`);
}
try {
  editor = await startEditor({ projectRoot, fwePath, port: 0 });
  const port = await getFreePort(); chrome = startChrome(editor.url, port); const target = await waitForTarget(port, editor.url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Network.requestWillBeSent', event => { if (['POST', 'PUT', 'DELETE'].includes(event.request.method)) report.writes.push({ method: event.request.method, url: event.request.url, body: event.request.postData }); });
  cdp.on('Log.entryAdded', event => { if (event.entry?.level === 'error' && !(expectedConflict && /409/.test(event.entry.text))) report.browserErrors.push(event.entry.text); });
  for (const domain of ['Runtime', 'Page', 'DOM', 'Network', 'Log']) await cdp.call(domain + '.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1150, deviceScaleFactor: 1, mobile: false });
  const delayedSnapshot = await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const fetchOriginal = window.fetch;
    let pending = true;
    const gate = new Promise(resolve => { window.__fwvReleaseSnapshot = resolve; });
    window.fetch = function(input, ...args) {
      if (pending && String(input).endsWith('/api/fwv/snapshot')) {
        pending = false; window.__fwvSnapshotWaiting = true;
        return gate.then(() => fetchOriginal.call(this, input, ...args));
      }
      return fetchOriginal.call(this, input, ...args);
    };
  })();` });
  await reload();
  await wait(`window.__fwvSnapshotWaiting && document.querySelector('[data-testid="fwv-workbench"]')`);
  await panel('generate');
  await evalValue('window.__fwvReleaseSnapshot()');
  await wait(`document.querySelector('[data-testid="fwv-generation-prompt"]')`);
  assert.equal(await evalValue('window.fwe.navigation.current().collectionId'), 'generationDrafts');
  await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: delayedSnapshot.identifier });
  record('Navigation while the initial asset snapshot is delayed mounts the latest selected panel');
  await panel('reskin');
  await wait(`document.querySelector(${q(selector('fwv-reskin-name'))}) && !document.querySelector(${q(selector('fwv-reskin-name'))}).disabled`);
  assert.equal(await evalValue(`window.fwe.resources.current().domain.id`), 'fwv-authoring');
  assert.equal(await evalValue(`window.fwe.resources.current().file.name`), 'authoring.json');
  record('Workspace opens the typed FWE authoring resource through the registered workbench layout');

  stage = 'new plan history';
  await fill('fwv-reskin-name', '尚未创建的角色'); await fill('fwv-reskin-brief', '测试草稿 A'); await fill('fwv-reskin-brief', '测试草稿 B');
  assert.equal(await evalValue(`window.fwe.resources.current().dirty`), true);
  await click('#undoButton'); await wait(`document.querySelector(${q(selector('fwv-reskin-brief'))})?.value === '测试草稿 A'`);
  await click('#redoButton'); await wait(`document.querySelector(${q(selector('fwv-reskin-brief'))})?.value === '测试草稿 B'`);
  record('A not-yet-created plan participates in FWE dirty state, Undo and Redo');

  stage = 'navigation'; await panel('generate'); await fill('fwv-generation-name', '图标草稿'); await fill('fwv-generation-prompt', '纯测试提示词，不调用模型');
  await panel('reskin'); await wait(`document.querySelector(${q(selector('fwv-reskin-name'))})?.value === '尚未创建的角色'`);
  assert.equal(await evalValue(`window.fwe.navigation.current().collectionId`), 'reskinDrafts');
  assert.match(await evalValue('location.href'), /fweCollection=reskinDrafts/);
  record('FWE collection navigation retains unsaved drafts across panels and updates the resource URL');

  stage = 'native save'; await key('S');
  await wait(`document.querySelector('#statusText').textContent.includes('保存')`);
  const saveStatus = await evalValue(`document.querySelector('#statusText').textContent`);
  if (saveStatus.includes('阻止')) {
    report.diagnostics = await evalValue(`typeof validateCurrent === 'function' ? validateCurrent() : {resource:window.fwe.resources.current(),domain:window.fwe.context().domain}`);
    throw new Error(saveStatus);
  }
  await saved();
  let disk = await authoring(); assert.equal(disk.data.reskinDrafts.find(x => x.id === 'new').data.brief, '测试草稿 B');
  assert.equal(disk.data.generationDrafts[0].data.prompt, '纯测试提示词，不调用模型');
  assert.equal(JSON.stringify((await project.snapshot()).assets), originalAssets);
  assert.ok(report.writes.length > 0); assert.ok(report.writes.every(x => x.method === 'PUT' && x.url.endsWith('/api/domains/fwv-authoring/files/authoring.json')));
  record('Ctrl+S saves both drafts through FWE Source with no asset mutation or generation command');
  await screenshot('01-fwe-save-history');

  stage = 'reload'; await cdp.call('Page.reload', { ignoreCache: true });
  await wait(`document.querySelector(${q(selector('fwv-reskin-brief'))})?.value === '测试草稿 B'`);
  await panel('generate'); await wait(`document.querySelector(${q(selector('fwv-generation-prompt'))})?.value === '纯测试提示词，不调用模型'`);
  record('Saved new-plan and image-generation parameters survive a full browser reload');

  stage = 'configured native controls';
  assert.equal(await evalValue(`document.querySelector('[data-testid="fwv-parameters"]') === null && document.querySelector('button[data-panel]') === null`), true);
  assert.equal(await evalValue(`document.querySelector('[data-testid="fwv-generation-prompt"]').maxLength`), 8000);
  assert.equal(await evalValue(`document.querySelector('[data-testid="fwv-generation-prompt"]').closest('.fwe-surface-field') !== null`), true);
  assert.deepEqual(await evalValue(`Array.from(document.querySelector('[data-testid="fwv-generation-quality"]').options).map(x=>x.value)`), ['auto','low','medium','high','standard','hd']);
  await fill('fwv-generation-prompt', 'FWE 配置表单修改的提示词');
  await fill('fwv-generation-quality', 'hd');
  await key('S'); await saved();
  await cdp.call('Page.reload', { ignoreCache: true });
  await wait(`document.querySelector('[data-testid="fwv-generation-quality"]')?.value === 'hd'`);
  await wait(`document.querySelector('[data-testid="fwv-generation-prompt"]')?.value === 'FWE 配置表单修改的提示词'`);
  await screenshot('02-configured-parameter-form');
  record('Main form uses FWE controls and compiled limits; hd quality survives save and reload without duplicate parameter navigation');

  stage = 'image recipe history'; await panel('images');
  await fill('fwv-fit', 'cover');
  await fill('fwv-width', '192'); await fill('fwv-width', '320');
  await click('#undoButton'); await wait(`document.querySelector(${q(selector('fwv-width'))})?.value === '192'`);
  await click('#redoButton'); await wait(`document.querySelector(${q(selector('fwv-width'))})?.value === '320'`);
  await key('S'); await saved(); await cdp.call('Page.reload', { ignoreCache: true });
  await wait(`document.querySelector(${q(selector('fwv-width'))})?.value === '320'`);
  assert.equal((await authoring()).data.imageDrafts[0].data.recipe.width, 320);
  assert.equal((await authoring()).data.imageDrafts[0].data.recipe.fit, 'cover');
  assert.equal(await evalValue(`document.querySelector('[data-testid="fwv-fit"]').value`), 'cover');
  record('Image recipe edits support FWE Undo/Redo and reload without processing an asset');

  stage = 'Spine transform history'; await panel('spine');
  await wait(`document.querySelector(${q(selector('fwv-spine-asset'))})?.value && document.querySelector(${q(selector('fwv-spine-animation'))})?.options.length > 1`);
  await fill('fwv-spine-scale', '1.2'); await fill('fwv-spine-scale', '1.4');
  await click('#undoButton'); await wait(`document.querySelector(${q(selector('fwv-spine-scale'))})?.value === '1.2'`);
  await click('#redoButton'); await wait(`document.querySelector(${q(selector('fwv-spine-scale'))})?.value === '1.4'`);
  await key('S'); await saved(); await cdp.call('Page.reload', { ignoreCache: true });
  await wait(`document.querySelector(${q(selector('fwv-spine-scale'))})?.value === '1.4'`);
  assert.equal((await authoring()).data.spineDrafts[0].data.transform.scale, 1.4);
  record('Spine part transforms support FWE Undo/Redo and reload without creating a replacement version');
  await panel('reskin');

  stage = 'external conflict'; disk = await authoring(); const external = structuredClone(disk.data); external.reskinDrafts.find(x => x.id === 'new').data.brief = '另一个进程的已保存修改';
  await writeAuthoring({ projectRoot, expectedProjectId: initial.id, payload: { data: external, revision: disk.revision } });
  await fill('fwv-reskin-brief', '当前窗口尚未保存的修改'); expectedConflict = true; await key('S');
  await wait(`document.querySelector('#statusText').textContent.includes('失败')`);
  assert.equal(await evalValue(`document.querySelector(${q(selector('fwv-reskin-brief'))}).value`), '当前窗口尚未保存的修改');
  assert.equal(await evalValue(`window.fwe.resources.current().dirty`), true);
  assert.equal((await authoring()).data.reskinDrafts.find(x => x.id === 'new').data.brief, '另一个进程的已保存修改');
  await screenshot('03-native-save-conflict'); record('A stale FWE save receives a conflict, preserves local dirty input and does not overwrite the external version');

  assert.equal(JSON.stringify((await project.snapshot()).assets), originalAssets);
  assert.ok(report.writes.every(x => x.method === 'PUT' && x.url.endsWith('/api/domains/fwv-authoring/files/authoring.json')));
  assert.equal(report.browserErrors.length, 0, report.browserErrors.join('\n'));
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.stage = stage; report.error = error.stack; process.exitCode = 1; console.error(error); if(cdp) try{await screenshot('failure'); report.pageText=await evalValue('document.body.innerText');}catch{} }
finally { if(cdp)cdp.close(); if(chrome)await stopProcess(chrome); if(editor)await editor.close(); report.finishedAt=new Date().toISOString(); await fs.writeFile(path.join(runRoot,'report.json'),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify({status:report.status,report:path.join(runRoot,'report.json')})); }
