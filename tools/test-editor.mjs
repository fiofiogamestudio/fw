// Optional cross-component browser acceptance, using an isolated Chrome profile
// and a disposable FWA project. Never connects to a user's browser session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { git } from '../src/process.mjs';
import { FwaApplication } from '../fwa/src/application/fwa-application.js';
import { startEditor } from '../fwa/src/editor/server.js';
import '../test/environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require('../fwe/test/browser-smoke.js');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'fw-editor-evidence-'));
fs.mkdirSync(output, { recursive: true });
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-editor-project-'));
let chrome;
let cdp;
let editor;
const errors = [];
const cases = [];
try {
  git(project, ['init', '-b', 'main']);
  const app = new FwaApplication(project);
  await app.init();
  await app.createGoal({ title: '验证同级组件控制台', request: '验证固定工程、只读状态与受控命令。', commandId: 'browser-fixture-goal' });
  const before = (await app.getStatus()).lastSequence;
  editor = await startEditor({ projectRoot: project, fwePath: path.join(root, 'fwe'), port: 0 });
  const debugPort = await getFreePort();
  chrome = startChrome(editor.url, debugPort);
  const target = await waitForTarget(debugPort, editor.url, 15_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await waitForExpression(cdp, 'document.querySelector("[data-testid=fwa-mode]") && !document.querySelector("[data-testid=fwa-refresh]").disabled', 15_000);
  assert.equal(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-status]").dataset.error'), 'false');
  const sections = ['project', 'goals', 'nodes', 'runs', 'evidence', 'changeSets', 'refs', 'integrations', 'reversions', 'operational'];
  for (const section of sections) {
    await evaluate(cdp, `document.querySelector('[data-section="${section}"]').click()`);
    assert.equal(await evaluate(cdp, `document.querySelector('[data-section="${section}"]').getAttribute('aria-selected')`), 'true');
    assert.equal(await evaluate(cdp, 'document.querySelectorAll(".fwa-form").length'), 0);
  }
  assert.equal((await app.getStatus()).lastSequence, before);
  cases.push('Read-only mode: ten sections navigate, no command forms, persisted event sequence unchanged.');
  await evaluate(cdp, 'document.querySelector("[data-section=goals]").click()');
  assert.match(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-content]").textContent'), /验证同级组件控制台/);
  fs.writeFileSync(path.join(output, 'readonly.png'), Buffer.from((await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  await editor.close();
  editor = await startEditor({ projectRoot: project, fwePath: path.join(root, 'fwe'), port: 0, allowWrite: true });
  await cdp.call('Page.navigate', { url: editor.url });
  await waitForExpression(cdp, 'document.querySelector("[data-testid=fwa-mode]") && !document.querySelector("[data-testid=fwa-refresh]").disabled', 15_000);
  await evaluate(cdp, 'document.querySelector("[data-section=goals]").click()');
  await waitForExpression(cdp, `document.querySelector('form[data-testid="fwa-goal.create"]')`, 10_000);
  await evaluate(cdp, `(() => {
    const form = document.querySelector('form[data-testid="fwa-goal.create"]');
    form.elements.title.value = '浏览器创建的真实目标';
    form.elements.request.value = '<img src=x onerror="window.fwaInjected=true">';
    form.requestSubmit();
  })()`);
  await waitForExpression(cdp, 'document.querySelector("[data-testid=fwa-content]").textContent.includes("浏览器创建的真实目标") && !document.querySelector("[data-testid=fwa-refresh]").disabled', 15_000);
  const after = await app.getStatus();
  assert.equal(after.goals.length, 2);
  assert.equal(after.goals.filter(goal => goal.title === '浏览器创建的真实目标').length, 1);
  assert.equal(await evaluate(cdp, 'window.fwaInjected === true'), false);
  assert.equal(await evaluate(cdp, 'document.querySelectorAll(".fwa-console img").length'), 0);
  cases.push('Controlled write mode: real goal form persisted exactly one goal; untrusted request rendered as text.');
  // Simulate a lost response *after* the server has committed. Then navigate
  // away, refresh and retry the same user input through the real UI.
  await evaluate(cdp, `(() => {
    const originalFetch = window.fetch;
    let loseOneResponse = true;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (loseOneResponse && args[0] === '/api/fwa/commands') {
        loseOneResponse = false;
        throw new TypeError('Simulated lost command response');
      }
      return response;
    };
    document.querySelector('[data-section=goals]').click();
    const form = document.querySelector('form[data-testid="fwa-goal.create"]');
    form.elements.title.value = '丢失响应后仍只创建一次';
    form.elements.request.value = '导航和刷新不能丢掉未确认的命令 ID';
    form.requestSubmit();
  })()`);
  await waitForExpression(cdp, 'document.querySelector("[data-testid=fwa-status]").dataset.error === "true"', 15_000);
  assert.equal((await app.getStatus()).goals.length, 3);
  await evaluate(cdp, `document.querySelector('[data-section=project]').click(); document.querySelector('[data-testid=fwa-refresh]').click();`);
  await waitForExpression(cdp, '!document.querySelector("[data-testid=fwa-refresh]").disabled', 15_000);
  await evaluate(cdp, `(() => {
    document.querySelector('[data-section=goals]').click();
    const form = document.querySelector('form[data-testid="fwa-goal.create"]');
    form.elements.title.value = '丢失响应后仍只创建一次';
    form.elements.request.value = '导航和刷新不能丢掉未确认的命令 ID';
    form.requestSubmit();
  })()`);
  await waitForExpression(cdp, 'document.querySelector("[data-testid=fwa-status]").textContent.includes("goal.create 已记录") && !document.querySelector("[data-testid=fwa-refresh]").disabled', 15_000);
  assert.equal((await app.getStatus()).goals.length, 3, 'Retry must reuse the unresolved command ID across navigation/refresh.');
  cases.push('Lost committed response followed by tab change, refresh and identical retry creates no duplicate goal.');
  fs.writeFileSync(path.join(output, 'controlled-write.png'), Buffer.from((await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
  const overflow = await evaluate(cdp, 'document.documentElement.scrollWidth > innerWidth + 2');
  assert.equal(overflow, false, 'Desktop 1024px page should not overflow horizontally.');
  fs.writeFileSync(path.join(output, 'desktop-1024.png'), Buffer.from((await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  assert.deepEqual(errors, []);
  cases.push('1440px and 1024px screenshots captured; no runtime exceptions or whole-page horizontal overflow.');
  const result = { ok: true, cases, screenshots: ['readonly.png', 'controlled-write.png', 'desktop-1024.png'], output };
  fs.writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  cdp?.close();
  await stopProcess(chrome);
  await editor?.close();
  fs.rmSync(project, { recursive: true, force: true });
}
