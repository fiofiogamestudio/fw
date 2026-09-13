import { executeSpineCommand, handleSpineApi } from './spine-api.mjs';
import { executeGenerationCommand, handleGenerationApi } from './generation-api.mjs';
import { executeReskinCommand, handleReskinApi } from './reskin-api.mjs';
import { executeRigCommand, handleRigApi } from './rig-api.mjs';
import { executeChangeCommand } from '../workflows/changes.mjs';

export const MAX_BODY_BYTES = 30 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw invalid(`操作参数不匹配，需要：${required.join('、')}。`);
}
function shortText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw invalid(`${label}必须为有效文本，最多 ${max} 个字符。`);
  return value;
}
function decodeImage(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid('图片内容不是有效的 Base64，或文件超过 20 MiB。');
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== value) throw invalid('图片内容无效。');
  return buffer;
}
export function readCommand(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) { req.resume(); return Promise.reject(invalid('上传内容超过 30 MiB，请减小图片。', 413)); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { failed = true; chunks.length = 0; reject(invalid('上传内容超过 30 MiB，请减小图片。', 413)); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(invalid('操作内容不是有效 JSON。')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(invalid('上传已中断，请重新选择文件。')));
  });
}

// All mutations go through the same application methods used by the CLI.
export async function executeCommand(application, body) {
  fields(body, ['type', 'payload']);
  const p = body.payload;
  switch (body.type) {
    case 'image.import':
      fields(p, ['fileName', 'base64'], ['name']);
      return application.importImage({ fileName: shortText(p.fileName, '文件名'),
        name: p.name === undefined ? undefined : shortText(p.name, '资源名称'), buffer: decodeImage(p.base64) });
    case 'image.process':
      fields(p, ['assetId', 'revisionId', 'recipe'], ['mode']);
      return application.processImage({ assetId: shortText(p.assetId, '资源 ID'), revisionId: shortText(p.revisionId, '版本 ID'), recipe: p.recipe, mode: p.mode });
    case 'revision.select':
    case 'revision.validate':
    case 'asset.export': {
      fields(p, ['assetId', 'revisionId']);
      const args = { assetId: shortText(p.assetId, '资源 ID'), revisionId: shortText(p.revisionId, '版本 ID') };
      const method = { 'revision.select': 'selectRevision', 'revision.validate': 'validateRevision', 'asset.export': 'exportAsset' }[body.type];
      return application[method](args);
    }
    default: return /^rig\./.test(body.type) ? executeRigCommand(application, body) : executeSpineCommand(application, body);
  }
}

export async function handleWorkbenchApi({ app, req, res, url, sendJson }) {
  const state = app.fwvWorkbench;
  if (!state) throw invalid('请通过 fwv editor 启动工作台。', 503);
  try {
    res.setHeader('Cache-Control', 'no-store');
    const current = await state.application.snapshot();
    if (current.id !== state.projectId) throw invalid('项目身份发生变化，请重启工作台。', 409);
    if (url.pathname.startsWith('/api/fwv/spine')) return await handleSpineApi({ state, req, res, url, sendJson });
    if (req.method === 'GET' && url.pathname.startsWith('/api/fwv/reskin/')) return await handleReskinApi({ state, url, sendJson });
    if (req.method === 'GET' && url.pathname.startsWith('/api/fwv/rig/')) return await handleRigApi({ state, url, sendJson });
    if (req.method === 'GET' && (url.pathname === '/api/fwv/provider' || url.pathname === '/api/fwv/generation/jobs')) return handleGenerationApi({ state, url, sendJson });
    if (req.method === 'GET' && url.pathname === '/api/fwv/changes') {
      const keys = [...url.searchParams.keys()];
      if (keys.length > 1 || keys.some(key => key !== 'changeId')) throw invalid('素材修改查询参数不匹配。');
      sendJson(200, keys.length ? { change: await state.artChanges.get({ changeId: url.searchParams.get('changeId') }) } : { changes: await state.artChanges.list() }); return true;
    }
    if (req.method === 'GET' && ['/api/fwv/model-runtime', '/api/fwv/model'].includes(url.pathname)) {
      const { handleModelApi } = await import('./model-api.mjs');
      return await handleModelApi({ state, req, res, url, sendJson });
    }
    if (req.method === 'GET' && url.pathname === '/api/fwv/session') {
      sendJson(200, { protocol: state.protocol, projectId: state.projectId, projectRoot: state.projectRoot,
        csrfToken: state.csrfToken, fweVersion: state.fweVersion }); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwv/snapshot') { sendJson(200, current); return true; }
    if (req.method === 'GET' && url.pathname === '/api/fwv/ui') { sendJson(200, state.ui); return true; }
    if (req.method === 'GET' && url.pathname === '/api/fwv/artifact') {
      const allowed = ['assetId', 'revisionId', 'fileName'];
      if ([...url.searchParams.keys()].some(key => !allowed.includes(key))
        || allowed.some(key => url.searchParams.getAll(key).length !== 1)) throw invalid('预览参数不匹配。');
      const artifact = await state.application.readArtifact(Object.fromEntries(allowed.map(key => [key, shortText(url.searchParams.get(key), key)])));
      res.setHeader('Content-Type', artifact.mime);
      res.setHeader('Content-Length', artifact.buffer.length);
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
      res.writeHead(200); res.end(artifact.buffer); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/fwv/commands') {
      const body = await readCommand(req);
      const result = /^model\./.test(body?.type || '') ? await (await import('./model-api.mjs')).executeModelCommand(state, body)
        : /^change\./.test(body?.type || '') ? await executeChangeCommand(state.artChanges, body)
        : /^reskin\./.test(body?.type || '') ? await executeReskinCommand(state, body)
        : /^(provider|generation)\./.test(body?.type || '') ? await executeGenerationCommand(state, body) : await executeCommand(state.application, body);
      sendJson(200, { ok: true, result }); return true;
    }
    return false;
  } catch (error) {
    sendJson(error.status || 400, { error: /[\u3400-\u9fff]/.test(error.message) ? error.message : `操作无法完成：${error.message}`, code: error.code || 'fwv-command-failed' }); return true;
  }
}
