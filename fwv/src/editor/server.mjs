import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FwvProject } from '../core/project.mjs';
import { ImagesProvider } from '../generation/provider.mjs';
import { GenerationJobs } from '../generation/jobs.mjs';
import { ReskinWorkflows } from '../workflows/reskin.mjs';
import { ArtChanges } from '../workflows/changes.mjs';

const require = createRequire(import.meta.url);
const appPath = fileURLToPath(new URL('./app/fwe.app.json', import.meta.url));
export const EDITOR_PROTOCOL = 'fwv-workbench-v1';
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
function equalSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validate the selected runtime without starting a server or changing a project. */
export async function loadEditorRuntime(fwePath) {
  if (typeof fwePath !== 'string' || !path.isAbsolute(fwePath)) throw failure('请使用绝对路径指定 FWE：--fwe-path。');
  const selectedFwePath = await realpath(fwePath);
  const metadata = JSON.parse(await readFile(path.join(selectedFwePath, 'package.json'), 'utf8'));
  if (metadata.name !== 'fwe' || metadata.version !== '0.2.0') throw failure('FWV 工作台需要 FWE 0.2.0 和受保护的服务扩展合同。');
  const fwe = require(path.join(selectedFwePath, 'src', 'server.js'));
  if (fwe.SERVER_INTEGRATION_CONTRACT?.version !== 1
    || fwe.SERVER_INTEGRATION_CONTRACT?.requestGuard !== 'await-before-routing-v1'
    || fwe.SERVER_INTEGRATION_CONTRACT?.extensions !== 'sync-setup-async-handlers-v1'
    || fwe.SERVER_INTEGRATION_CONTRACT?.configuredSurfaces !== 'native-inspector-v1'
    || typeof fwe.loadAppConfig !== 'function' || typeof fwe.startServer !== 'function') {
    throw failure('所选 FWE 缺少受保护的扩展 API 或原生配置界面合同，请显式更新该组件。');
  }
  return { fwe, selectedFwePath, metadata };
}

/** Mount the asset workbench inside one explicitly selected, trusted FWE checkout. */
export async function startEditor({ projectRoot, fwePath, port = 3230, signal, open = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw failure('端口必须为 0 到 65535 的整数。');
  signal?.throwIfAborted();
  const { fwe, selectedFwePath, metadata } = await loadEditorRuntime(fwePath);
  const fixedRoot = await realpath(projectRoot);
  const application = new FwvProject(fixedRoot);
  const initial = await application.snapshot();
  const imageProvider = new ImagesProvider();
  const generationJobs = new GenerationJobs({ project: application, provider: imageProvider });
  await generationJobs.initialize();
  const reskinWorkflows = new ReskinWorkflows({ project: application, generationJobs });
  const artChanges = new ArtChanges({ project: application, generationJobs });
  const csrfToken = randomBytes(32).toString('hex');
  const app = fwe.loadAppConfig(appPath);
  app.workspaceDir = fixedRoot;
  for (const domain of app.domains) domain.source.expectedProjectId = initial.id;
  const authoring = app.domains.find(domain => domain.id === 'fwv-authoring');
  const ui = {};
  for (const [id, relative] of Object.entries(authoring?.workbench?.editor?.configs || {})) {
    const configPath = await realpath(path.resolve(path.dirname(appPath), relative));
    const local = path.relative(path.dirname(appPath), configPath);
    if (local.startsWith('..') || path.isAbsolute(local) || !configPath.endsWith('.ui.json')) throw failure('界面配置必须位于编辑器配置目录。');
    ui[id] = JSON.parse(await readFile(configPath, 'utf8'));
  }
  app.fwvWorkbench = Object.freeze({ application, projectRoot: fixedRoot, projectId: initial.id,
    protocol: EDITOR_PROTOCOL, csrfToken, fweVersion: metadata.version, imageProvider, generationJobs, reskinWorkflows, artChanges, ui });
  const readableApi = new Set(['/api/app', '/api/domains/fwv-project/files',
    '/api/domains/fwv-project/files/fwv.project.json', '/api/fwv/session', '/api/fwv/snapshot', '/api/fwv/ui',
    '/api/domains/fwv-authoring/files', '/api/domains/fwv-authoring/files/authoring.json',
    '/api/fwv/artifact', '/api/fwv/spine/part', '/api/fwv/spine-runtime', '/api/fwv/provider', '/api/fwv/generation/jobs',
    '/api/fwv/reskin/workflows', '/api/fwv/reskin/template', '/api/fwv/reskin/local-task', '/api/fwv/rig/draft', '/api/fwv/changes', '/api/fwv/model-runtime', '/api/fwv/model',
    ...(app.clientExtensions || []).map(entry => `/api/extensions/${entry.id}/${encodeURIComponent(entry.name)}`)]);
  const guard = async (req, res) => {
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
      if (pathname.startsWith('/api/') && !readableApi.has(pathname)) throw failure('该资源不属于当前美术工作区。', 404);
      return true;
    }
    if (req.method === 'PUT' && req.url === '/api/domains/fwv-authoring/files/authoring.json') {
      if (req.headers.origin !== origin || typeof req.headers['x-fwe-session'] !== 'string' || !req.headers['x-fwe-session'].trim()) throw failure('请从 FWE 编辑会话保存草稿。', 403);
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw failure('草稿保存需要 application/json。', 415);
      return true;
    }
    if (req.method !== 'POST' || req.url !== '/api/fwv/commands') throw failure('工作台只接受 FWV 应用命令与 FWE 草稿保存，原始资产通用写入已关闭。', 405);
    if (req.headers.origin !== origin || !equalSecret(req.headers['x-fwv-csrf'], csrfToken)) throw failure('操作凭据无效，请刷新工作台重试。', 403);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw failure('操作需要 application/json 请求格式。', 415);
    return true;
  };
  const server = await fwe.startServer(app, '127.0.0.1', port, { requestGuard: guard, quiet: true, open });
  const url = `http://127.0.0.1:${server.address().port}`;
  const closed = new Promise(resolve => server.once('close', resolve));
  let shutdown;
  const close = () => shutdown ||= (async () => {
    reskinWorkflows.close(); const jobsClosed = generationJobs.close();
    server.close(); server.closeIdleConnections?.();
    await closed; await jobsClosed;
  })();
  closed.then(() => { reskinWorkflows.close(); generationJobs.close(); });
  signal?.addEventListener('abort', close, { once: true });
  closed.then(() => signal?.removeEventListener('abort', close));
  if (signal?.aborted) await close();
  return { server, url, projectRoot: fixedRoot, projectId: initial.id, fwePath: selectedFwePath, closed, close };
}
