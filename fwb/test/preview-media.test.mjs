import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, fileDigest } from '../src/core/files.mjs';
import { startPreview } from '../src/core/preview.mjs';
import { pckFixture, wasmFixture } from './fixtures/web-output.mjs';

test('media preview handles byte ranges, HEAD, MIME and changed bytes under the same identity contract', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-preview-media-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = 'build_preview_media123', directory = path.join(root, '.local/fwb/artifacts', id), out = path.join(directory, 'out'); fs.mkdirSync(out, { recursive: true });
  const files = { 'index.html': '<html>Test</html>', 'index.js': '// engine', 'index.wasm': wasmFixture(), 'index.pck': pckFixture(), 'clip.mp4': '0123456789', 'clip.webm': 'abcdefghij', 'font.woff2': 'font', 'image.webp': 'image' };
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(out, name), data);
  atomicJson(path.join(directory, 'manifest.json'), { schemaVersion: 1, id, target: 'web', status: 'built', validation: {}, outputs: Object.keys(files).map(name => ({ path: 'out/' + name, size: fs.statSync(path.join(out, name)).size, sha256: fileDigest(path.join(out, name)) })) });
  const preview = await startPreview(root, id); t.after(preview.close);
  let response = await fetch(preview.url + 'clip.mp4', { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(response.headers.get('content-type'), 'video/mp4'); assert.equal(await response.text(), '2345');
  for (const [range, expected] of [['bytes=-3', '789'], ['bytes=7-', '789'], ['bytes=8-999', '89']]) {
    response = await fetch(preview.url + 'clip.mp4', { headers: { Range: range } }); assert.equal(response.status, 206); assert.equal(await response.text(), expected);
  }
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=90071992547409920-']) {
    response = await fetch(preview.url + 'clip.mp4', { headers: { Range: range } }); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */10');
  }
  response = await fetch(preview.url + 'clip.mp4', { method: 'HEAD', headers: { Range: 'bytes=2-5' } }); assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), '10'); assert.equal(await response.text(), '');
  response = await fetch(preview.url + 'clip.mp4', { headers: { Range: 'bytes=2-5', 'If-Range': '"unknown"' } }); assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  for (const [name, type] of [['clip.webm', 'video/webm'], ['font.woff2', 'font/woff2'], ['image.webp', 'image/webp']]) assert.equal((await fetch(preview.url + name)).headers.get('content-type'), type);
  fs.writeFileSync(path.join(out, 'clip.mp4'), 'xxxxxxxxxx');
  assert.equal((await fetch(preview.url + 'clip.mp4', { headers: { Range: 'bytes=2-5' } })).status, 409);
  assert.equal((await fetch(preview.url + 'clip.mp4', { method: 'HEAD' })).status, 409);
});
