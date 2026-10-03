import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { FwvProject } from '../core/project.mjs';
import { validateSkeleton2dDocument } from '../skeleton2d/document.mjs';

export const AUTHORING_FILE = 'authoring.json';
export const AUTHORING_STORAGE_FILE = 'editor-drafts.json';
export const MAX_AUTHORING_BYTES = 16 * 1024 * 1024;
export const AUTHORING_COLLECTIONS = Object.freeze(['skeleton2dDrafts']);
// Historical data stays opaque on disk. No retired workflow implementation is
// imported, exposed in the editable model, or allowed in a client save payload.
const LEGACY_COLLECTIONS = Object.freeze(['gallery2dDrafts', 'reskinDrafts', 'rigDrafts', 'imageDrafts', 'generationDrafts', 'spineDrafts', 'changeDrafts']);
const failure = (message, status = 400, code = 'INVALID_AUTHORING_DRAFT') => Object.assign(new Error(message), { status, code });
const conflict = () => failure('参数草稿已被其他窗口或进程修改。请重新载入并核对后保存。', 409, 'AUTHORING_REVISION_CONFLICT');
const hash = bytes => `fwv-drafts-sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const credentialKeys = new Set(['apikey', 'apikeys', 'authorization', 'accesstoken', 'refreshtoken', 'sessiontoken', 'bearertoken', 'password', 'clientsecret', 'privatekey', 'secretkey', 'csrf', 'csrftoken']);
function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw failure(`${label} 必须是 JSON 对象。`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw failure(`${label} 包含未知字段：${key}。`);
}
function limitedJson(value) {
  let nodes = 0; const ancestors = new Set();
  function visit(item, depth, skeleton2d = false) {
    if (++nodes > 2000000 || depth > (skeleton2d ? 36 : 24)) throw failure('参数草稿结构过大或嵌套过深。');
    if (typeof item === 'string') { if (item.length > (skeleton2d ? 4 * 1024 * 1024 : 32768)) throw failure('单个草稿文本超过容量上限。'); return; }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (!Array.isArray(item) && !plainObject(item)) throw failure('草稿只能包含有限数值和 JSON 数据。');
    if (ancestors.has(item)) throw failure('草稿不能包含循环引用。'); ancestors.add(item);
    // Weighted vertices encode up to 4096 points * (count + 4 influences * 4).
    // Domain validation supplies the tighter topology and per-field limits.
    const entries = Object.entries(item); if (entries.length > (skeleton2d ? 69632 : 4096)) throw failure('单个草稿集合过大。');
    for (const [key, child] of entries) {
      if (key.length > 160 || ['__proto__', 'prototype', 'constructor'].includes(key) || credentialKeys.has(key.replace(/[-_\s]/g, '').toLowerCase())) throw failure('参数草稿不能包含凭据、API Key 或保留字段。');
      visit(child, depth + 1, skeleton2d || key === 'skeleton2dDrafts');
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  let serialized; try { serialized = JSON.stringify(value); } catch { throw failure('草稿必须可以序列化为 JSON。'); }
  if (Buffer.byteLength(serialized) > MAX_AUTHORING_BYTES) throw failure('参数草稿超过 16 MiB 上限。', 413);
}
function typedFields(data, specification, label) {
  exactKeys(data, Object.keys(specification), label);
  for (const [key, value] of Object.entries(data)) {
    const type = specification[key];
    const valid = type === 'object' && plainObject(value) || type === 'int' && Number.isSafeInteger(value)
      || type === 'number' && typeof value === 'number' && Number.isFinite(value)
      || type === 'string' && typeof value === 'string' || type === 'boolean' && typeof value === 'boolean';
    if (!valid) throw failure(`${label}.${key} 的字段类型无效。`);
    if (typeof value === 'string' && value.length > 160) throw failure(`${label}.${key} 不能超过 160 个字符。`);
  }
}
const specifications = {
  skeleton2dDrafts: { assetId: 'string', revisionId: 'string', document: 'object', skin: 'string', animation: 'string', bone: 'string', slot: 'string', attachment: 'string', channel: 'string', frameIndex: 'int', time: 'number', speed: 'number', showBones: 'boolean', frame: 'object', attachmentTransform: 'object' },
};

export function validateAuthoringData(data, expectedProjectId) {
  limitedJson(data); exactKeys(data, ['schemaVersion', 'projectId', ...AUTHORING_COLLECTIONS], '参数草稿');
  if (data.schemaVersion !== 1) throw failure('不支持此参数草稿版本。');
  if (typeof expectedProjectId !== 'string' || data.projectId !== expectedProjectId) throw failure('参数草稿的项目身份不匹配。', 409, 'AUTHORING_PROJECT_CONFLICT');
  for (const collection of AUTHORING_COLLECTIONS) {
    const maximum = 200;
    if (!Array.isArray(data[collection]) || data[collection].length > maximum) throw failure(`${collection} 必须是最多包含 ${maximum} 项的数组。`);
    const ids = new Set();
    for (const entry of data[collection]) {
      exactKeys(entry, ['id', 'data'], collection);
      if (typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 160 || /[\x00-\x1f]/.test(entry.id) || ids.has(entry.id)) throw failure(`${collection} 的草稿标识无效或重复。`);
      ids.add(entry.id);
      if (Buffer.byteLength(JSON.stringify(entry)) > 5 * 1024 * 1024) throw failure('单个参数草稿超过容量上限。', 413);
      typedFields(entry.data, specifications[collection], `${collection}.${entry.id}`);
      const d = entry.data;
      if (d.document) validateSkeleton2dDocument(d.document);
      if (d.channel !== undefined && !['translate', 'rotate', 'scale'].includes(d.channel)) throw failure('2D 骨骼关键帧轨道无效。');
      if (d.time !== undefined && (d.time < 0 || d.time > 86400)) throw failure('2D 骨骼时间范围无效。');
      if (d.speed !== undefined && (d.speed < 0.1 || d.speed > 4)) throw failure('2D 骨骼播放速度范围无效。');
      if (d.frame !== undefined) typedFields(d.frame, { time: 'number', x: 'number', y: 'number', value: 'number', curve: 'string' }, '2D 关键帧');
      if (d.attachmentTransform !== undefined) typedFields(d.attachmentTransform, { x: 'number', y: 'number', rotation: 'number', scaleX: 'number', scaleY: 'number', width: 'number', height: 'number' }, '2D 附件变换');
    }
  }
  return structuredClone(data);
}
function emptyDocument(projectId) { return { schemaVersion: 1, projectId, skeleton2dDrafts: [] }; }
function decimalValue(text) {
  const [mantissa, exponent = '0'] = text.toLowerCase().split('e'), negative = mantissa.startsWith('-');
  const fraction = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
  const digits = mantissa.replace(/[-.]/g, '').replace(/^0+/, '');
  if (!digits) return negative ? '-0' : '0';
  const coefficient = digits.replace(/0+$/, '');
  return `${negative ? '-' : ''}${coefficient}e${Number(exponent) - fraction + digits.length - coefficient.length}`;
}
function assertLegacyNumbersLossless(source = '') {
  // JSON.parse has already validated this text. Scan tokens only to identify
  // numbers inside opaque top-level fields; active drafts keep their own rules.
  let depth = 0, expectsKey = true, legacy = false;
  for (const [token] of source.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (token === '{' || token === '[') depth++;
    else if (token === '}' || token === ']') depth--;
    else if (depth === 1 && token === ',') { expectsKey = true; legacy = false; }
    else if (depth === 1 && expectsKey && token.startsWith('"')) { legacy = LEGACY_COLLECTIONS.includes(JSON.parse(token)); expectsKey = false; }
    else if (legacy && /^-?\d/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value) || decimalValue(token) !== decimalValue(JSON.stringify(value))) {
        throw failure('历史参数草稿包含无法无损保存的数字；原文件已保留，请先用原工具处理该历史数据。', 422, 'AUTHORING_LEGACY_LOSSY');
      }
    }
  }
}
async function assertProject(project, expectedProjectId) {
  const snapshot = await project.snapshot();
  if (typeof expectedProjectId !== 'string' || snapshot.id !== expectedProjectId) throw failure('项目身份变化，请重启工作台。', 409, 'AUTHORING_PROJECT_CONFLICT');
}
async function readStored(project, projectId) {
  const target = await project._path(['.fwv', AUTHORING_STORAGE_FILE]); let bytes;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_AUTHORING_BYTES) throw failure('已有参数草稿不是有效文件或超过 16 MiB 上限。', 413);
    bytes = await fs.readFile(target); if (bytes.length > MAX_AUTHORING_BYTES) throw failure('已有参数草稿超过 16 MiB 上限。', 413);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { resource: { name: AUTHORING_FILE, type: 'json', exists: false, revision: `fwv-drafts-missing:${projectId}`, data: emptyDocument(projectId) }, legacy: {} };
  }
  const sourceText = bytes.toString('utf8');
  let parsed; try { parsed = JSON.parse(sourceText); } catch { throw failure('已有参数草稿损坏，无法读取；文件已保留。', 422, 'AUTHORING_CORRUPT'); }
  exactKeys(parsed, ['schemaVersion', 'projectId', ...AUTHORING_COLLECTIONS, ...LEGACY_COLLECTIONS], '已有参数草稿');
  const active = { schemaVersion: parsed.schemaVersion, projectId: parsed.projectId, ...Object.fromEntries(AUTHORING_COLLECTIONS.map(key => [key, Object.hasOwn(parsed, key) ? parsed[key] : []])) };
  const legacy = Object.fromEntries(LEGACY_COLLECTIONS.filter(key => Object.hasOwn(parsed, key)).map(key => [key, parsed[key]]));
  return { resource: { name: AUTHORING_FILE, type: 'json', exists: true, revision: hash(bytes), data: validateAuthoringData(active, projectId) }, legacy, sourceText };
}
export async function readAuthoring({ projectRoot, expectedProjectId }) {
  const project = new FwvProject(projectRoot); await assertProject(project, expectedProjectId);
  return (await readStored(project, expectedProjectId)).resource;
}
export async function writeAuthoring({ projectRoot, expectedProjectId, payload }) {
  exactKeys(payload, ['data', 'revision', 'createOnly'], '保存参数');
  if (payload.createOnly !== undefined && typeof payload.createOnly !== 'boolean') throw failure('createOnly 必须为布尔值。');
  if (payload.revision !== undefined && (typeof payload.revision !== 'string' || payload.revision.length > 200)) throw failure('参数草稿版本标识无效。');
  const data = validateAuthoringData(payload.data, expectedProjectId), project = new FwvProject(projectRoot);
  return project._withLock(async () => {
    await assertProject(project, expectedProjectId);
    const stored = await readStored(project, expectedProjectId), current = stored.resource;
    if (payload.createOnly === true ? current.exists : !current.exists || typeof payload.revision !== 'string' || payload.revision !== current.revision) throw conflict();
    assertLegacyNumbersLossless(stored.sourceText);
    // Merge only the CAS-matched legacy disk fields. Clients cannot replace or
    // erase them because their payload permits active skeleton drafts only.
    // Keep the 16 MiB storage guard; indentation must not consume the capacity
    // of otherwise valid weighted meshes in a multi-character draft session.
    const bytes = Buffer.from(`${JSON.stringify({ ...stored.legacy, ...data })}\n`);
    if (bytes.length > MAX_AUTHORING_BYTES) throw failure('参数草稿超过 16 MiB 上限。', 413);
    await project._path(['.fwv'], { mkdir: true });
    const target = await project._path(['.fwv', AUTHORING_STORAGE_FILE]), temp = await project._path(['.fwv', `.editor-drafts-${randomUUID()}.tmp`]);
    try {
      const handle = await fs.open(temp, 'wx'); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (payload.createOnly === true) {
        try { await fs.link(temp, target); } catch (error) { if (error.code === 'EEXIST') throw conflict(); throw error; }
        return { name: AUTHORING_FILE, revision: hash(bytes), exists: true };
      }
      const deadline = Date.now() + 1500;
      while (true) {
        try { await fs.rename(temp, target); break; }
        catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error; await delay(40); }
      }
    } finally { await fs.rm(temp, { force: true }); }
    return { name: AUTHORING_FILE, revision: hash(bytes), exists: true };
  });
}
