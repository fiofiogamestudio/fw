import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { importModel, inspectModel, modelTexture, modelVertex, extractModelTexture, repairModelCandidate } from '../model/application.mjs';

const require = createRequire(import.meta.url), fail = message => Object.assign(new Error(message), { status: 400, code: 'MODEL_INVALID' });
function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw fail('3D 操作参数不匹配。');
}
export async function executeModelCommand(state, body) {
  fields(body, ['type', 'payload']); const p = body.payload;
  if (body.type === 'model.import') {
    fields(p, ['fileName', 'base64'], ['name']);
    if (typeof p.base64 !== 'string' || !p.base64.length || p.base64.length > Math.ceil(20 * 1024 * 1024 / 3) * 4) throw fail('GLB 内容为空或超过 20 MiB。');
    const buffer = Buffer.from(p.base64, 'base64'); if (buffer.toString('base64') !== p.base64) throw fail('GLB 编码无效。');
    return importModel(state.application, { fileName: p.fileName, name: p.name, buffer });
  }
  if (body.type === 'model.candidate.repair') {
    fields(p, ['changeId', 'requestId'], ['boneEdits', 'weightEdits', 'textureEdits', 'note']); return repairModelCandidate(state, p);
  }
  if (body.type === 'model.texture.extract') { fields(p, ['assetId', 'revisionId', 'imageIndex']); return extractModelTexture(state.application, p); }
  throw fail('未知的 3D 操作。');
}

// Serve a fixed, local dependency graph. No arbitrary filesystem module or CDN URL is accepted.
const modules = { three: 'build/three.module.js', core: 'build/three.core.js', loader: 'examples/jsm/loaders/GLTFLoader.js', orbit: 'examples/jsm/controls/OrbitControls.js', geometry: 'examples/jsm/utils/BufferGeometryUtils.js', skeleton: 'examples/jsm/utils/SkeletonUtils.js' };
const runtime = id => `/api/fwv/model-runtime?module=${id}`;
const moduleCache = new Map();
async function moduleSource(id) {
  if (!Object.hasOwn(modules, id)) throw fail('未知的 3D 运行模块。');
  if (!moduleCache.has(id)) {
    const base = path.resolve(path.dirname(require.resolve('three')), '..');
    let content = await readFile(path.join(base, modules[id]), 'utf8');
    for (const [specifier, target] of Object.entries({ three: 'three', './three.core.js': 'core', '../utils/BufferGeometryUtils.js': 'geometry', '../utils/SkeletonUtils.js': 'skeleton' })) {
      content = content.replaceAll(`from '${specifier}'`, `from '${runtime(target)}'`).replaceAll(`from "${specifier}"`, `from "${runtime(target)}"`);
    }
    moduleCache.set(id, content);
  }
  return moduleCache.get(id);
}
export async function handleModelApi({ state, req, res, url, sendJson }) {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/api/fwv/model-runtime') {
    if ([...url.searchParams.keys()].join(',') !== 'module') throw fail('运行模块参数不匹配。');
    const content = await moduleSource(url.searchParams.get('module'));
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': Buffer.byteLength(content) }); res.end(content); return true;
  }
  if (url.pathname !== '/api/fwv/model') return false;
  const input = Object.fromEntries(url.searchParams), allowed = ['assetId', 'revisionId', 'view', 'imageIndex', 'meshIndex', 'primitiveIndex', 'vertexIndex'];
  if ([...url.searchParams.keys()].some(k => !allowed.includes(k) || url.searchParams.getAll(k).length !== 1) || !input.assetId || !input.revisionId) throw fail('模型查询参数不匹配。');
  for (const key of ['imageIndex', 'meshIndex', 'primitiveIndex', 'vertexIndex']) if (input[key] !== undefined) { if (!/^\d+$/.test(input[key])) throw fail('模型索引必须是非负整数。'); input[key] = Number(input[key]); }
  if (!input.view) { fields(input, ['assetId', 'revisionId']); sendJson(200, await inspectModel(state.application, input)); }
  else if (input.view === 'texture') {
    fields(input, ['assetId', 'revisionId', 'view', 'imageIndex']); const texture = await modelTexture(state.application, input);
    res.writeHead(200, { 'Content-Type': texture.mime, 'Content-Length': texture.buffer.length }); res.end(texture.buffer);
  } else if (input.view === 'vertex') { fields(input, ['assetId', 'revisionId', 'view', 'meshIndex', 'primitiveIndex', 'vertexIndex']); sendJson(200, await modelVertex(state.application, input)); }
  else throw fail('未知的模型查询。');
  return true;
}
