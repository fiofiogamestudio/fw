import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { child, digest, fail } from './files.mjs';
import { readArtifact, validateArtifact } from './build.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
export async function startPreview(root, id, { port = 0 } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) fail('invalid-port', 'Port must be 0..65535.');
  const artifact = readArtifact(root, id);
  if (!['web', 'poki', 'taptap-h5'].includes(artifact.target)) fail('preview-unsupported', 'This target requires its native or platform preview tool.');
  if (!(await validateArtifact(root, id)).ok) fail('invalid-package', 'Preview requires an intact built package.');
  const allowed = new Map(artifact.outputs.map(output => [output.path, output]));
  const server = http.createServer(async (request, response) => {
    response.on('error', () => response.destroy());
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
      const host = request.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host)) { response.writeHead(403); response.end(); return; }
      const pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname);
      const relative = `out/${pathname === '/' ? 'index.html' : pathname.slice(1)}`;
      if (!allowed.has(relative)) { response.writeHead(404); response.end('Not found'); return; }
      const file = child(artifact.directory, relative);
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
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      if (response.headersSent) response.destroy();
      else { response.writeHead(400); response.end('Invalid preview request'); }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { url, server, close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
