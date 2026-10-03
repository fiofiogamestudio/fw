import { readFile } from 'node:fs/promises';
import { importSkeleton2d, inspectSkeleton2d, readSkeleton2dBundle, saveSkeleton2d, exportSkeleton2d } from '../skeleton2d/application.mjs';
import { renderSkeleton2dThumbnail } from '../skeleton2d/thumbnail.mjs';
const fail = message => Object.assign(new Error(message), { status: 400, code: 'SKELETON2D_INVALID' });
const thumbnailStates = new WeakMap();
const MAX_THUMBNAIL_BYTES = 16 * 1024 * 1024;
async function readThumbnail(project, reference, snapshot) {
  let state = thumbnailStates.get(project);
  if (!state) { state = { cache: new Map(), bytes: 0, active: 0, waiting: [] }; thumbnailStates.set(project, state); }
  if (state.active >= 4) await new Promise(resolve => state.waiting.push(resolve));
  else state.active++;
  try {
    // Always verify the exact document and every registered texture, including
    // cache hits. A stale preview must not conceal changed or invalid sources.
    const bundle = await readSkeleton2dBundle(project, reference, { snapshot });
    const key = JSON.stringify([bundle.asset.id, bundle.revision.id, bundle.revision.files.map(file => [file.name, file.sha256, file.bytes])]);
    const cached = state.cache.get(key);
    if (cached) { state.cache.delete(key); state.cache.set(key, cached); return cached; }
    const buffer = await renderSkeleton2dThumbnail(bundle);
    if (buffer.length <= MAX_THUMBNAIL_BYTES) {
      while (state.bytes + buffer.length > MAX_THUMBNAIL_BYTES && state.cache.size) {
        const oldest = state.cache.keys().next().value; state.bytes -= state.cache.get(oldest).length; state.cache.delete(oldest);
      }
      if (state.cache.has(key)) state.bytes -= state.cache.get(key).length;
      state.cache.set(key, buffer); state.bytes += buffer.length;
    }
    return buffer;
  } finally { if (state.waiting.length) state.waiting.shift()(); else state.active--; }
}
function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw fail('2D 操作参数不匹配。');
}
export async function executeSkeleton2dCommand(application, body) {
  fields(body, ['type', 'payload']); const p = body.payload;
  if (body.type === 'skeleton2d.import') {
    fields(p, ['document', 'textures'], ['name', 'idempotencyKey']);
    if (!Array.isArray(p.textures) || p.textures.length > 63) throw fail('2D 素材最多包含 63 张 PNG 纹理。');
    const textures = p.textures.map(file => {
      fields(file, ['name', 'base64']);
      if (typeof file.base64 !== 'string' || file.base64.length > 28 * 1024 * 1024) throw fail('2D 纹理数据无效。');
      const buffer = Buffer.from(file.base64, 'base64'); if (!buffer.length || buffer.toString('base64') !== file.base64) throw fail('2D 纹理不是有效的 Base64。');
      return { name: file.name, buffer };
    });
    return importSkeleton2d(application, { ...p, textures });
  }
  if (body.type === 'skeleton2d.save') {
    fields(p, ['assetId', 'revisionId', 'expectedRevisionId', 'document']); return saveSkeleton2d(application, p);
  }
  if (body.type === 'skeleton2d.export') {
    fields(p, ['assetId', 'revisionId']); return exportSkeleton2d(application, p);
  }
  throw fail('未知的 2D 操作。');
}

export async function handleSkeleton2dApi({ state, req, res, url, sendJson, snapshot }) {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/api/fwv/skeleton2d-runtime') {
    if ([...url.searchParams].length) throw fail('2D 运行模块不接受路径或查询参数。');
    // Fixed browser-safe modules only. The editor and storage boundary share
    // one validator, including weighted mesh references and topology.
    const content = Buffer.concat(await Promise.all(['document.mjs', 'sample.mjs'].map(name => readFile(new URL(`../skeleton2d/${name}`, import.meta.url)).then(buffer => Buffer.concat([buffer, Buffer.from('\n')])))));
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': content.length }); res.end(content); return true;
  }
  if (!['/api/fwv/skeleton2d', '/api/fwv/skeleton2d-thumbnail'].includes(url.pathname)) return false;
  const allowed = ['assetId', 'revisionId'];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) || allowed.some(key => url.searchParams.getAll(key).length !== 1)) throw fail('2D 查询要求明确的资产和版本。');
  if (url.pathname === '/api/fwv/skeleton2d-thumbnail') {
    const buffer = await readThumbnail(state.application, Object.fromEntries(url.searchParams), snapshot);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buffer.length }); res.end(buffer); return true;
  }
  sendJson(200, await inspectSkeleton2d(state.application, Object.fromEntries(url.searchParams), { includeTextures: true, snapshot })); return true;
}
