import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { importSpine, replaceSpinePart, previewSpinePart, extractSpinePart } from '../spine/application.mjs';

const require = createRequire(import.meta.url);
const invalid = message => Object.assign(new Error(message), { status: 400 });
function decode(value) {
  if (typeof value !== 'string' || !value.length || value.length > 28 * 1024 * 1024) throw invalid('素材为空或超过单文件限制。');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value) throw invalid('素材编码无效。');
  return buffer;
}
function fields(value, names, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || names.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !names.includes(key) && !optional.includes(key))) throw invalid('Spine 操作参数不匹配。');
}

export async function executeSpineCommand(project, body) {
  const p = body.payload;
  if (body.type === 'spine.import') {
    fields(p, ['files'], ['name']);
    if (!Array.isArray(p.files) || p.files.length < 3 || p.files.length > 34) throw invalid('请选择一份 JSON、一份 Atlas 和全部 PNG 贴图（最多 32 页）。');
    const files = p.files.map(file => { fields(file, ['name', 'base64']); return { name: file.name, buffer: decode(file.base64) }; });
    if (files.reduce((sum, file) => sum + file.buffer.length, 0) > 20 * 1024 * 1024) throw invalid('整套素材超过 20 MiB。');
    return importSpine(project, { name: p.name, files });
  }
  if (body.type === 'spine.replace' || body.type === 'spine.preview') {
    fields(p, ['assetId', 'revisionId', 'regionName', 'base64', 'transform']);
    return (body.type === 'spine.preview' ? previewSpinePart : replaceSpinePart)(project, { assetId: p.assetId, revisionId: p.revisionId,
      regionName: p.regionName, buffer: decode(p.base64), transform: p.transform });
  }
  throw invalid('此版本尚未提供该操作。');
}

export async function handleSpineApi({ state, req, res, url, sendJson }) {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/api/fwv/spine-runtime') {
    try {
      const entry = require.resolve('@esotericsoftware/spine-webgl');
      const content = await readFile(path.join(path.dirname(entry), 'iife/spine-webgl.js'));
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Content-Length', content.length);
      res.writeHead(200); res.end(content);
    } catch {
      sendJson(503, { error: '未安装可选 Spine 播放器。请在 FWV 目录执行 npm ci，或继续使用部件预览。' });
    }
    return true;
  }
  if (url.pathname !== '/api/fwv/spine/part') return false;
  const names = ['assetId', 'revisionId', 'regionName'];
  if ([...url.searchParams.keys()].some(name => !names.includes(name)) || names.some(name => url.searchParams.getAll(name).length !== 1)) throw invalid('部件预览参数不匹配。');
  const content = await extractSpinePart(state.application, Object.fromEntries(names.map(name => [name, url.searchParams.get(name)])));
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', content.length);
  res.writeHead(200); res.end(content);
  return true;
}
