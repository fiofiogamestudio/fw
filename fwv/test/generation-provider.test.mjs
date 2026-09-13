import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import sharp from 'sharp';
import { GENERATION_LIMITS, ImagesProvider } from '../src/generation/provider.mjs';

const TEST_KEY = 'sk-fwv-fixture-credentials-never-real';
const png = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#aa6622' } }).png().toBuffer();
const imageResult = { data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': 'fixture-request-1' }); res.end(JSON.stringify(body)); };

async function server(t, handler) {
  const requests = [];
  const app = http.createServer(async (req, res) => {
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
      const request = { url: req.url, method: req.method, headers: req.headers, buffer: Buffer.concat(chunks) };
      requests.push(request);
      await handler(request, res);
    } catch (error) { if (!res.headersSent) json(res, { error: { message: error.message } }, 500); else res.destroy(); }
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${app.address().port}/v1`;
  const provider = new ImagesProvider({ env: {} }); provider.configure({ baseUrl, apiKey: TEST_KEY });
  return { app, provider, baseUrl, requests };
}

test('defaults and explicit environment credentials stay memory-only and clear on provider base changes', () => {
  const provider = new ImagesProvider({ env: {} });
  assert.deepEqual(provider.publicConfig(), { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', protocol: 'gpt-image', keyConfigured: false, keySource: 'none', canGenerate: false });
  const envProvider = new ImagesProvider({ env: { FWV_IMAGE_API_KEY: TEST_KEY, FWV_IMAGE_BASE_URL: 'https://example.com/v1/', FWV_IMAGE_MODEL: 'custom-model', OPENAI_API_KEY: 'ignored-non-FWV-key' } });
  assert.equal(envProvider.publicConfig().keySource, 'environment');
  assert.equal(JSON.stringify(envProvider).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(envProvider.publicConfig()).includes(TEST_KEY), false);
  assert.equal(envProvider.configure({ apiKey: '', model: 'another-model' }).keyConfigured, true);
  assert.equal(envProvider.configure({ baseUrl: 'https://example.com/v2' }).keyConfigured, false);
  assert.equal(envProvider.configure({ apiKey: TEST_KEY }).keySource, 'session');
  assert.equal(envProvider.configure({ clearKey: true }).keySource, 'none');
  assert.equal(new ImagesProvider({ env: { OPENAI_API_KEY: TEST_KEY } }).publicConfig().keyConfigured, false);
});

test('provider configuration rejects credentials, queries, fragments and nonlocal HTTP atomically', () => {
  const provider = new ImagesProvider({ env: {} }); provider.configure({ apiKey: TEST_KEY });
  for (const baseUrl of ['http://example.com/v1', 'file:///tmp', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#fragment', 'not-a-url']) {
    assert.throws(() => provider.configure({ baseUrl }), { code: 'INVALID_PROVIDER_URL' });
    assert.equal(provider.publicConfig().keyConfigured, true);
    assert.equal(provider.publicConfig().baseUrl, 'https://api.openai.com/v1');
  }
  assert.throws(() => provider.configure({ apiKey: 'secret\nheader' }), { code: 'INVALID_KEY' });
  assert.throws(() => provider.configure({ apiKey: 'new', clearKey: true }), { code: 'INVALID_CONFIG' });
  assert.throws(() => provider.configure({ protocol: 'arbitrary' }), { code: 'INVALID_PROTOCOL' });
  const local = provider.configure({ baseUrl: 'http://localhost:1234/v1' });
  assert.equal(local.keyConfigured, false);
  assert.equal(local.canGenerate, true);
});

test('connection check authenticates GET models and explicitly limits its scope', async t => {
  const { provider, requests } = await server(t, (request, res) => json(res, { data: [{ id: 'gpt-image-2' }, { id: 'other-model' }] }));
  const result = await provider.checkConnection();
  assert.deepEqual(result, { ok: true, scope: 'authentication', models: ['gpt-image-2', 'other-model'], modelListed: true, requestId: 'fixture-request-1' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].url, '/v1/models');
  assert.equal(requests[0].headers.authorization, `Bearer ${TEST_KEY}`);
});

test('real HTTP generation sends authenticated GPT JSON and returns verified image bytes', async t => {
  const { provider, requests, baseUrl } = await server(t, (request, res) => json(res, { ...imageResult, data: [{ ...imageResult.data[0], revised_prompt: `safe ${TEST_KEY}` }], usage: { ...imageResult.usage, secret: TEST_KEY } }));
  const result = await provider.generate({ prompt: 'A game potion icon', quality: 'low', background: 'transparent' });
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/v1/images/generations');
  assert.equal(requests[0].headers.authorization, `Bearer ${TEST_KEY}`);
  assert.deepEqual(JSON.parse(requests[0].buffer), { model: 'gpt-image-2', prompt: 'A game potion icon', n: 1, size: '1024x1024', quality: 'low', output_format: 'png', background: 'transparent' });
  assert.deepEqual(result.buffer, png); assert.equal(result.mime, 'image/png');
  assert.deepEqual(result.request, { baseUrl, model: 'gpt-image-2', protocol: 'gpt-image', prompt: 'A game potion icon', size: '1024x1024', quality: 'low', background: 'transparent' });
  assert.deepEqual(result.usage, imageResult.usage);
  assert.equal(result.requestId, 'fixture-request-1');
  assert.equal(result.revisedPrompt.includes(TEST_KEY), false);
  assert.equal(JSON.stringify({ ...result, buffer: undefined }).includes(TEST_KEY), false);
});

test('real HTTP reference edits carry exact reference bytes as multipart image', async t => {
  const { provider, requests } = await server(t, (request, res) => json(res, imageResult));
  await provider.generate({ prompt: 'Make the potion purple', reference: { buffer: png, name: 'potion.png', mime: 'image/png' } });
  const request = requests[0];
  assert.equal(request.url, '/v1/images/edits');
  assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
  assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/);
  const form = await new Response(request.buffer, { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
  assert.equal(form.get('model'), 'gpt-image-2'); assert.equal(form.get('n'), '1');
  assert.equal(form.get('image').name, 'potion.png');
  assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), png);
  assert.equal(form.has('response_format'), false); assert.equal(form.has('background'), false);
});

test('compatible mode sends basic fields without GPT-only parameters', async t => {
  const { provider, requests } = await server(t, (request, res) => json(res, imageResult));
  provider.configure({ protocol: 'openai-compatible', model: 'custom-image' });
  await provider.generate({ prompt: 'An icon' });
  assert.deepEqual(JSON.parse(requests[0].buffer), { model: 'custom-image', prompt: 'An icon', n: 1, size: '1024x1024', response_format: 'b64_json' });
  await assert.rejects(provider.generate({ prompt: 'An icon', background: 'transparent' }), { code: 'UNSUPPORTED_BACKGROUND', uncertain: false });
  assert.equal(requests.length, 1);
});

test('provider error messages and request IDs redact credentials without retrying failed POSTs', async t => {
  const { provider, requests } = await server(t, (request, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json', 'X-Request-Id': TEST_KEY });
    res.end(JSON.stringify({ error: { message: `Invalid key ${TEST_KEY}; Authorization: Bearer ${TEST_KEY}` } }));
  });
  await assert.rejects(provider.generate({ prompt: 'An icon' }), error => {
    assert.equal(error.code, 'PROVIDER_HTTP_ERROR'); assert.equal(error.status, 401); assert.equal(error.uncertain, false);
    assert.equal(`${error.message} ${error.stack} ${JSON.stringify(error)}`.includes(TEST_KEY), false);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('upstream timeout and server errors keep the billable outcome uncertain without retries', async t => {
  let status = 502;
  const { provider, requests } = await server(t, (request, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': 'gateway-request-1' });
    res.end(JSON.stringify({ error: { message: 'Upstream unavailable' } }));
  });
  for (status of [408, 500, 502, 503, 504]) {
    await assert.rejects(provider.generate({ prompt: 'An icon' }), error => error.status === status && error.uncertain === true && error.requestId === 'gateway-request-1');
  }
  assert.equal(requests.length, 5);
});

test('cancellation after sending is uncertain and does not automatically repeat a billable request', async t => {
  let received;
  const arrived = new Promise(resolve => { received = resolve; });
  const { provider, requests } = await server(t, () => { received(); });
  const controller = new AbortController();
  const generation = provider.generate({ prompt: 'An icon', signal: controller.signal });
  await arrived; controller.abort();
  await assert.rejects(generation, { code: 'GENERATION_CANCELLED', uncertain: true });
  await delay(30); assert.equal(requests.length, 1);
  await assert.rejects(provider.generate({ prompt: 'Not sent', signal: controller.signal }), { code: 'GENERATION_CANCELLED', uncertain: false });
  assert.equal(requests.length, 1);
});

test('malformed, multiple and oversized responses are rejected after exactly one POST', async t => {
  let response = { data: [{ b64_json: 'invalid-base64' }] };
  let oversized = false;
  const { provider, requests } = await server(t, (request, res) => {
    if (oversized) { res.writeHead(200, { 'Content-Length': GENERATION_LIMITS.responseBytes + 1 }); res.flushHeaders(); return; }
    json(res, response);
  });
  await assert.rejects(provider.generate({ prompt: 'One' }), { code: 'INVALID_IMAGE_OUTPUT', uncertain: true });
  response = { data: [imageResult.data[0], imageResult.data[0]] };
  await assert.rejects(provider.generate({ prompt: 'Two' }), { code: 'INVALID_RESPONSE', uncertain: true });
  response = { data: [{ b64_json: Buffer.from('not an image').toString('base64') }] };
  await assert.rejects(provider.generate({ prompt: 'Three' }), { code: 'INVALID_IMAGE_OUTPUT', uncertain: true });
  oversized = true;
  await assert.rejects(provider.generate({ prompt: 'Four' }), { code: 'RESPONSE_TOO_LARGE', uncertain: true });
  assert.equal(requests.length, 4);
});

test('URL output downloads only from an allowed origin without forwarding authorization', async t => {
  let outputUrl;
  const { provider, requests, baseUrl } = await server(t, (request, res) => {
    if (request.url === '/result.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); }
    else json(res, { data: [{ url: outputUrl }] });
  });
  outputUrl = new URL('/result.png', baseUrl).href;
  assert.deepEqual((await provider.generate({ prompt: 'An icon' })).buffer, png);
  assert.equal(requests.length, 2); assert.equal(requests[1].headers.authorization, undefined);
  outputUrl = 'https://127.0.0.1:4444/internal';
  await assert.rejects(provider.generate({ prompt: 'Blocked' }), { code: 'UNSAFE_IMAGE_URL', uncertain: true });
  assert.equal(requests.length, 3);
});

test('image downloads refuse redirects and enforce decoded output byte limits', async t => {
  let mode = 'redirect';
  let resultUrl;
  const { provider, requests, baseUrl } = await server(t, (request, res) => {
    if (request.url === '/result') {
      if (mode === 'redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); res.end(); }
      else { res.writeHead(200, { 'Content-Length': GENERATION_LIMITS.imageBytes + 1 }); res.flushHeaders(); }
    } else json(res, { data: [{ url: resultUrl }] });
  });
  resultUrl = new URL('/result', baseUrl).href;
  await assert.rejects(provider.generate({ prompt: 'Redirect' }), error => error.uncertain === true);
  assert.equal(requests.length, 2);
  mode = 'oversized';
  await assert.rejects(provider.generate({ prompt: 'Oversized' }), { code: 'RESPONSE_TOO_LARGE', uncertain: true });
  assert.equal(requests.length, 4);
});

test('network failures are redacted, marked uncertain and never retried', async () => {
  let calls = 0;
  const provider = new ImagesProvider({ env: {}, fetchImpl: async () => { calls++; throw new Error(`Socket failed for ${TEST_KEY}`); } });
  provider.configure({ apiKey: TEST_KEY });
  await assert.rejects(provider.generate({ prompt: 'An icon' }), error => error.uncertain === true && !error.message.includes(TEST_KEY));
  assert.equal(calls, 1);
});

test('external image transport pins the validated address while preserving TLS host identity', async () => {
  let lookups = 0, posts = 0, transports = 0;
  const provider = new ImagesProvider({
    env: {},
    fetchImpl: async (url, options) => {
      posts++; assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, `Bearer ${TEST_KEY}`);
      return Response.json({ data: [{ url: 'https://rebind.example.test/result.png?temporary=123' }] });
    },
    lookupImpl: async (host, options) => {
      lookups++; assert.equal(host, 'rebind.example.test'); assert.equal(options.all, true);
      // A second resolution would return loopback, reproducing the rebinding threat.
      return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    },
    httpsRequestImpl: (url, options, callback) => {
      transports++;
      assert.equal(url.href, 'https://rebind.example.test/result.png?temporary=123');
      assert.equal(options.servername, 'rebind.example.test'); assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false); assert.equal(options.autoSelectFamily, false);
      assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.authorization, undefined);
      assert.equal(options.method, 'GET'); assert.ok(options.signal instanceof AbortSignal);
      options.lookup('rebind.example.test', { all: true }, (error, addresses) => {
        assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
      });
      options.lookup('rebind.example.test', {}, (error, address, family) => {
        assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
      });
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        const response = Readable.from([png]); response.statusCode = 200; response.headers = {}; callback(response);
      });
      return request;
    },
  });
  provider.configure({ apiKey: TEST_KEY });
  assert.deepEqual((await provider.generate({ prompt: 'An icon' })).buffer, png);
  assert.equal(lookups, 1); assert.equal(posts, 1); assert.equal(transports, 1);
});

test('pinned HTTPS downloads reject redirects and both declared and streamed size excess', async () => {
  let mode = 'redirect', transports = 0, posts = 0;
  const provider = new ImagesProvider({ env: {},
    fetchImpl: async () => { posts++; return Response.json({ data: [{ url: 'https://8.8.8.8/result.png' }] }); },
    lookupImpl: async () => { throw new Error('IP literals must not be resolved again.'); },
    httpsRequestImpl: (url, options, callback) => {
      transports++; assert.equal(options.headers.Authorization, undefined);
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        const chunks = mode === 'streamed' ? Array(33).fill(Buffer.alloc(1024 * 1024)) : [png];
        const response = Readable.from(chunks);
        response.statusCode = mode === 'redirect' ? 302 : 200;
        response.headers = mode === 'declared' ? { 'content-length': String(GENERATION_LIMITS.imageBytes + 1) } : { location: 'https://127.0.0.1/private' };
        callback(response);
      });
      return request;
    },
  });
  provider.configure({ apiKey: TEST_KEY });
  await assert.rejects(provider.generate({ prompt: 'Redirect' }), { code: 'IMAGE_DOWNLOAD_FAILED', uncertain: true });
  mode = 'declared';
  await assert.rejects(provider.generate({ prompt: 'Too large' }), { code: 'RESPONSE_TOO_LARGE', uncertain: true });
  mode = 'streamed';
  await assert.rejects(provider.generate({ prompt: 'Too many chunks' }), { code: 'RESPONSE_TOO_LARGE', uncertain: true });
  assert.equal(posts, 3); assert.equal(transports, 3);
});

test('pinned image download propagates cancellation without a second provider POST', async () => {
  let started;
  const downloading = new Promise(resolve => { started = resolve; });
  let posts = 0;
  const provider = new ImagesProvider({ env: {},
    fetchImpl: async () => { posts++; return Response.json({ data: [{ url: 'https://8.8.8.8/result.png' }] }); },
    httpsRequestImpl: (url, options) => {
      const request = new EventEmitter();
      options.signal.addEventListener('abort', () => request.emit('error', Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
      request.end = () => { started(); };
      return request;
    },
  });
  provider.configure({ apiKey: TEST_KEY });
  const controller = new AbortController();
  const generation = provider.generate({ prompt: 'An icon', signal: controller.signal });
  await downloading; controller.abort();
  await assert.rejects(generation, { code: 'GENERATION_CANCELLED', uncertain: true });
  assert.equal(posts, 1);
});
