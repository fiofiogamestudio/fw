import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import sharp from 'sharp';
import { run } from '../bin/fwv.mjs';
import { FwvProject } from '../src/core/project.mjs';
import { GenerationRecovery } from '../src/generation/recovery.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/fwv.mjs', import.meta.url));
const TEST_KEY = 'sk-fwv-cli-fixture-never-real';
const image = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#228899' } }).png().toBuffer();

async function setup(t, respond) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-cli-generation-'));
  const project = new FwvProject(root); await project.init({ name: 'CLI generation test' });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = { method: req.method, url: req.url, headers: req.headers, buffer: Buffer.concat(chunks) };
    requests.push(request);
    if (respond) return respond(request, res);
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'cli-fixture-request' });
    res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'gpt-image-2' }] } : { data: [{ b64_json: image.toString('base64') }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup.');
    await fs.rm(root, { recursive: true, force: true });
  });
  const env = { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    FWV_IMAGE_API_KEY: TEST_KEY, FWV_IMAGE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, FWV_IMAGE_MODEL: 'gpt-image-2' };
  return { root, project, requests, env };
}

test('generate CLI submits once and saves a real image asset with secret-free JSON output', async t => {
  const { root, project, requests, env } = await setup(t);
  const result = await exec(process.execPath, [cli, 'generate', '--project', root, '--prompt', 'Game potion icon', '--name', 'Potion', '--request-id', 'cli-potion'], { env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'succeeded'); assert.equal(output.job.requestId, 'cli-potion');
  assert.equal(output.provider.keySource, 'environment');
  assert.equal((result.stdout + result.stderr).includes(TEST_KEY), false);
  assert.equal(requests.length, 1); assert.equal(requests[0].headers.authorization, `Bearer ${TEST_KEY}`);
  const snapshot = await project.snapshot();
  assert.equal(snapshot.assets.length, 1); assert.equal(snapshot.assets[0].name, 'Potion');
  const revision = snapshot.assets[0].revisions[0];
  assert.deepEqual((await project.readArtifact({ assetId: output.job.assetId, revisionId: output.job.revisionId, fileName: revision.files[0].name })).buffer, image);
  assert.equal(JSON.stringify(snapshot).includes(TEST_KEY), false);
  assert.equal(revision.metadata.generation.requestId, 'cli-potion');
});

test('prompt-file CLI edits use a registered reference and preserve its exact bytes', async t => {
  const { root, project, requests, env } = await setup(t);
  const source = await project.importImage({ fileName: 'reference.png', buffer: image });
  const promptPath = path.join(root, 'prompt.txt'); await fs.writeFile(promptPath, '\uFEFFMake this potion purple', 'utf8');
  const result = await exec(process.execPath, [cli, 'generate', '--project', root, '--prompt-file', promptPath,
    '--reference-asset', source.id, '--reference-revision', source.selectedRevisionId, '--reference-file', 'reference.png'], { env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'succeeded'); assert.equal(requests.length, 1); assert.equal(requests[0].url, '/v1/images/edits');
  const form = await new Response(requests[0].buffer, { headers: { 'Content-Type': requests[0].headers['content-type'] } }).formData();
  assert.equal(form.get('prompt'), 'Make this potion purple');
  assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), image);
  const asset = (await project.snapshot()).assets.find(asset => asset.id === output.job.assetId);
  const reference = asset.revisions[0].files.find(file => file.role === 'reference');
  assert.ok(reference);
  assert.deepEqual((await project.readArtifact({ assetId: asset.id, revisionId: asset.selectedRevisionId, fileName: reference.name })).buffer, image);
});

test('invalid CLI options and missing project fail before a paid request', async t => {
  const { root, requests, env } = await setup(t);
  await assert.rejects(run(['generate', '--project', root], { env }), /exactly one/);
  await assert.rejects(run(['generate', '--project', root, '--prompt', 'x', '--prompt-file', 'prompt.txt'], { env }), /exactly one/);
  await assert.rejects(run(['generate', '--project', root, '--prompt', 'x', '--reference-asset', 'only-one'], { env }), /together/);
  await assert.rejects(run(['generate', '--project', root, '--prompt', 'x', '--api-key', TEST_KEY], { env }), /not supported/);
  await assert.rejects(run(['generate', '--project', path.join(root, 'missing'), '--prompt', 'x'], { env }));
  assert.equal(requests.length, 0);
});

test('provider-check CLI checks auth without creating assets or exposing the configured key', async t => {
  const { root, requests, project, env } = await setup(t);
  const result = await exec(process.execPath, [cli, 'provider-check', '--project', root], { env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.check.scope, 'authentication'); assert.equal(output.check.modelListed, true);
  assert.equal(requests.length, 1); assert.equal(requests[0].method, 'GET');
  assert.equal((await project.snapshot()).assets.length, 0);
  assert.equal((result.stdout + result.stderr).includes(TEST_KEY), false);
});

test('a failed provider POST exits nonzero with redacted errors and no retry', async t => {
  const { root, requests, env } = await setup(t, (request, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Rejected ${TEST_KEY}` } }));
  });
  await assert.rejects(exec(process.execPath, [cli, 'generate', '--project', root, '--prompt', 'An icon'], { env }), error => {
    const output = JSON.parse(error.stderr);
    assert.equal(error.code, 1); assert.equal(output.status, 'failed'); assert.equal(output.uncertain, false);
    assert.equal((error.stdout + error.stderr).includes(TEST_KEY), false);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('unknown remote result exits nonzero and preserves the may-have-been-charged boundary', async t => {
  const { root, requests, env } = await setup(t, (request, res) => res.destroy());
  await assert.rejects(exec(process.execPath, [cli, 'generate', '--project', root, '--prompt', 'An icon'], { env }), error => {
    const output = JSON.parse(error.stderr);
    assert.equal(output.status, 'unknown'); assert.equal(output.uncertain, true);
    assert.match(output.error, /may have reached the provider/);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('completed image survives a project-save failure and a new CLI process saves the same request once', async t => {
  const { root, project, requests, env } = await setup(t);
  t.mock.method(FwvProject.prototype, 'importAsset', async () => { throw new Error('Injected permanent storage failure'); });
  let failure;
  await assert.rejects(run(['generate', '--project', root, '--prompt', 'A recoverable icon', '--request-id', 'recovery-fixture'], { env }), error => {
    failure = error; return error.code === 'GENERATION_SAVE_FAILED';
  });
  const recovery = failure.recovery;
  assert.equal(failure.status, 'ready'); assert.equal(requests.length, 1);
  assert.ok(path.resolve(recovery.directory).startsWith(path.join(root, '.fwv', 'generation') + path.sep));
  assert.deepEqual(await fs.readFile(recovery.imagePath), image);
  const manifest = JSON.parse(await fs.readFile(recovery.manifestPath, 'utf8'));
  assert.equal(manifest.metadata.generation.requestId, 'recovery-fixture'); assert.equal(manifest.metadata.generation.prompt, 'A recoverable icon');
  assert.equal(JSON.stringify(manifest).includes(TEST_KEY), false);
  assert.match(failure.message, /do not repeat the paid generation request/);
  t.mock.restoreAll();
  const result = await exec(process.execPath, [cli, 'generate', '--project', root, '--prompt', 'A recoverable icon', '--request-id', 'recovery-fixture'], { env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'succeeded'); assert.equal(output.job.id, failure.job.id);
  assert.equal(requests.length, 1); assert.equal((await project.snapshot()).assets.length, 1);
});

test('CLI retains its explicit temporary backup when project result staging itself is unavailable', async t => {
  const { root, requests, env } = await setup(t);
  t.mock.method(GenerationRecovery.prototype, 'stage', async () => { throw new Error('Injected project staging failure'); });
  let failure;
  await assert.rejects(run(['generate', '--project', root, '--prompt', 'A temporary recovery icon', '--request-id', 'temp-recovery-fixture'], { env }), error => {
    failure = error; return error.code === 'GENERATION_SAVE_FAILED';
  });
  const recovery = failure.recovery;
  assert.equal(failure.job.durability, 'memory'); assert.equal(requests.length, 1);
  assert.ok(path.resolve(recovery.directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(recovery.directory, { recursive: true, force: true }));
  assert.deepEqual(await fs.readFile(recovery.imagePath), image);
  const manifest = JSON.parse(await fs.readFile(recovery.manifestPath, 'utf8'));
  assert.equal(manifest.requestId, 'temp-recovery-fixture'); assert.equal(manifest.request.prompt, 'A temporary recovery icon');
  assert.equal(JSON.stringify(manifest).includes(TEST_KEY), false);
});
