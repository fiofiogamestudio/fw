import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { child, digest, fail, fileDigest, outputsFingerprint, physicalPath, readJson, walk } from './files.mjs';
import { readArtifact, validateArtifact } from './build.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.gz': 'application/gzip' };

export function byteRange(header, size) {
  if (!header || !header.trim().startsWith('bytes=')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return false;
  if (first === null) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : false;
  if (first >= size || (last !== null && first > last)) return false;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}
export async function startPreview(root, id, { port = 0 } = {}) {
  const artifact = readArtifact(root, id);
  if (!['web', 'poki', 'taptap-h5'].includes(artifact.target)) fail('preview-unsupported', 'This target requires its native or platform preview tool.');
  if (!(await validateArtifact(root, id)).ok) fail('invalid-package', 'Preview requires an intact built package.');
  return serveVerifiedFiles(child(artifact.directory, 'out'), artifact.outputs.map(output => ({ ...output, path: output.path.slice(4) })), { port });
}

export async function startDeliveryPreview(gameDirectory, { port = 0 } = {}) {
  const root = physicalPath(gameDirectory), receipt = readJson(child(path.dirname(root), 'delivery.json'));
  if (receipt.schemaVersion !== 1 || !['web', 'poki', 'taptap-h5'].includes(receipt.target) || receipt.validation?.package !== 'passed'
    || receipt.gameDirectory !== 'game' || path.basename(root) !== 'game' || !Array.isArray(receipt.files) || !receipt.files.length) fail('invalid-delivery', 'Preview requires a verified browser delivery receipt beside game/.');
  const names = new Set();
  for (const item of receipt.files) {
    const file = child(root, item.path);
    if (names.has(item.path) || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !fs.statSync(file).isFile() || fs.statSync(file).size !== item.size || fileDigest(file) !== item.sha256) fail('changed-delivery', `Delivery is changed or invalid: ${item.path}`);
    names.add(item.path);
  }
  const actual = walk(root);
  if (!names.has('index.html') || actual.length !== names.size || actual.some(name => !names.has(name))) fail('invalid-delivery', 'Delivery file set does not match its receipt.');
  const fingerprint = outputsFingerprint({ outputs: receipt.files.map(item => ({ ...item, path: `out/${item.path}` })) });
  // Older host delivery receipts already bind every file by size and SHA-256.
  // New receipts also bind the set as a whole; a present fingerprint is strict.
  if (receipt.outputsSha256 !== undefined && receipt.outputsSha256 !== fingerprint) fail('invalid-delivery', 'Delivery output fingerprint does not match its receipt.');
  return { ...await serveVerifiedFiles(root, receipt.files, { port }), artifactId: receipt.artifactId };
}

async function serveVerifiedFiles(root, files, { port }) {
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) fail('invalid-port', 'Port must be 0..65535.');
  const allowed = new Map(files.map(output => [output.path, output]));
  const server = http.createServer(async (request, response) => {
    response.on('error', () => response.destroy());
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
      const host = request.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host)) { response.writeHead(403); response.end(); return; }
      const pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!allowed.has(relative)) { response.writeHead(404); response.end('Not found'); return; }
      const file = child(root, relative);
      const expected = allowed.get(relative);
      // Send the verified bytes themselves, so a replacement between checking
      // and opening a second file stream cannot change the preview's identity.
      let bytes;
      try {
        const info = await fs.promises.stat(file);
        if (!info.isFile() || info.size !== expected.size) throw new Error('Changed output.');
        bytes = await fs.promises.readFile(file);
        if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) throw new Error('Changed output.');
      } catch {
        response.writeHead(409); response.end('Artifact output changed or is unavailable; rebuild before previewing.'); return;
      }
      if (response.destroyed) return;
      const headers = { 'Content-Type': mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
      // HEAD describes the entire representation; without a validator If-Range
      // safely falls back to full GET. Ranges use the same hash-verified bytes.
      const range = request.method === 'GET' && !request.headers['if-range'] ? byteRange(request.headers.range, bytes.length) : null;
      if (range === false) { response.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': 0 }); response.end(); return; }
      if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${bytes.length}`;
      headers['Content-Length'] = range ? range.end - range.start + 1 : bytes.length;
      response.writeHead(range ? 206 : 200, headers);
      response.end(request.method === 'HEAD' ? undefined : range ? bytes.subarray(range.start, range.end + 1) : bytes);
    } catch {
      if (response.headersSent) response.destroy();
      else { response.writeHead(400); response.end('Invalid preview request'); }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { url, server, close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
