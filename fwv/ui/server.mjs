import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptureWorkspace, registerWorkspace } from './core/workspace.mjs';
import { failure, MAX_REVIEW_BYTES } from './core/review.mjs';
import { validateManifest, renderGallery } from './core/manifest.mjs';

const require = createRequire(import.meta.url);
const appPath = fileURLToPath(new URL('./app/fwe.app.json', import.meta.url));
export const UI_CAPTURE_PROTOCOL = 'fwv-ui-capture-v1';
export const DEFAULT_FWE_PATH = fileURLToPath(new URL('../../fwe/', import.meta.url));
const prefix = '/api/fwv/ui-capture';
function equalSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function runtime(fwePath) {
  if (!path.isAbsolute(fwePath)) throw failure('Use an absolute --fwe-path.');
  const selected = await realpath(fwePath);
  const metadata = JSON.parse(await readFile(path.join(selected, 'package.json'), 'utf8'));
  if (metadata.name !== 'fwe' || metadata.version !== '0.2.0') throw failure('UI capture requires FWE 0.2.0.');
  const fwe = require(path.join(selected, 'src/server.js')), c = fwe.SERVER_INTEGRATION_CONTRACT;
  if (c?.version !== 1 || c.requestGuard !== 'await-before-routing-v1' || c.extensions !== 'sync-setup-async-handlers-v1'
    || c.nativeCatalog !== 'media-pagination-forms-v1' || c.configuredSurfaces !== 'native-inspector-v1'
    || c.boundedRequestBody !== 'bytes-v1' || c.surfaceCanvas !== 'device-resolution-v1'
    || c.surfaceFilledButtons !== 'semantic-tones-v1'
    || typeof fwe.loadAppConfig !== 'function' || typeof fwe.startServer !== 'function') throw failure('Selected FWE lacks the required integration contracts.');
  return { fwe, selected };
}

export async function handleCaptureApi({ app, req, res, url, sendJson, readBody, parseJson }) {
  const session = app.fwvUiCapture;
  if (!session) throw failure('Start this application through fwv ui serve.', 503);
  const workspace = session.workspace;
  try {
    await workspace.assertCurrent();
    res.setHeader('Cache-Control', 'no-store');
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === prefix + '/media') {
      if ([...url.searchParams.keys()].some(key => !['id', 'download'].includes(key)) || url.searchParams.getAll('id').length !== 1
        || url.searchParams.getAll('download').length > 1 || url.searchParams.has('download') && url.searchParams.get('download') !== '1') throw failure('Only one screenshot ID and optional download=1 are accepted.');
      const { bytes, shot } = await workspace.media(url.searchParams.get('id'));
      res.setHeader('Content-Type', 'image/png'); res.setHeader('Content-Length', bytes.length);
      if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="${shot.number}-${shot.id}.png"`);
      res.statusCode = 200; res.end(req.method === 'HEAD' ? undefined : bytes); return true;
    }
    if (req.method === 'GET' && url.pathname === prefix + '/session') {
      const review = await workspace.review.read();
      sendJson(200, { protocol: UI_CAPTURE_PROTOCOL, manifestId: workspace.manifestId, manifestPath: workspace.manifestPath,
        csrfToken: session.csrfToken, revision: review.revision, summary: workspace.summary }); return true;
    }
    if (req.method === 'GET' && url.pathname === prefix + '/manifest') { sendJson(200, workspace.manifest); return true; }
    if (req.method === 'GET' && url.pathname === prefix + '/ui') { sendJson(200, session.ui); return true; }
    if (req.method === 'GET' && url.pathname === prefix + '/review') {
      if (url.searchParams.size && (url.searchParams.size !== 1 || url.searchParams.get('download') !== '1')) throw failure('Unsupported review query.');
      if (url.searchParams.has('download')) res.setHeader('Content-Disposition', 'attachment; filename="review.json"');
      sendJson(200, await workspace.review.read()); return true;
    }
    if (req.method === 'PUT' && url.pathname === prefix + '/review') {
      const body = parseJson(await readBody({ maxBytes: MAX_REVIEW_BYTES }));
      if (!body || Object.keys(body).some(key => !['expectedRevision', 'annotations'].includes(key))) throw failure('Invalid review save payload.');
      sendJson(200, await workspace.review.write(body)); return true;
    }
    if (req.method === 'GET' && url.pathname === prefix + '/export') {
      if (url.searchParams.size) throw failure('Offline export accepts no file path parameters.');
      const checked = await validateManifest(workspace.manifestPath);
      if (checked.capture.generated.sourceManifestSha256 !== workspace.manifestId) throw failure('Capture changed during export.', 409);
      for (const shot of checked.capture.screenshots) if (workspace.shots.get(shot.id)?.sha256 !== shot.sha256) throw failure('Screenshot changed during export.', 409);
      const html = await renderGallery({ ...checked, review: await workspace.review.read(), inlineImages: true });
      await workspace.assertCurrent();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ui-capture-${workspace.manifest.run.id}.html"`);
      res.statusCode = 200; res.end(html); return true;
    }
    return false;
  } catch (error) { sendJson(error.status || 400, { error: error.message, code: error.code || 'UI_CAPTURE_INVALID' }); return true; }
}

export async function startUiServer({ manifestPath, fwePath = DEFAULT_FWE_PATH, port = 0, open = false, signal } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw failure('port must be 0..65535.');
  const workspace = await CaptureWorkspace.open(manifestPath);
  const { fwe, selected } = await runtime(fwePath);
  const app = fwe.loadAppConfig(appPath), registration = registerWorkspace(workspace);
  app.workspaceDir = workspace.root;
  for (const domain of app.domains) domain.source.captureKey = registration.key;
  const ui = {};
  for (const name of ['preview', 'coverage']) ui[name] = JSON.parse(await readFile(new URL(`./app/${name}.ui.json`, import.meta.url), 'utf8'));
  const csrfToken = randomBytes(32).toString('hex');
  app.fwvUiCapture = { workspace, csrfToken, ui };
  const allowedReads = new Set(['/api/app', ...['session', 'manifest', 'review', 'media', 'ui', 'export'].map(name => `${prefix}/${name}`),
    '/api/domains/fwv-ui-capture/files', '/api/domains/fwv-ui-capture/files/catalog.json',
    ...(app.clientExtensions || []).map(entry => `/api/extensions/${entry.id}/${encodeURIComponent(entry.name)}`)]);
  const guard = async (req, res) => {
    for (const [name, value] of Object.entries({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin' })) res.setHeader(name, value);
    const host = `127.0.0.1:${req.socket.localPort}`, origin = `http://${host}`;
    if (req.headers.host !== host || !req.url?.startsWith('/') || req.url.startsWith('//') || req.headers.origin !== undefined && req.headers.origin !== origin
      || req.headers['sec-fetch-site'] === 'cross-site') throw failure('Request origin does not match this local workbench.', 403);
    const pathname = new URL(req.url, origin).pathname;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname.startsWith('/api/') && !allowedReads.has(pathname)) throw failure('Resource is outside this capture workspace.', 404);
      return true;
    }
    if (req.method !== 'PUT' || ![prefix + '/review', '/api/domains/fwv-ui-capture/files/catalog.json'].includes(req.url)) throw failure('Only review annotations may be saved.', 405);
    if (req.headers.origin !== origin) throw failure('Save requires the local origin.', 403);
    if (req.url === prefix + '/review' ? !equalSecret(req.headers['x-fwv-csrf'], csrfToken) : typeof req.headers['x-fwe-session'] !== 'string' || !req.headers['x-fwe-session'].trim()) throw failure('Invalid save session.', 403);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw failure('Save requires application/json.', 415);
    return true;
  };
  let server;
  try { server = await fwe.startServer(app, '127.0.0.1', port, { requestGuard: guard, quiet: true, open }); }
  catch (error) { registration.dispose(); throw error; }
  const closed = new Promise(resolve => server.once('close', resolve));
  let stopping;
  const close = () => stopping ||= (async () => { server.close(); server.closeIdleConnections?.(); await closed; })();
  closed.then(() => { registration.dispose(); signal?.removeEventListener('abort', close); });
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) await close();
  return { server, url: `http://127.0.0.1:${server.address()?.port}`, workspace, manifestPath: workspace.manifestPath, fwePath: selected, closed, close };
}
