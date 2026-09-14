import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbenchState } from './state.mjs';

const require = createRequire(import.meta.url);
const appPath = fileURLToPath(new URL('./app/fwe.app.json', import.meta.url));
export const EDITOR_PROTOCOL = 'fwb-workbench-v1';
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
function equalSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function loadEditorRuntime(fwePath) {
  if (typeof fwePath !== 'string' || !path.isAbsolute(fwePath)) throw failure('请使用绝对路径指定 FWE：--fwe-path。');
  const selectedFwePath = await realpath(fwePath);
  const metadata = JSON.parse(await readFile(path.join(selectedFwePath, 'package.json'), 'utf8'));
  if (metadata.name !== 'fwe' || metadata.version !== '0.2.0') throw failure('FWB 工作台需要 FWE 0.2.0。');
  const fwe = require(path.join(selectedFwePath, 'src', 'server.js'));
  if (fwe.SERVER_INTEGRATION_CONTRACT?.version !== 1
    || fwe.SERVER_INTEGRATION_CONTRACT?.requestGuard !== 'await-before-routing-v1'
    || fwe.SERVER_INTEGRATION_CONTRACT?.extensions !== 'sync-setup-async-handlers-v1'
    || typeof fwe.loadAppConfig !== 'function' || typeof fwe.startServer !== 'function') {
    throw failure('所选 FWE 缺少受保护的扩展 API，请显式更新该组件。');
  }
  return { fwe, selectedFwePath, metadata };
}

export async function startEditor({ projectRoot, fwePath, port = 0, signal, open = false, services } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw failure('端口必须为 0 到 65535 的整数。');
  signal?.throwIfAborted();
  const { fwe, selectedFwePath, metadata } = await loadEditorRuntime(fwePath);
  const fixedRoot = await realpath(projectRoot);
  const state = await createWorkbenchState(fixedRoot, services);
  const csrfToken = randomBytes(32).toString('hex');
  const app = fwe.loadAppConfig(appPath);
  app.workspaceDir = fixedRoot;
  app.fwbWorkbench = Object.assign(state, { protocol: EDITOR_PROTOCOL, csrfToken, fweVersion: metadata.version });
  const readableApi = new Set(['/api/app', '/api/domains/fwb-project/files', '/api/domains/fwb-project/files/fwb.project.json',
    '/api/fwb/session', '/api/fwb/snapshot', '/api/fwb/job', '/api/fwb/artifact', '/api/fwb/config', '/api/fwb/environment', '/api/fwb/releases', '/api/fwb/release', '/api/fwb/download',
    ...(app.clientExtensions || []).map(entry => `/api/extensions/${entry.id}/${encodeURIComponent(entry.name)}`)]);
  const guard = async (req, res) => {
    app.workspaceDir = state.projectRoot;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const host = `127.0.0.1:${req.socket.localPort}`, origin = `http://${host}`;
    if (req.headers.host !== host || !req.url?.startsWith('/') || req.url.startsWith('//')
      || (req.headers.origin !== undefined && req.headers.origin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site') throw failure('请求来源不匹配。请从本机工作台地址访问。', 403);
    const pathname = new URL(req.url, origin).pathname;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname.startsWith('/api/') && !readableApi.has(pathname)) throw failure('该资源不属于当前构建工程。', 404);
      return true;
    }
    if (req.method !== 'POST' || req.url !== '/api/fwb/commands') throw failure('工作台只接受 FWB 构建命令。', 405);
    if (req.headers.origin !== origin || !equalSecret(req.headers['x-fwb-csrf'], csrfToken)) throw failure('操作凭据无效，请刷新工作台重试。', 403);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw failure('操作需要 application/json。', 415);
    return true;
  };
  const server = await fwe.startServer(app, '127.0.0.1', port, { requestGuard: guard, quiet: true, open });
  const url = `http://127.0.0.1:${server.address().port}`;
  const closed = new Promise(resolve => server.once('close', resolve));
  let shutdown;
  const close = () => shutdown ||= (async () => {
    server.close(); server.closeIdleConnections?.();
    await closed; await state.close();
  })();
  signal?.addEventListener('abort', close, { once: true });
  closed.then(() => signal?.removeEventListener('abort', close));
  if (signal?.aborted) await close();
  return { server, url, projectRoot: fixedRoot, fwePath: selectedFwePath, closed, close };
}
