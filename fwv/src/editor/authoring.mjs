import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { FwvProject } from '../core/project.mjs';
import { RIG_LIMITS } from '../rig/geometry.mjs';

export const AUTHORING_FILE = 'authoring.json';
export const AUTHORING_STORAGE_FILE = 'editor-drafts.json';
export const MAX_AUTHORING_BYTES = 1024 * 1024;
export const AUTHORING_COLLECTIONS = Object.freeze(['reskinDrafts', 'rigDrafts', 'imageDrafts', 'generationDrafts', 'spineDrafts', 'changeDrafts']);
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
  let nodes = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    if (++nodes > 40000 || depth > 24) throw failure('参数草稿结构过大或嵌套过深。');
    if (typeof item === 'string') { if (item.length > 32768) throw failure('单个草稿文本不能超过 32768 个字符。'); return; }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (!Array.isArray(item) && !plainObject(item)) throw failure('草稿只能包含有限数值和 JSON 数据。');
    if (ancestors.has(item)) throw failure('草稿不能包含循环引用。');
    ancestors.add(item);
    const entries = Object.entries(item);
    if (entries.length > 4096) throw failure('单个草稿集合过大。');
    for (const [key, child] of entries) {
      if (key.length > 160 || ['__proto__', 'prototype', 'constructor'].includes(key) || credentialKeys.has(key.replace(/[-_\s]/g, '').toLowerCase())) {
        throw failure('参数草稿不能包含凭据、API Key 或保留字段。');
      }
      visit(child, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw failure('草稿必须可以序列化为 JSON。'); }
  if (Buffer.byteLength(serialized) > MAX_AUTHORING_BYTES) throw failure('参数草稿超过 1 MiB 上限。', 413);
  return serialized;
}

function typedFields(data, specification, label) {
  exactKeys(data, Object.keys(specification), label);
  for (const [key, value] of Object.entries(data)) {
    const type = specification[key];
    const valid = type === 'json' || type === 'object' && plainObject(value) || type === 'array' && Array.isArray(value)
      || type === 'string[]' && Array.isArray(value) && value.length <= 256 && value.every(item => typeof item === 'string' && item.length <= 160)
      || type === 'int' && Number.isSafeInteger(value) || type === 'number' && typeof value === 'number' && Number.isFinite(value)
      || type === 'string' && typeof value === 'string' || type === 'boolean' && typeof value === 'boolean';
    if (!valid) throw failure(`${label}.${key} 的字段类型无效。`);
    if (typeof value === 'string') {
      const maximum = key === 'prompt' ? 8000 : key === 'request' ? 4000 : ['preserve', 'comment', 'note'].includes(key) ? 2000 : ['region', 'objects'].includes(key) ? 4096 : key === 'brief' ? 1800 : key === 'style' ? 700 : 160;
      if (value.length > maximum) throw failure(`${label}.${key} 不能超过 ${maximum} 个字符。`);
    }
  }
}

const specifications = {
  changeDrafts: { assetId: 'string', revisionId: 'string', title: 'string', request: 'string', preserve: 'string', region: 'object', objects: 'string', animationName: 'string', time: 'number', changeId: 'string', candidateId: 'string', executionMode: 'string', comment: 'string', note: 'string', size: 'string', quality: 'string', background: 'string', zoom: 'number', spineRepair: 'object' },
  reskinDrafts: { name: 'string', brief: 'string', style: 'string', mode: 'string', templateAssetId: 'string', templateRevisionId: 'string', selected: 'string[]', notes: 'object', transforms: 'object', attemptId: 'string', preserveAlpha: 'boolean' },
  rigDrafts: { assetId: 'string', revisionId: 'string', document: 'json', saved: 'json', selectedPartId: 'string', candidate: 'json', mode: 'string', drawing: 'array', sourceAssetId: 'string', sourceRevisionId: 'string', name: 'string' },
  imageDrafts: { assetId: 'string', revisionId: 'string', processingMode: 'string', recipe: 'object' },
  generationDrafts: { name: 'string', prompt: 'string', size: 'string', quality: 'string', background: 'string', referenceAssetId: 'string', referenceRevisionId: 'string', referenceFileName: 'string' },
  spineDrafts: { partDrafts: 'array', assetId: 'string', revisionId: 'string', regionName: 'string', libraryImageId: 'string', replacementAssetId: 'string', replacementRevisionId: 'string', replacementFileName: 'string', transform: 'object', animation: 'string', skin: 'string', playing: 'boolean', time: 'number' }
};

function rigDraftPoint(value, label, { nullable = false } = {}) {
  exactKeys(value, ['x', 'y'], label);
  for (const coordinate of ['x', 'y']) {
    if (nullable && value[coordinate] === null) continue;
    if (typeof value[coordinate] !== 'number' || !Number.isFinite(value[coordinate])) throw failure(`${label}.${coordinate} 必须是有限数值${nullable ? '或尚未填写的 null' : ''}。`);
  }
}

/** Only the shape needed to reopen the canvas: unfinished geometry remains editable. */
function rigDraftDocument(document, label) {
  if (!plainObject(document) || document.schemaVersion !== 1 || !plainObject(document.source) || !Array.isArray(document.parts) || !plainObject(document.motion)) {
    throw failure(`${label} 缺少可恢复的 source、parts、motion 或 schemaVersion。`);
  }
  const source = document.source;
  for (const field of ['assetId', 'revisionId', 'fileName', 'referenceFile']) {
    if (typeof source[field] !== 'string' || !source[field] || source[field].length > 160) throw failure(`${label}.source.${field} 必须是有效的素材引用文本。`);
  }
  if (![source.width, source.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= RIG_LIMITS.dimension) || source.width * source.height > RIG_LIMITS.sourcePixels) throw failure(`${label} 的原图尺寸无效。`);
  if (document.parts.length > RIG_LIMITS.parts) throw failure(`${label} 最多保留 ${RIG_LIMITS.parts} 个部件。`);
  const ids = new Set();
  for (const part of document.parts) {
    if (!plainObject(part) || typeof part.id !== 'string' || !part.id || part.id.length > 160 || ids.has(part.id)
      || typeof part.name !== 'string' || part.name.length > 100 || typeof part.role !== 'string' || part.role.length > 160
      || part.parentId !== null && (typeof part.parentId !== 'string' || part.parentId.length > 160)
      || !Array.isArray(part.polygon) || part.polygon.length > RIG_LIMITS.vertices) throw failure(`${label} 的部件结构无效。`);
    ids.add(part.id);
    for (const point of part.polygon) rigDraftPoint(point, `${label}.${part.id}.polygon`);
    // Clearing a pivot field while editing deliberately stores null. Production
    // rig.save still requires finite, in-bounds coordinates and valid polygons.
    rigDraftPoint(part.pivot, `${label}.${part.id}.pivot`, { nullable: true });
  }
  for (const key of ['idle', 'walk', 'wave']) if (document.motion[key] !== undefined && typeof document.motion[key] !== 'boolean') throw failure(`${label}.motion.${key} 必须是布尔值。`);
  if (document.warnings !== undefined && (!Array.isArray(document.warnings) || document.warnings.some(value => typeof value !== 'string' && !plainObject(value)))) throw failure(`${label}.warnings 必须是提示信息数组。`);
}

/** Authoring may be incomplete. Executable commands retain their own stricter validation. */
export function validateAuthoringData(data, expectedProjectId) {
  limitedJson(data);
  // Projects saved before the asset-centred workbench retain their five original collections.
  if (objectMissingChanges(data)) data = { ...data, changeDrafts: [] };
  exactKeys(data, ['schemaVersion', 'projectId', ...AUTHORING_COLLECTIONS], '参数草稿');
  if (data.schemaVersion !== 1) throw failure('不支持此参数草稿版本。');
  if (typeof expectedProjectId !== 'string' || data.projectId !== expectedProjectId) throw failure('参数草稿的项目身份不匹配。', 409, 'AUTHORING_PROJECT_CONFLICT');
  for (const collection of AUTHORING_COLLECTIONS) {
    if (!Array.isArray(data[collection]) || data[collection].length > 100) throw failure(`${collection} 必须是最多包含 100 项的数组。`);
    const ids = new Set();
    for (const entry of data[collection]) {
      exactKeys(entry, ['id', 'data'], collection);
      if (typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 160 || /[\x00-\x1f]/.test(entry.id) || ids.has(entry.id)) throw failure(`${collection} 的草稿标识无效或重复。`);
      ids.add(entry.id);
      if (Buffer.byteLength(JSON.stringify(entry)) > 256 * 1024) throw failure('单个参数草稿超过 256 KiB 上限。', 413);
      typedFields(entry.data, specifications[collection], `${collection}.${entry.id}`);
      if (collection === 'changeDrafts' && entry.data.region !== undefined) {
        typedFields(entry.data.region, { x: 'number', y: 'number', width: 'number', height: 'number' }, '素材选区');
      }
      if (collection === 'changeDrafts' && entry.data.spineRepair !== undefined) {
        typedFields(entry.data.spineRepair, { boneName: 'string', parent: 'string', x: 'number', y: 'number', rotation: 'number', scaleX: 'number', scaleY: 'number', shearX: 'number', shearY: 'number', length: 'number',
          skin: 'string', slot: 'string', attachment: 'string', vertexIndex: 'number', influenceBone: 'string', weight: 'number' }, 'Spine 修复草稿');
      }
      if (collection === 'reskinDrafts') {
        if (entry.data.name !== undefined && entry.data.name.length > 100) throw failure('角色名称不能超过 100 个字符。');
        if (entry.data.mode !== undefined && !['local', 'api'].includes(entry.data.mode)) throw failure('换皮草稿执行方式无效。');
        for (const note of Object.values(entry.data.notes || {})) if (typeof note !== 'string' || note.length > 300) throw failure('部件要求必须是最多 300 字符的文本。');
      }
      if (collection === 'rigDrafts') {
        if (entry.data.name !== undefined && entry.data.name.length > 100) throw failure('角色名称不能超过 100 个字符。');
        for (const field of ['document', 'saved', 'candidate']) if (entry.data[field] !== undefined && entry.data[field] !== null && !plainObject(entry.data[field])) throw failure(`拆件草稿 ${field} 必须是对象或 null。`);
        for (const field of ['document', 'saved']) if (entry.data[field] !== undefined && entry.data[field] !== null) rigDraftDocument(entry.data[field], `拆件草稿 ${field}`);
        if (entry.data.drawing !== undefined) {
          if (entry.data.drawing.length > RIG_LIMITS.vertices) throw failure(`正在绘制的多边形最多保留 ${RIG_LIMITS.vertices} 个顶点。`);
          for (const point of entry.data.drawing) rigDraftPoint(point, '正在绘制的多边形');
        }
        if (entry.data.mode !== undefined && !['select', 'draw', 'pivot'].includes(entry.data.mode)) throw failure('拆件草稿画布工具无效。');
      }
      if (collection === 'generationDrafts') {
        if (entry.data.quality !== undefined && !['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(entry.data.quality)) throw failure('生图草稿质量选项无效。');
        if (entry.data.background !== undefined && !['auto', 'transparent', 'opaque'].includes(entry.data.background)) throw failure('生图草稿背景选项无效。');
      }
      if (collection === 'spineDrafts') {
        const transformFields = { scale: 'number', offsetX: 'number', offsetY: 'number', rotation: 'number', flipX: 'boolean' };
        if (entry.data.transform !== undefined) typedFields(entry.data.transform, transformFields, '骨骼素材校准');
        if (entry.data.partDrafts !== undefined) {
          if (entry.data.partDrafts.length > 512) throw failure('骨骼部件草稿最多保留 512 项。');
          const partIds = new Set();
          for (const part of entry.data.partDrafts) {
            typedFields(part, { revisionId:'string',regionName:'string',libraryImageId:'string',replacementAssetId:'string',replacementRevisionId:'string',replacementFileName:'string',transform:'object' }, '骨骼部件草稿');
            if (!part.revisionId?.trim() || !part.regionName?.trim()) throw failure('骨骼部件草稿需要确切版本和部件。');
            const key = JSON.stringify([part.revisionId, part.regionName]);
            if (partIds.has(key)) throw failure('骨骼部件草稿包含重复的版本和部件。');
            partIds.add(key);
            if (part.transform !== undefined) typedFields(part.transform, transformFields, '骨骼部件校准');
          }
        }
      }
      if (collection === 'imageDrafts' && entry.data.processingMode !== undefined && !['revise', 'append'].includes(entry.data.processingMode)) throw failure('图片加工方式无效。');
      if (collection === 'imageDrafts' && entry.data.recipe !== undefined) {
        typedFields(entry.data.recipe, { version: 'int', width: 'int', height: 'int', padding: 'int', trim: 'boolean', background: 'string', fit: 'string', removeBackground: 'object' }, '图片草稿配方');
        if (entry.data.recipe.fit !== undefined && !['contain', 'cover', 'fill'].includes(entry.data.recipe.fit)) throw failure('图片草稿缩放方式无效。');
        if (entry.data.recipe.removeBackground !== undefined) typedFields(entry.data.recipe.removeBackground, { color: 'string', tolerance: 'int' }, '图片草稿色键');
      }
    }
  }
  return structuredClone(data);
}

function objectMissingChanges(data) { return plainObject(data) && !Object.hasOwn(data, 'changeDrafts'); }

function emptyDocument(projectId) {
  return { schemaVersion: 1, projectId, ...Object.fromEntries(AUTHORING_COLLECTIONS.map(name => [name, []])) };
}

async function assertProject(project, expectedProjectId) {
  const snapshot = await project.snapshot();
  if (typeof expectedProjectId !== 'string' || snapshot.id !== expectedProjectId) throw failure('项目身份变化，请重启工作台。', 409, 'AUTHORING_PROJECT_CONFLICT');
}

async function readStored(project, projectId) {
  const target = await project._path(['.fwv', AUTHORING_STORAGE_FILE]);
  let bytes;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_AUTHORING_BYTES) throw failure('已有参数草稿不是有效文件或超过 1 MiB 上限。', 413);
    bytes = await fs.readFile(target);
    if (bytes.length > MAX_AUTHORING_BYTES) throw failure('已有参数草稿超过 1 MiB 上限。', 413);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { name: AUTHORING_FILE, type: 'json', exists: false, revision: `fwv-drafts-missing:${projectId}`, data: emptyDocument(projectId) };
  }
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw failure('已有参数草稿损坏，无法读取；文件已保留。', 422, 'AUTHORING_CORRUPT'); }
  return { name: AUTHORING_FILE, type: 'json', exists: true, revision: hash(bytes), data: validateAuthoringData(parsed, projectId) };
}

export async function readAuthoring({ projectRoot, expectedProjectId }) {
  const project = new FwvProject(projectRoot);
  await assertProject(project, expectedProjectId);
  return readStored(project, expectedProjectId);
}

export async function writeAuthoring({ projectRoot, expectedProjectId, payload }) {
  exactKeys(payload, ['data', 'revision', 'createOnly'], '保存参数');
  if (payload.createOnly !== undefined && typeof payload.createOnly !== 'boolean') throw failure('createOnly 必须为布尔值。');
  if (payload.revision !== undefined && (typeof payload.revision !== 'string' || payload.revision.length > 200)) throw failure('参数草稿版本标识无效。');
  const data = validateAuthoringData(payload.data, expectedProjectId);
  const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
  if (bytes.length > MAX_AUTHORING_BYTES) throw failure('参数草稿超过 1 MiB 上限。', 413);
  const project = new FwvProject(projectRoot);
  return project._withLock(async () => {
    await assertProject(project, expectedProjectId);
    const current = await readStored(project, expectedProjectId);
    if (payload.createOnly === true ? current.exists : !current.exists || typeof payload.revision !== 'string' || payload.revision !== current.revision) throw conflict();
    await project._path(['.fwv'], { mkdir: true });
    const target = await project._path(['.fwv', AUTHORING_STORAGE_FILE]);
    const temp = await project._path(['.fwv', `.editor-drafts-${randomUUID()}.tmp`]);
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (payload.createOnly === true) {
        // Exclusive publication also protects a creator that does not cooperate
        // with the FWV writer lock. Never fall back to an overwriting rename.
        try { await fs.link(temp, target); }
        catch (error) { if (error.code === 'EEXIST') throw conflict(); throw error; }
        return { name: AUTHORING_FILE, revision: hash(bytes), exists: true };
      }
      const deadline = Date.now() + 1500;
      while (true) {
        try { await fs.rename(temp, target); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
          await delay(40);
        }
      }
    } finally { await fs.rm(temp, { force: true }); }
    return { name: AUTHORING_FILE, revision: hash(bytes), exists: true };
  });
}
