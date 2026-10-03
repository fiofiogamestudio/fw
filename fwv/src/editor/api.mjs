import { executeSkeleton2dCommand, handleSkeleton2dApi } from './skeleton2d-api.mjs';
import { handleImageApi, isGalleryImage } from './gallery2d-api.mjs';

export const MAX_BODY_BYTES = 30 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
// Browser image grids arrive in bursts. Share only a pending read, never retain
// completed metadata: later requests re-read project identity and registration.
const imageSnapshotReads = new WeakMap();
function imageSnapshot(application) {
  let pending = imageSnapshotReads.get(application);
  if (!pending) {
    pending = new Promise(resolve => setTimeout(resolve, 10)).then(() => application._load());
    imageSnapshotReads.set(application, pending);
    pending.finally(() => { if (imageSnapshotReads.get(application) === pending) imageSnapshotReads.delete(application); }).catch(() => {});
  }
  return pending;
}
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
// All mutations go through the same application methods used by the CLI.
export async function executeCommand(application, body) {
  fields(body, ['type', 'payload']);
  if (/^skeleton2d\./.test(body.type)) return executeSkeleton2dCommand(application, body);
  const p = body.payload;
  switch (body.type) {
    case 'image.import':
      fields(p, ['fileName', 'base64'], ['name']);
      return application.importImage({ fileName: shortText(p.fileName, '文件名'),
        name: p.name === undefined ? undefined : shortText(p.name, '资源名称'), buffer: decodeImage(p.base64) });
    case 'revision.select':
    case 'revision.validate':
    case 'asset.export': {
      fields(p, ['assetId', 'revisionId']);
      const args = { assetId: shortText(p.assetId, '资源 ID'), revisionId: shortText(p.revisionId, '版本 ID') };
      const snapshot = await application._load(), asset = application._asset(snapshot, args.assetId), revision = application._revision(asset, args.revisionId);
      if (['model3d', 'rig', 'reskin'].includes(asset.kind) || asset.kind !== 'skeleton2d' && !revision.files.some(isGalleryImage)) throw invalid('此操作仅支持 2D 图片素材与 2D 骨骼动画。');
      const method = { 'revision.select': 'selectRevision', 'revision.validate': 'validateRevision', 'asset.export': 'exportAsset' }[body.type];
      return application[method](args);
    }
    default: throw invalid('此编辑器仅提供 2D 图片导入、2D 骨骼编辑与版本操作。');
  }
}

export async function handleWorkbenchApi({ app, req, res, url, sendJson, readBody, parseJson }) {
  const state = app.fwvWorkbench;
  if (!state) throw invalid('请通过 fwv editor 启动工作台。', 503);
  try {
    res.setHeader('Cache-Control', 'no-store');
    const current = await (['/api/fwv/image', '/api/fwv/skeleton2d-thumbnail'].includes(url.pathname) ? imageSnapshot(state.application) : state.application.snapshot());
    if (current.id !== state.projectId) throw invalid('项目身份发生变化，请重启工作台。', 409);
    if (url.pathname === '/api/fwv/image') return await handleImageApi({ state, req, res, url, snapshot: current });
    if (['/api/fwv/skeleton2d', '/api/fwv/skeleton2d-runtime', '/api/fwv/skeleton2d-thumbnail'].includes(url.pathname)) return await handleSkeleton2dApi({ state, req, res, url, sendJson, snapshot: current });
    if (req.method === 'GET' && url.pathname === '/api/fwv/session') {
      sendJson(200, { protocol: state.protocol, projectId: state.projectId, projectRoot: state.projectRoot,
        csrfToken: state.csrfToken, fweVersion: state.fweVersion }); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwv/snapshot') { sendJson(200, current); return true; }
    if (req.method === 'GET' && url.pathname === '/api/fwv/ui') { sendJson(200, state.ui); return true; }
    if (req.method === 'POST' && url.pathname === '/api/fwv/commands') {
      const body = parseJson(await readBody({ maxBytes: MAX_BODY_BYTES }));
      const result = await executeCommand(state.application, body);
      sendJson(200, { ok: true, result }); return true;
    }
    return false;
  } catch (error) {
    sendJson(error.status || 400, { error: /[\u3400-\u9fff]/.test(error.message) ? error.message : `操作无法完成：${error.message}`, code: error.code || 'fwv-command-failed' }); return true;
  }
}
