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
import { listObjectResources, objectResourceName } from '../../fwa/src/editor/object-resources.js';
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
let plannerCalls = 0;
const planFor = (title, request, id) => ({ schemaVersion: 1, nodes: [{ id, title, instruction: request,
  dependsOn: [], reads: [], writes: [`${id}.txt`], capabilities: ['code_edit'],
  acceptance: { checks: ['browser-fixture-review'] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 } }] });
// Exercise the current real form, command journal and durable application. Only
// the external planning adapter is deterministic; no model or executor runs.
const workflow = { executor: null, planner: { async plan({ request }) {
  const title = request.split('\n')[0];
  return { title, questions: [], plan: planFor(title, request, `browser-result-${++plannerCalls}`) };
} } };
const ready = `document.querySelector('[data-testid=fwa-console]') && document.querySelector('[data-testid=fwa-refresh]')?.matches(':enabled')
  && document.querySelector('select[aria-label="当前目标"]')?.options.length > 1
  && !document.querySelector('[data-fwa-workbench]')?.matches(':disabled')`;
async function waitReady() { await waitForExpression(cdp, ready, 15_000); }
async function resource(fileName) {
  await waitReady();
  assert.equal(await evaluate(cdp, `(async () => {
    await window.fwe.resources.refresh();
    return window.fwe.navigation.navigate({ domainId: 'fwa-projection', fileName: ${JSON.stringify(fileName)} }, { updateUrl: true });
  })()`), true);
  await waitForExpression(cdp, `${ready} && window.fwe.navigation.current().fileName === ${JSON.stringify(fileName)}`, 15_000);
}
async function goalForm() {
  await waitReady();
  await evaluate(cdp, `(() => {
    const details = document.querySelector('[data-testid=fwa-workflow-intake]').closest('details');
    if (!details.open) details.querySelector(':scope > summary').click();
  })()`);
  await waitForExpression(cdp, `document.querySelector('[data-testid=fwa-planning-form] textarea')?.getClientRects().length > 0`, 10_000);
}
async function submitGoal(title, request) {
  await evaluate(cdp, `(() => {
    const form = document.querySelector('[data-testid=fwa-planning-form]');
    const input = form.querySelector('textarea');
    input.value = ${JSON.stringify(`${title}\n${request}`)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (!form.querySelector('button[type=submit]').matches(':enabled')) throw new Error('The real planning form is not enabled.');
    form.requestSubmit();
  })()`);
}
async function waitGoalRecorded() {
  await waitForExpression(cdp, `document.querySelector('[data-testid=fwa-workflow-intake] [role=status]')?.textContent.includes('已提交') && ${ready}
    && document.querySelector('[data-testid=fwa-planning-form] button[type=submit]')?.matches(':enabled')`, 15_000);
}
async function waitStoredGoals(app, count) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = await app.getStatus();
    if (status.goals.length === count && status.nodes.length === count) return status;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`The real application did not persist ${count} Goals and plans.`);
}
try {
  git(project, ['init', '-b', 'main']);
  const app = new FwaApplication(project);
  await app.init();
  const initialGoal = (await app.createGoal({ title: '验证同级组件控制台', request: '验证固定工程、只读状态与受控命令。', commandId: 'browser-fixture-goal' })).goal;
  await app.loadPlan({ goalId: initialGoal.id, plan: planFor(initialGoal.title, initialGoal.request, 'fixture-result'), commandId: 'browser-fixture-plan' });
  const before = await app.getStatus();
  editor = await startEditor({ projectRoot: project, fwePath: path.join(root, 'fwe'), port: 0, workflow });
  const debugPort = await getFreePort();
  chrome = startChrome(editor.url, debugPort);
  const target = await waitForTarget(debugPort, editor.url, 15_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await waitReady();
  assert.equal(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-status]").dataset.error === "true"'), false);
  // The former empty section tabs now live in the projection/HTTP contract;
  // actual objects navigate through FWE's canonical resource addresses.
  const projection = await evaluate(cdp, `fetch('/api/fwa/status').then(response => response.json())`);
  const collections = ['goals', 'nodes', 'runs', 'evidence', 'changeSets', 'refs', 'evaluations', 'integrations', 'reversions'];
  for (const name of collections) assert.deepEqual(projection[name], before[name], `${name} remains available through the current read-only projection.`);
  assert.equal(projection.operational.gitProcessFence.held, false);
  assert.equal(projection.operational.workspaceLease.held, false);
  const session = await evaluate(cdp, `fetch('/api/fwa/session').then(response => response.json())`);
  assert.equal(session.allowWrite, false); assert.deepEqual(session.commands, []); assert.deepEqual(session.workflowCommands, []);
  const resources = listObjectResources(before);
  for (const item of resources) {
    await resource(item.name);
    assert.equal(await evaluate(cdp, 'document.querySelectorAll(".fwa-form, form[data-command-type]").length'), 0);
    assert.equal(await evaluate(cdp, 'document.querySelectorAll("[data-testid=fwa-console] button[type=submit]:enabled").length'), 0);
    assert.equal(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-status]").dataset.error === "true"'), false);
  }
  const events = await evaluate(cdp, `fetch('/api/fwa/events?after=0&limit=100').then(response => response.json())`);
  assert.deepEqual(events.events, await app.listEvents());
  await goalForm();
  await evaluate(cdp, `(() => { const input = document.querySelector('[data-testid=fwa-planning-form] textarea'); input.value = 'Read-only must stay disabled with a complete request'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-planning-form] button[type=submit]").matches(":disabled")'), true);
  assert.deepEqual(await app.getStatus(), before);
  assert.equal(plannerCalls, 0);
  cases.push(`Read-only mode: ${collections.length} durable collections, events and Fence/Lease match the application; all ${resources.length} native resources navigate; commands stay disabled and persisted state is unchanged.`);
  await resource(objectResourceName('goals', initialGoal.id));
  assert.match(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-inspector]").textContent'), /验证同级组件控制台/);
  assert.equal(await evaluate(cdp, 'Boolean(document.querySelector("[data-testid=fwa-dag]") && document.querySelector("[data-testid=fwa-progress-summary]"))'), true);
  fs.writeFileSync(path.join(output, 'readonly.png'), Buffer.from((await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  await editor.close();
  editor = await startEditor({ projectRoot: project, fwePath: path.join(root, 'fwe'), port: 0, allowWrite: true, workflow });
  await cdp.call('Page.navigate', { url: editor.url });
  await waitReady();
  await goalForm();
  await submitGoal('浏览器创建的真实目标', '<img src=x onerror="window.fwaInjected=true">');
  await waitGoalRecorded();
  const after = await waitStoredGoals(app, 2);
  assert.equal(after.goals.length, 2);
  assert.equal(after.goals.filter(goal => goal.title === '浏览器创建的真实目标').length, 1);
  const created = after.goals.find(goal => goal.title === '浏览器创建的真实目标');
  await resource(objectResourceName('nodes', after.nodes.find(node => node.goalId === created.id).id));
  assert.equal(await evaluate(cdp, 'window.fwaInjected === true'), false);
  assert.match(await evaluate(cdp, 'document.querySelector("[data-testid=fwa-inspector]").textContent'), /<img src=x onerror="window.fwaInjected=true">/);
  assert.equal(await evaluate(cdp, 'document.querySelectorAll(".fwa-console img, [data-testid=fwa-console] img").length'), 0);
  assert.equal(plannerCalls, 1);
  cases.push('Controlled write mode: the real planning form and deterministic external adapter persisted exactly one Goal and plan; untrusted request rendered as text.');
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
        if (!response.ok) throw new Error('Expected the real command to commit before losing its response.');
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const status = await (await originalFetch('/api/fwa/status')).json();
          if (status.goals.length === 3 && status.nodes.length === 3) {
            window.fwAcceptanceCommittedSequence = status.lastSequence;
            throw new TypeError('Simulated lost command response');
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Goal was not committed before the lost-response simulation.');
      }
      return response;
    };
  })()`);
  await submitGoal('丢失响应后仍只创建一次', '导航和刷新不能丢掉未确认的命令 ID');
  await waitForExpression(cdp, `document.querySelector('[data-testid=fwa-workflow-intake] [role=status]')?.textContent.includes('Simulated lost command response')`, 20_000);
  assert.equal((await app.getStatus()).goals.length, 3);
  await resource('projection.json');
  await evaluate(cdp, `document.querySelector('[data-testid=fwa-refresh]').click()`);
  await waitReady();
  await goalForm();
  await submitGoal('丢失响应后仍只创建一次', '导航和刷新不能丢掉未确认的命令 ID');
  await waitGoalRecorded();
  assert.equal((await app.getStatus()).goals.length, 3, 'Retry must reuse the unresolved command ID across navigation/refresh.');
  const attempts = await evaluate(cdp, 'window.fwAcceptanceRetriedCommands');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].commandId, attempts[1].commandId, 'Retry sends the original unresolved command ID.');
  assert.deepEqual(attempts[0], attempts[1], 'Retry preserves the exact command type and payload.');
  assert.equal((await app.getStatus()).lastSequence, await evaluate(cdp, 'window.fwAcceptanceCommittedSequence'));
  assert.equal(plannerCalls, 2, 'A recovered command must not invoke the planner twice.');
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
  fs.rmSync(path.join(output, 'failure.json'), { force: true });
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
  assert.equal(path.dirname(path.resolve(project)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(project).startsWith('fw-editor-project-'));
  fs.rmSync(project, { recursive: true, force: true });
}
