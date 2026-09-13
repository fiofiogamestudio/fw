import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { createReskinFixture } from '../examples/reskin-fixture/create.mjs';

const fwePath = process.env.FWV_TEST_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url));
const regions = ['head', 'torso', 'arm-left', 'arm-right', 'leg-left', 'leg-right'];

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'fwv-reskin-editor-');
  const root = await fs.mkdtemp(prefix);
  const project = new FwvProject(root);
  const calls = [], providerErrors = [];
  const generated = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#654bd8' } }).png().toBuffer();
  const provider = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const call = { method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks) };
      calls.push(call);
      if (req.method !== 'POST' || req.url !== '/v1/images/edits') {
        res.writeHead(404); res.end('{}'); return;
      }
      const form = await new Response(call.body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
      call.fields = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string'));
      const reference = form.get('image');
      call.reference = { name: reference.name, mime: reference.type, buffer: Buffer.from(await reference.arrayBuffer()) };
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'local-reskin-image-1' });
      res.end(JSON.stringify({ data: [{ b64_json: generated.toString('base64') }], usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 } }));
    } catch (error) {
      providerErrors.push(error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fixture request failed.' } }));
    }
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  let editor;
  t.after(async () => {
    if (editor) await editor.close();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    assert.ok(root.startsWith(prefix) && path.dirname(root) === path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await project.init({ name: 'HTTP 角色换皮测试' });
  editor = await startEditor({ projectRoot: root, fwePath, port: 0 });
  const get = async route => {
    const response = await fetch(editor.url + route);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const session = await get('/api/fwv/session');
  assert.equal(session.protocol, 'fwv-workbench-v1');
  const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWV-CSRF': session.csrfToken };
  const post = async (type, payload, requestHeaders = headers) => {
    const response = await fetch(editor.url + '/api/fwv/commands', { method: 'POST', headers: requestHeaders, body: JSON.stringify({ type, payload }) });
    return { status: response.status, body: await response.json() };
  };
  const command = async (type, payload) => {
    const { status, body } = await post(type, payload);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    return body.result;
  };
  // Never use any startup credential or send a request to an external provider.
  const config = await command('provider.configure', { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'gpt-image-2', protocol: 'gpt-image', clearKey: true });
  assert.equal(config.keyConfigured, false); assert.equal(config.keySource, 'none'); assert.equal(config.canGenerate, true);
  const source = await createReskinFixture();
  const template = await command('spine.import', { name: source.name, files: source.files.map(file => ({ name: file.name, base64: file.buffer.toString('base64') })) });
  const planInput = { templateAssetId: template.id, templateRevisionId: template.selectedRevisionId, name: '紫色猫咪骑士', brief: '猫咪骑士，统一紫色护甲和银色装饰。' };
  const create = () => command('reskin.create', planInput);
  const workflow = workflowId => get('/api/fwv/reskin/workflows?' + new URLSearchParams({ workflowId })).then(body => body.workflow);
  return { root, project, editor, headers, calls, providerErrors, generated, source, template, planInput, create, get, post, command, workflow };
}

test('HTTP workbench registers reskin panel and creates a durable six-part plan without model calls', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const app = await f.get('/api/app');
  const extension = app.extensions.find(extension => extension.url.includes('reskin-panel.js'));
  assert.ok(extension, 'The reskin client must be registered with FWE.');
  const script = await fetch(f.editor.url + extension.url);
  assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
  assert.match(await script.text(), /FwvPanels[\s\S]*id: 'reskin'/);
  assert.deepEqual((await f.get('/api/fwv/reskin/workflows')).workflows, []);
  const report = await f.get('/api/fwv/reskin/template?' + new URLSearchParams({ assetId: f.template.id, revisionId: f.template.selectedRevisionId }));
  assert.deepEqual(report.parts.map(part => part.regionName), regions);
  const plan = await f.create();
  assert.equal(plan.preserveAlpha, true); assert.equal(plan.parts.length, 6); assert.deepEqual(plan.attempts, []);
  assert.deepEqual(await f.workflow(plan.assetId), plan);
  assert.equal((await f.get('/api/fwv/reskin/workflows')).workflows.length, 1);
  const persisted = await f.project.readArtifact({ assetId: plan.assetId, revisionId: plan.revisionId, fileName: 'workflow.json' });
  assert.equal(JSON.parse(persisted.buffer).sheet.layout.parts.length, 6);
  assert.equal((await f.get('/api/fwv/generation/jobs')).jobs.length, 0);
  assert.equal(f.calls.length, 0);
});

test('HTTP origin and CSRF rejection happen before reskin run reservation or generation jobs', { timeout: 30000 }, async t => {
  const f = await fixture(t), plan = await f.create();
  const before = await f.project.snapshot();
  const missingOrigin = { ...f.headers }; delete missingOrigin.Origin;
  const missingCsrf = { ...f.headers }; delete missingCsrf['X-FWV-CSRF'];
  for (const headers of [missingOrigin, missingCsrf, { ...f.headers, 'X-FWV-CSRF': 'incorrect-token' }, { ...f.headers, Origin: 'https://untrusted.example' }]) {
    const rejected = await f.post('reskin.generate', { workflowId: plan.assetId, requestId: 'must-never-reserve' }, headers);
    assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
  }
  assert.deepEqual(await f.workflow(plan.assetId), plan);
  assert.deepEqual(await f.project.snapshot(), before);
  assert.deepEqual((await f.get('/api/fwv/generation/jobs')).jobs, []);
  assert.equal(f.calls.length, 0);
});

test('one authenticated HTTP reskin run calls Images edits once and exports unchanged skeleton and atlas bytes', { timeout: 30000 }, async t => {
  const f = await fixture(t), plan = await f.create();
  const originalTemplate = (await f.project.snapshot()).assets.find(asset => asset.id === f.template.id);
  await f.command('reskin.generate', { workflowId: plan.assetId, requestId: 'one-paid-operation' });
  let view;
  const deadline = Date.now() + 15000;
  do {
    view = await f.workflow(plan.assetId);
    if (!['queued', 'running'].includes(view.attempts[0]?.status)) break;
    await delay(80);
  } while (Date.now() < deadline);
  assert.equal(view.attempts[0]?.status, 'succeeded', JSON.stringify(view.attempts));
  const attempt = view.attempts[0];
  assert.equal(view.selectedCandidateId, attempt.id);
  assert.notEqual(attempt.candidateAssetId, f.template.id);
  assert.deepEqual(f.providerErrors, []); assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.authorization, undefined); assert.equal(call.fields.model, 'gpt-image-2'); assert.equal(call.fields.n, '1');
  assert.equal(call.fields.size, '1024x1024'); assert.match(call.fields.prompt, /PART SHEET/);
  for (const region of regions) assert.ok(call.fields.prompt.includes(region));
  assert.equal(call.reference.mime, 'image/png');
  const guide = await f.project.readArtifact({ assetId: attempt.guide.assetId, revisionId: attempt.guide.revisionId, fileName: attempt.guide.fileName });
  assert.deepEqual(call.reference.buffer, guide.buffer);
  const packageInfo = await f.command('asset.export', { assetId: attempt.candidateAssetId, revisionId: attempt.candidateRevisionId });
  assert.deepEqual(await fs.readFile(path.join(f.root, packageInfo.path, 'resources', 'cat.json')), f.source.json);
  assert.deepEqual(await fs.readFile(path.join(f.root, packageInfo.path, 'resources', 'cat.atlas')), f.source.atlas);
  const changedPage = await fs.readFile(path.join(f.root, packageInfo.path, 'resources', 'cat-parts.png'));
  assert.notDeepEqual(changedPage, f.source.page);
  assert.deepEqual((await f.project.snapshot()).assets.find(asset => asset.id === f.template.id), originalTemplate);
  for (const file of f.source.files) {
    const artifact = await f.project.readArtifact({ assetId: f.template.id, revisionId: f.template.selectedRevisionId, fileName: file.name });
    assert.deepEqual(artifact.buffer, file.buffer);
  }
  const duplicate = await f.command('reskin.generate', { workflowId: plan.assetId, requestId: 'one-paid-operation' });
  assert.equal(duplicate.attempts.length, 1); assert.equal(f.calls.length, 1);
});

test('HTTP reskin routes reject ambiguous queries and damaged templates before plan creation', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const query = new URLSearchParams({ assetId: f.template.id, revisionId: f.template.selectedRevisionId }).toString();
  for (const route of [
    '/api/fwv/reskin/workflows?extra=1',
    '/api/fwv/reskin/workflows?workflowId=a&workflowId=b',
    '/api/fwv/reskin/template?assetId=' + f.template.id,
    '/api/fwv/reskin/template?' + query + '&extra=1',
    '/api/fwv/reskin/template?' + query + '&assetId=' + f.template.id,
  ]) {
    const response = await fetch(f.editor.url + route);
    const body = await response.json();
    assert.equal(response.status, 400, `${route}: ${JSON.stringify(body)}`);
  }
  const before = await f.project.snapshot();
  const invalid = await f.post('reskin.create', { ...f.planInput, regionNames: ['absent-part'] });
  assert.equal(invalid.status, 400);
  await fs.writeFile(path.join(f.root, 'assets', f.template.id, f.template.selectedRevisionId, 'cat-parts.png'), Buffer.alloc(f.source.page.length));
  assert.equal((await fetch(f.editor.url + '/api/fwv/reskin/template?' + query)).status, 400);
  const damaged = await f.post('reskin.create', f.planInput);
  assert.equal(damaged.status, 400, JSON.stringify(damaged.body));
  assert.deepEqual(await f.project.snapshot(), before);
  assert.deepEqual((await f.get('/api/fwv/reskin/workflows')).workflows, []);
  assert.deepEqual((await f.get('/api/fwv/generation/jobs')).jobs, []);
  assert.equal(f.calls.length, 0);
});
