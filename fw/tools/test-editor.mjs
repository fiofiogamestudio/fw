// Optional cross-component browser acceptance, using an isolated Chrome profile
// and a disposable FWA project. Never connects to a user's browser session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { git } from '../src/process.mjs';
import { FwaApplication } from '../../fwa/src/application/fwa-application.js';
import { startEditor } from '../../fwa/src/editor/server.js';
import '../test/environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require('../../fwe/test/browser-smoke.js');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'fw-editor-evidence-'));
fs.mkdirSync(output, { recursive: true });
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-editor-project-'));
let chrome;
let cdp;
let editor;
const errors = [];
const cases = [];
let workbench = false;
const ready = `document.querySelector('[data-testid=fwa-mode]') && document.querySelector('[data-testid=fwa-refresh]')?.matches(':enabled')
  && !document.querySelector('[data-fwa-workbench]')?.matches(':disabled')`;
async function waitReady() { await waitForExpression(cdp, ready, 15_000); }
async function section(name) {
  await waitReady();
  const selector = `[data-section="${name}"]`;
  await evaluate(cdp, `(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    const details = button.closest('details');
    if (details && !details.open) details.querySelector('summary').click();
    if (!button.getClientRects().length) throw new Error('Navigation button is not visible');
    button.click();
  })()`);
  const selectedAttribute = workbench ? 'aria-pressed' : 'aria-selected';
  await waitForExpression(cdp, `${ready} && document.querySelector(${JSON.stringify(selector)})?.getAttribute('${selectedAttribute}') === 'true'`, 15_000);
}
async function goalForm() {
  await section(workbench ? 'commands' : 'goals');
  await waitForExpression(cdp, `document.querySelector('form[data-testid="fwa-goal.create"] button[type=submit]')?.matches(':enabled')`, 10_000);
}
async function submitGoal(title, request) {
  await evaluate(cdp, `(() => {
    const form = document.querySelector('form[data-testid="fwa-goal.create"]');
    for (const [name, value] of Object.entries(${JSON.stringify({ title, request })})) {
      form.elements[name].value = value;
      form.elements[name].dispatchEvent(new Event('input', { bubbles: true }));
    }
    form.requestSubmit();
  })()`);
}
async function waitGoalRecorded() {
  const status = workbench ? `document.querySelector('form[data-testid="fwa-goal.create"] [role=status]')` : `document.querySelector('[data-testid=fwa-status]')`;
  await waitForExpression(cdp, `${status}?.textContent.includes('已记录') && ${ready}
    && document.querySelector('form[data-testid="fwa-goal.create"] button[type=submit]')?.matches(':enabled')`, 15_000);
}
async function showGoals() {
  await section(workbench ? 'project' : 'goals');
  if (workbench) {
    await evaluate(cdp, `(() => {
      const select = document.querySelector('select[aria-label="当前目标"]');
      select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitReady();
  }
}
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
  await waitReady();
  workbench = await evaluate(cdp, 'Boolean(document.querySelector("[data-fwa-workbench]"))');
  assert.equal(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-status]").dataset.error'), 'false');
  const sections = workbench
    ? ['intake', 'changeSets', 'progress', 'nodes', 'refs', 'runs', 'evidence', 'events', 'project', 'commands']
    : ['project', 'goals', 'nodes', 'runs', 'evidence', 'changeSets', 'refs', 'integrations', 'reversions', 'operational'];
  for (const name of sections) {
    await section(name);
    assert.equal(await evaluate(cdp, 'document.querySelectorAll(".fwa-form, form[data-command-type]").length'), 0);
    assert.equal(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-status]").dataset.error'), 'false');
  }
  assert.equal((await app.getStatus()).lastSequence, before);
  cases.push(`Read-only mode: all ${sections.length} ${workbench ? 'workbench' : 'legacy console'} sections navigate, no command forms, persisted event sequence unchanged.`);
  await showGoals();
  assert.match(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-content]").textContent'), /验证同级组件控制台/);
  if (workbench) {
    const facts = await evaluate(cdp, 'document.querySelector("[data-testid=fwa-content]").textContent');
    for (const label of ['集成历史', '回滚历史', 'Fence / Lease']) assert.ok(facts.includes(label), `Project section retains ${label}.`);
  }
  fs.writeFileSync(path.join(output, 'readonly.png'), Buffer.from((await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  await editor.close();
  editor = await startEditor({ projectRoot: project, fwePath: path.join(root, 'fwe'), port: 0, allowWrite: true });
  await cdp.call('Page.navigate', { url: editor.url });
  await waitReady();
  await goalForm();
  await submitGoal('浏览器创建的真实目标', '<img src=x onerror="window.fwaInjected=true">');
  await waitGoalRecorded();
  await showGoals();
  await waitForExpression(cdp, 'document.querySelector("[data-testid=fwa-content]").textContent.includes("浏览器创建的真实目标")', 15_000);
  const after = await app.getStatus();
  assert.equal(after.goals.length, 2);
  assert.equal(after.goals.filter(goal => goal.title === '浏览器创建的真实目标').length, 1);
  assert.equal(await evaluate(cdp, 'window.fwaInjected === true'), false);
  assert.match(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-content]").textContent'), /<img src=x onerror="window.fwaInjected=true">/);
  assert.equal(await evaluate(cdp, 'document.querySelectorAll(".fwa-console img, [data-testid=fwa-console] img").length'), 0);
  cases.push('Controlled write mode: real goal form persisted exactly one goal; untrusted request rendered as text.');
  // Simulate a lost response *after* the server has committed. Then navigate
  // away, refresh and retry the same user input through the real UI.
  await goalForm();
  await evaluate(cdp, `(() => {
    const originalFetch = window.fetch;
    let loseOneResponse = true;
    window.fwAcceptanceRetriedCommands = [];
    window.fetch = async (...args) => {
      if (args[0] === '/api/fwa/commands') window.fwAcceptanceRetriedCommands.push(JSON.parse(args[1].body));
      const response = await originalFetch(...args);
      if (loseOneResponse && args[0] === '/api/fwa/commands') {
        loseOneResponse = false;
        throw new TypeError('Simulated lost command response');
      }
      return response;
    };
  })()`);
  await submitGoal('丢失响应后仍只创建一次', '导航和刷新不能丢掉未确认的命令 ID');
  await waitForExpression(cdp, workbench
    ? `document.querySelector('form[data-testid="fwa-goal.create"] [role=status]')?.textContent.includes('Simulated lost command response')`
    : 'document.querySelector("[data-testid=fwa-status]").dataset.error === "true"', 15_000);
  assert.equal((await app.getStatus()).goals.length, 3);
  await section('project');
  await evaluate(cdp, `document.querySelector('[data-testid=fwa-refresh]').click()`);
  await waitReady();
  await goalForm();
  await submitGoal('丢失响应后仍只创建一次', '导航和刷新不能丢掉未确认的命令 ID');
  await waitGoalRecorded();
  assert.equal((await app.getStatus()).goals.length, 3, 'Retry must reuse the unresolved command ID across navigation/refresh.');
  const attempts = await evaluate(cdp, 'window.fwAcceptanceRetriedCommands');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].commandId, attempts[1].commandId, 'Retry sends the original unresolved command ID.');
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
} catch (error) {
  if (cdp) {
    const page = await evaluate(cdp, '({ text: document.body.innerText, html: document.body.innerHTML })').catch(() => null);
    fs.writeFileSync(path.join(output, 'failure.json'), `${JSON.stringify({ error: error.stack, errors, cases, page }, null, 2)}\n`);
  }
  throw error;
} finally {
  cdp?.close();
  await stopProcess(chrome);
  await editor?.close();
  fs.rmSync(project, { recursive: true, force: true });
}
