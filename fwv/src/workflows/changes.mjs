import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import sharp from 'sharp';
import { inspectImage, processImageBuffer } from '../image/processor.mjs';
import { inspectSpine } from '../spine/index.mjs';
import { validateGeneration } from '../generation/provider.mjs';
import { normalizeFiles } from '../core/project.mjs';
import { inspectSpineBindings, inspectSpineRepair, prepareSpineRepair } from '../spine/repair.mjs';

const copy = value => structuredClone(value);
const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'ART_CHANGE_INVALID' });
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, required = [], optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw fail('素材修改操作参数不匹配。');
}
function text(value, label, max = 160, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw fail(`${label}必须为 1 到 ${max} 字的文本。`);
  return value.trim();
}
const optionalText = (value, label, max) => value === '' || value === undefined ? '' : text(value, label, max);
function json(value, label, maximum = 4096) {
  let count = 0;
  function visit(item, depth) {
    if (++count > 1024 || depth > 8) throw fail(`${label}过大。`);
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) || typeof item === 'string' && item.length <= 2048) return;
    if (!Array.isArray(item) && !object(item)) throw fail(`${label}只能包含 JSON 数据。`);
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fail(`${label}包含保留字段。`);
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
  if (JSON.stringify(value).length > maximum) throw fail(`${label}不能超过 ${maximum} 字符。`);
  return copy(value);
}
function anchors(input = {}, source) {
  fields(input, [], ['region', 'objects', 'animation', 'view']);
  const result = {};
  if (input.region !== undefined) {
    fields(input.region, ['x', 'y', 'width', 'height']);
    const r = input.region;
    if (![r.x, r.y, r.width, r.height].every(Number.isSafeInteger) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0) throw fail('选区必须是非负像素坐标和正整数尺寸。');
    const image = source.metadata.image;
    if (image && (r.x + r.width > image.width || r.y + r.height > image.height)) throw fail('选区超出原始图片版本的范围。');
    result.region = copy(r);
  }
  if (input.objects !== undefined) {
    if (!Array.isArray(input.objects) || input.objects.length > 32) throw fail('对象锚点最多包含 32 项。');
    result.objects = input.objects.map(value => text(value, '对象锚点'));
    if (new Set(result.objects).size !== result.objects.length) throw fail('对象锚点不能重复。');
  }
  if (input.animation !== undefined) {
    fields(input.animation, ['name', 'time']);
    if (!Number.isFinite(input.animation.time) || input.animation.time < 0) throw fail('动作时间必须是非负秒数。');
    result.animation = { name: text(input.animation.name, '动作名称'), time: input.animation.time };
  }
  if (input.view !== undefined) result.view = json(input.view, '视图锚点');
  return result;
}
function execution(input = { kind: 'external' }) {
  fields(input, ['kind'], ['provider', 'model', 'tool', 'note']);
  const result = { kind: text(input.kind, '执行方式', 80) };
  for (const key of ['provider', 'model', 'tool', 'note']) if (input[key] !== undefined) result[key] = optionalText(input[key], key, key === 'note' ? 1000 : 160);
  return result;
}
const imageFile = revision => revision.files.find(file => file.role === 'image') || revision.files.find(file => file.role === 'source' && file.mime.startsWith('image/'));

export function promptForChange(change, supplement = '') {
  return [
    `修改已有素材：${change.source.name}（${change.source.kind}）。`,
    `确切输入：assetId=${change.source.assetId}; revisionId=${change.source.revisionId}。`,
    `问题与目标：${change.request}`,
    `必须保持：${change.preserve || '保持未要求改变的内容。'}`,
    `定位与比较条件：${JSON.stringify(change.anchors)}`,
    '输出独立修改候选，不覆盖原始素材。不把技术检查当作人工验收。',
    ...(change.anchors.region ? ['返回保持原图完整构图的候选，不要只返回裁切部件。候选将按完整画面映射到原图尺寸，并只替换所标选区的像素；选区外由原图锁定。选区内构图和接缝需要人工核对。'] : []),
    ...(supplement ? [`补充要求：${supplement}`] : []),
  ].join('\n');
}

/** Project-owned change records. Every candidate/review/adoption update shares the
 * asset manifest lock, so a candidate is never adopted before its review commits. */
export class ArtChanges {
  constructor({ project, generationJobs } = {}) { this.project = project; this.generationJobs = generationJobs; }
  _records(data) {
    if (data.changes === undefined) return [];
    if (!Array.isArray(data.changes) || data.changes.some(change => change.schemaVersion !== 1 || !Array.isArray(change.candidates) || !Array.isArray(change.generations))) throw fail('素材修改记录损坏，已保留原项目。');
    return data.changes;
  }
  _change(data, changeId) {
    const change = this._records(data).find(item => item.id === changeId);
    if (!change) throw fail('找不到素材修改请求。', 404);
    return change;
  }
  _pair(data, assetId, revisionId) {
    if (!revisionId) throw fail('必须指定确切的素材版本。');
    const asset = this.project._asset(data, assetId), revision = this.project._revision(asset, revisionId);
    return { asset, revision };
  }
  _source(asset, revision) {
    return { assetId: asset.id, revisionId: revision.id, name: asset.name, kind: asset.kind, files: copy(revision.files), metadata: copy(revision.metadata) };
  }
  async _technical(asset, revision) {
    const report = await this.project._validate(asset, revision);
    report.coverage ||= asset.kind === 'image' ? 'image-and-files' : 'files-only';
    if (asset.kind === 'spine') {
      report.coverage = 'spine-structure-and-files';
      try {
        const skeleton = revision.files.find(file => file.role === 'skeleton'), atlas = revision.files.find(file => file.role === 'atlas');
        if (!skeleton || !atlas) throw fail('骨骼或图集文件缺失。');
        const pages = new Map();
        for (const file of revision.files.filter(file => file.role === 'texture')) pages.set(file.name, await this.project._readFile(asset.id, revision.id, file));
        const jsonBytes = await this.project._readFile(asset.id, revision.id, skeleton);
        const spine = await inspectSpine({ json: jsonBytes, atlas: await this.project._readFile(asset.id, revision.id, atlas), pages });
        inspectSpineBindings(JSON.parse(jsonBytes.toString('utf8').replace(/^\uFEFF/, '')));
        report.checks.push({ id: 'spine-structure', status: spine.supported ? 'passed' : 'failed', message: spine.supported ? 'Spine 结构检查通过；绑定效果仍须人工检查。' : spine.issues.map(item => item.message).join(' ') });
      } catch (error) { report.checks.push({ id: 'spine-structure', status: 'failed', message: error.message }); }
    }
    report.status = report.checks.some(check => check.status === 'failed') ? 'failed' : 'passed';
    return report;
  }
  _job(attempt) {
    const job = this.generationJobs?.get({ requestId: attempt.generationRequestId });
    if (!job) return null;
    if (!isDeepStrictEqual(job.input, attempt.input) || !isDeepStrictEqual(job.provider, attempt.provider)) throw fail('生成任务身份与该修改请求不匹配。', 409);
    return job;
  }
  _view(change) {
    const view = copy(change);
    view.status = view.adoptedCandidateId ? 'adopted' : view.candidates.length ? 'review' : 'open';
    view.capabilities = { imageProcess: view.source.kind === 'image', imageGenerate: view.source.kind === 'image', externalCandidate: true };
    for (const candidate of view.candidates) candidate.status = candidate.id === view.adoptedCandidateId ? 'adopted' : candidate.review.decision;
    for (const attempt of view.generations) {
      const job = this._job(attempt);
      attempt.jobId = job?.id || attempt.jobId || null;
      attempt.status = attempt.candidateId ? 'attached' : job?.status || 'not-dispatched';
      attempt.error = job?.error || attempt.error || null;
      attempt.canRecover = !attempt.candidateId && ['ready', 'succeeded'].includes(job?.status);
      if (job) attempt.durability = job.durability;
    }
    return view;
  }
  async _mutate(changeId, work) {
    return this.project._withLock(async () => {
      const data = await this.project._load(), change = this._change(data, changeId);
      await work(data, change);
      change.updatedAt = now();
      await this.project._save(data);
      return this._view(change);
    });
  }
  async list() {
    await this.generationJobs?.initialize?.();
    return this._records(await this.project.snapshot()).map(change => this._view(change)).reverse();
  }
  async get(input) {
    fields(input, ['changeId']);
    await this.generationJobs?.initialize?.();
    return this._view(this._change(await this.project.snapshot(), input.changeId));
  }
  async create(input) {
    fields(input, ['sourceAssetId', 'sourceRevisionId', 'title', 'request'], ['preserve', 'anchors']);
    const value = copy(input);
    return this.project._withLock(async () => {
      const data = await this.project._load(), pair = this._pair(data, value.sourceAssetId, value.sourceRevisionId);
      if (['reskin'].includes(pair.asset.kind)) throw fail('请选择实际美术素材，而不是生产方案。');
      const validation = await this._technical(pair.asset, pair.revision);
      const repairableModel = pair.asset.kind === 'model3d' && validation.checks.every(check => check.status === 'passed' || check.id === 'glb-structure' && check.repairable === true);
      if (validation.status !== 'passed' && !repairableModel) throw fail('原素材技术检查失败，不能建立可靠的修改基线。');
      const change = { schemaVersion: 1, id: id('change'), title: text(value.title, '问题标题'), request: text(value.request, '修改要求', 4000),
        preserve: optionalText(value.preserve, '保持范围', 2000), source: this._source(pair.asset, pair.revision), anchors: anchors(value.anchors, pair.revision),
        sourceValidation: validation, adoptionBaseRevisionId: pair.asset.selectedRevisionId, candidates: [], generations: [], adoptedCandidateId: null, adoption: null, adoptions: [], createdAt: now(), updatedAt: now() };
      if (/[\x00-\x1f]/.test(change.title)) throw fail('问题标题必须是单行文本。');
      const records = this._records(data);
      if (records.length >= 500) throw fail('项目已保留 500 条修改请求。');
      data.changes = [...records, change];
      await this.project._save(data);
      return this._view(change);
    });
  }
  async prepare(input) {
    const change = await this.get(input), data = await this.project.snapshot();
    const { asset, revision } = this._pair(data, change.source.assetId, change.source.revisionId);
    const sourceFiles = [];
    for (const file of revision.files) {
      await this.project._readFile(asset.id, revision.id, file);
      sourceFiles.push({ ...copy(file), path: path.join(this.project.root, 'assets', asset.id, revision.id, file.name) });
    }
    return { change, prompt: promptForChange(change), source: change.source, sourceFiles, anchors: change.anchors,
      completion: { type: 'change.candidate.attach', payload: { changeId: change.id, assetId: '<已导入候选 ID>', revisionId: '<确切版本 ID>', note: '实际修改说明', execution: { kind: 'local-agent', tool: '<实际工具>' } } } };
  }
  async _attach(data, change, pair, { note = '', execution: performed = { kind: 'external' }, receipt = null, regionMode = 'reference' } = {}) {
    if (pair.asset.kind !== change.source.kind) throw fail('候选类型必须与原素材一致。');
    if (pair.asset.id === change.source.assetId && pair.revision.id === change.source.revisionId) throw fail('原始基线不能作为修改候选。');
    const input = { assetId: pair.asset.id, revisionId: pair.revision.id };
    const scoped = regionMode === 'preserve-outside' && change.anchors.region && change.source.kind === 'image';
    const mode = scoped ? 'preserve-outside' : 'reference';
    const existing = change.candidates.find(candidate => candidate.assetId === input.assetId && candidate.revisionId === input.revisionId
      || candidate.input?.assetId === input.assetId && candidate.input?.revisionId === input.revisionId && candidate.scope.mode === mode);
    if (existing) return existing;
    if (change.candidates.length >= 100) throw fail('每个问题最多保留 100 个候选。');
    let scope = { mode };
    if (scoped) {
      const original = this._pair(data, change.source.assetId, change.source.revisionId);
      const originalFile = imageFile(original.revision), candidateFile = imageFile(pair.revision);
      if (!originalFile || !candidateFile) throw fail('局部合成需要原图和完整候选图片。');
      const originalBytes = await this.project._readFile(original.asset.id, original.revision.id, originalFile);
      const candidateBytes = await this.project._readFile(pair.asset.id, pair.revision.id, candidateFile);
      const originalImage = await inspectImage(originalBytes), candidateImage = await inspectImage(candidateBytes);
      const width = originalImage.width, height = originalImage.height, region = change.anchors.region;
      const baseline = await sharp(originalBytes).toColourspace('srgb').ensureAlpha().raw().toBuffer();
      const replacement = await sharp(candidateBytes).resize(width, height, { fit: 'fill' }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
      // Replace RGBA bytes instead of alpha-over compositing: a candidate may erase
      // pixels inside the region; every decoded source pixel outside stays exact.
      for (let row = region.y; row < region.y + region.height; row++) {
        const start = (row * width + region.x) * 4;
        replacement.copy(baseline, start, start, start + region.width * 4);
      }
      const buffer = await sharp(baseline, { raw: { width, height, channels: 4 } }).png().toBuffer();
      scope = { mode, region: copy(region), source: { assetId: original.asset.id, revisionId: original.revision.id }, input,
        normalization: { inputWidth: candidateImage.width, inputHeight: candidateImage.height, width, height, fit: 'fill' }, outsidePixels: 'preserved' };
      const files = [{ name: 'image.png', role: 'image', mime: 'image/png', buffer }];
      // Preserve original generation reference names so its provenance still points
      // to real files in the scoped candidate and in a later exported package.
      for (const reference of pair.revision.files.filter(file => file.role === 'reference')) files.push({ ...reference, buffer: await this.project._readFile(pair.asset.id, pair.revision.id, reference) });
      const addReference = (name, mime, bytes) => {
        while (files.some(file => file.name.toLowerCase() === name.toLowerCase() && !file.buffer.equals(bytes))) name = '_' + name;
        if (!files.some(file => file.name.toLowerCase() === name.toLowerCase())) files.push({ name, role: 'reference', mime, buffer: bytes });
        return name;
      };
      scope.sourceFile = addReference('change-source-' + originalFile.sha256.slice(0, 12) + '.' + (originalImage.format === 'jpeg' ? 'jpg' : originalImage.format), originalFile.mime, originalBytes);
      scope.inputFile = addReference('change-input-' + candidateFile.sha256.slice(0, 12) + '.' + (candidateImage.format === 'jpeg' ? 'jpg' : candidateImage.format), candidateFile.mime, candidateBytes);
      const scopedAsset = { id: id('asset'), name: `${change.title.slice(0, 130)} · 局部候选`, kind: 'image', revisions: [], selectedRevisionId: null };
      const scopedRevision = await this.project._writeRevision(scopedAsset.id, { files: normalizeFiles(files),
        metadata: { ...copy(pair.revision.metadata), image: await inspectImage(buffer), artChangeScope: scope },
        recipe: { operation: 'change.compose-region', version: 1, scope, sourceRecipe: copy(pair.revision.recipe) } });
      scopedAsset.revisions.push(scopedRevision); scopedAsset.selectedRevisionId = scopedRevision.id; data.assets.push(scopedAsset);
      pair = { asset: scopedAsset, revision: scopedRevision };
    }
    const candidate = { id: id('candidate'), ...this._source(pair.asset, pair.revision), input, scope, note, execution: performed, receipt,
      validation: await this._technical(pair.asset, pair.revision), review: { decision: 'pending', comment: '', reviewedAt: null }, reviews: [], createdAt: now() };
    change.candidates.push(candidate);
    return candidate;
  }
  async attach(input) {
    fields(input, ['changeId', 'assetId', 'revisionId'], ['note', 'execution', 'regionMode']);
    if (input.regionMode !== undefined && !['preserve-outside', 'reference'].includes(input.regionMode)) throw fail('选区处理方式无效。');
    const value = { ...copy(input), regionMode: input.regionMode ?? 'preserve-outside', note: optionalText(input.note, '修改说明', 2000), execution: execution(input.execution) };
    return this._mutate(value.changeId, async (data, change) => {
      await this._attach(data, change, this._pair(data, value.assetId, value.revisionId), value);
    });
  }
  async addPreparedCandidate(input, prepare) {
    fields(input, ['changeId', 'requestId', 'operation', 'spec'], ['name', 'note', 'execution']);
    if (typeof prepare !== 'function') throw fail('专业修复器未提供候选构建函数。');
    const value = { ...copy(input), requestId: text(input.requestId, '请求编号', 100), operation: text(input.operation, '专业操作', 100),
      spec: json(input.spec, '修复参数', 65536), note: optionalText(input.note, '修改说明', 2000), execution: execution(input.execution) };
    return this._mutate(value.changeId, async (data, change) => {
      const previous = change.candidates.find(candidate => candidate.receipt?.operation === value.operation && candidate.receipt.requestId === value.requestId);
      if (previous) {
        if (!isDeepStrictEqual(previous.receipt.spec, value.spec)) throw fail('相同专业修复请求编号对应不同修改。', 409);
        return;
      }
      if (change.candidates.length >= 100) throw fail('每个问题最多保留 100 个候选。');
      const source = this._pair(data, change.source.assetId, change.source.revisionId);
      if (!isDeepStrictEqual(source.revision.files, change.source.files)) throw fail('原素材基线身份已改变。', 409);
      const prepared = await prepare(source, copy(value.spec));
      const candidateAsset = { id: id('asset'), name: text(value.name ?? `${change.title.slice(0, 130)} · 修复候选`, '候选名称'), kind: source.asset.kind, revisions: [], selectedRevisionId: null };
      const revision = await this.project._writeRevision(candidateAsset.id, { files: normalizeFiles(prepared.files), metadata: { ...prepared.metadata,
        artChangeCandidate: { changeId: change.id, source: { assetId: source.asset.id, revisionId: source.revision.id } } }, recipe: prepared.recipe });
      candidateAsset.revisions.push(revision); candidateAsset.selectedRevisionId = revision.id;
      const technical = await this._technical(candidateAsset, revision);
      if (technical.status !== 'passed') throw fail('专业修复候选未通过技术检查，未登记或采用。');
      data.assets.push(candidateAsset);
      await this._attach(data, change, { asset: candidateAsset, revision }, { note: value.note, execution: value.execution,
        receipt: { operation: value.operation, requestId: value.requestId, spec: value.spec } });
    });
  }
  async inspectSpine(input) {
    fields(input, [], ['changeId', 'assetId', 'revisionId', 'mesh', 'vertexIndex']);
    if (input.changeId ? input.assetId !== undefined || input.revisionId !== undefined : !input.assetId || !input.revisionId) throw fail('请提供问题 ID，或素材 ID 与确切版本。');
    const data = await this.project.snapshot(), change = input.changeId ? this._change(data, input.changeId) : null;
    const pair = this._pair(data, change?.source.assetId ?? input.assetId, change?.source.revisionId ?? input.revisionId);
    return { ...await inspectSpineRepair(this.project, pair, { mesh: input.mesh, vertexIndex: input.vertexIndex }), changeId: change?.id ?? null, anchors: copy(change?.anchors ?? {}) };
  }
  async repairSpine(input) {
    fields(input, ['changeId', 'requestId'], ['boneEdits', 'weightEdits', 'note']);
    const value = copy(input);
    return this.addPreparedCandidate({ changeId: value.changeId, requestId: value.requestId, operation: 'spine.repair',
      spec: { boneEdits: value.boneEdits ?? [], weightEdits: value.weightEdits ?? [] }, note: value.note, execution: { kind: 'spine-repair', tool: 'fwv' } },
    (pair, spec) => prepareSpineRepair(this.project, pair, spec));
  }
  _candidate(change, candidateId) {
    const candidate = change.candidates.find(item => item.id === candidateId);
    if (!candidate) throw fail('找不到此问题的候选。', 404);
    return candidate;
  }
  async process(input) {
    fields(input, ['changeId', 'recipe'], ['requestId', 'note']);
    const recipe = json(input.recipe, '加工配方'), requestId = text(input.requestId ?? id('process'), '请求编号', 100), note = optionalText(input.note, '修改说明', 2000);
    return this._mutate(input.changeId, async (data, change) => {
      const previous = change.candidates.find(candidate => candidate.receipt?.operation === 'image.process' && candidate.receipt.requestId === requestId);
      if (previous) {
        if (!isDeepStrictEqual(previous.receipt.recipe, recipe)) throw fail('相同加工请求编号对应不同配方。', 409);
        return;
      }
      const { asset, revision } = this._pair(data, change.source.assetId, change.source.revisionId);
      if (asset.kind !== 'image') throw fail('当前本地加工只支持图片素材。');
      const file = imageFile(revision);
      if (!file) throw fail('原素材没有可加工的图片。');
      const processed = await processImageBuffer(await this.project._readFile(asset.id, revision.id, file), recipe);
      const files = [{ name: 'image.png', role: 'image', mime: 'image/png', buffer: processed.buffer }];
      for (const reference of revision.files.filter(item => item.role === 'reference')) files.push({ ...reference, buffer: await this.project._readFile(asset.id, revision.id, reference) });
      const candidateAsset = { id: id('asset'), name: `${change.title.slice(0, 130)} · 加工候选`, kind: 'image', revisions: [], selectedRevisionId: null };
      const candidateRevision = await this.project._writeRevision(candidateAsset.id, { files: normalizeFiles(files), metadata: { ...processed.metadata,
        artChange: { changeId: change.id, source: { assetId: asset.id, revisionId: revision.id } }, ...(revision.metadata.generation ? { generation: copy(revision.metadata.generation) } : {}) }, recipe: { operation: 'change.image-process', version: 1, input: copy(change.source), parameters: processed.recipe } });
      candidateAsset.revisions.push(candidateRevision); candidateAsset.selectedRevisionId = candidateRevision.id; data.assets.push(candidateAsset);
      await this._attach(data, change, { asset: candidateAsset, revision: candidateRevision }, { note, execution: { kind: 'image-process', tool: 'fwv' }, receipt: { operation: 'image.process', requestId, recipe } });
    });
  }
  async generate(input) {
    fields(input, ['changeId', 'requestId'], ['prompt', 'size', 'quality', 'background']);
    if (!this.generationJobs) throw fail('此执行环境未配置生成任务服务。');
    await this.generationJobs.initialize();
    const value = copy(input), requestId = text(value.requestId, '请求编号', 100);
    const supplement = optionalText(value.prompt, '补充要求', 1000);
    const spec = { supplement, size: value.size ?? '1024x1024', quality: value.quality ?? 'auto', background: value.background ?? 'auto' };
    const reserved = await this._mutate(value.changeId, async (data, change) => {
      const existing = change.generations.find(item => item.requestId === requestId);
      if (existing) { if (!isDeepStrictEqual(existing.spec, spec)) throw fail('相同生成请求编号对应不同内容。', 409); return; }
      const { asset, revision } = this._pair(data, change.source.assetId, change.source.revisionId);
      if (asset.kind !== 'image') throw fail('当前生成接口只支持图片修改；其他素材请回填外部工具候选。');
      const file = imageFile(revision);
      if (!file) throw fail('没有可发送的原图。');
      await this.project._readFile(asset.id, revision.id, file);
      const config = this.generationJobs.provider.publicConfig();
      if (!(config.canGenerate ?? config.keyConfigured)) throw fail('请先配置图片生成服务。');
      const prompt = promptForChange(change, supplement);
      if (prompt.length > 8000) throw fail('完整生成要求超过 8000 字，请缩短问题、保持范围或视图锚点。');
      validateGeneration({ prompt, size: spec.size, quality: spec.quality, background: spec.background, protocol: config.protocol });
      if (change.generations.length >= 100) throw fail('每个问题最多保留 100 个生成请求。');
      const generationRequestId = 'chg_' + createHash('sha256').update(change.id + '\0' + requestId).digest('hex').slice(0, 48);
      change.generations.push({ requestId, generationRequestId, spec, input: { requestId: generationRequestId, name: `${change.title.slice(0, 130)} · AI 候选`, prompt,
        size: spec.size, quality: spec.quality, background: spec.background, reference: { assetId: asset.id, revisionId: revision.id, fileName: file.name } },
        provider: { baseUrl: config.baseUrl, model: config.model, protocol: config.protocol }, candidateId: null, jobId: null, createdAt: now() });
    });
    const attempt = reserved.generations.find(item => item.requestId === requestId), existing = this._job(attempt);
    if (existing) return this.get({ changeId: value.changeId });
    const config = this.generationJobs.provider.publicConfig();
    if (['baseUrl', 'model', 'protocol'].some(key => config[key] !== attempt.provider[key])) throw fail('生成服务配置已改变，请还原配置后继续原请求。', 409);
    await this.generationJobs.start(attempt.input); // The persistent job reservation prevents a duplicate paid dispatch.
    return this.get({ changeId: value.changeId });
  }
  async recover(input) {
    fields(input, ['changeId', 'jobId']);
    if (!this.generationJobs) throw fail('此执行环境未配置生成任务服务。');
    await this.generationJobs.initialize();
    const change = await this.get({ changeId: input.changeId });
    const attempt = change.generations.find(item => item.jobId === input.jobId);
    if (!attempt) throw fail('此生成任务不属于当前问题。', 409);
    let job = this._job(attempt);
    if (job?.status === 'ready') job = await this.generationJobs.save({ jobId: job.id });
    if (job?.status !== 'succeeded') throw fail('尚无可恢复的生成图片；不会重新调用模型。');
    return this._mutate(input.changeId, async (data, stored) => {
      const record = stored.generations.find(item => item.generationRequestId === attempt.generationRequestId);
      const pair = this._pair(data, job.assetId, job.revisionId);
      if (pair.asset.importReceipt?.key !== job.id || pair.asset.importReceipt.revisionId !== job.revisionId) throw fail('生成候选与原任务入库回执不匹配。', 409);
      const candidate = await this._attach(data, stored, pair, { note: '由本问题的确切原图和要求生成；选区内效果和文字保持要求需要人工核对。', regionMode: 'preserve-outside', execution: { kind: 'image-generation', provider: record.provider.baseUrl, model: record.provider.model }, receipt: { operation: 'image.generate', requestId: record.requestId, jobId: job.id } });
      record.candidateId = candidate.id; record.jobId = job.id;
    });
  }
  async validate(input) {
    fields(input, ['changeId', 'candidateId']);
    return this._mutate(input.changeId, async (data, change) => {
      const candidate = this._candidate(change, input.candidateId), pair = this._pair(data, candidate.assetId, candidate.revisionId);
      candidate.validation = await this._technical(pair.asset, pair.revision);
    });
  }
  async review(input) {
    fields(input, ['changeId', 'candidateId', 'decision'], ['comment', 'expectedReview']);
    const value = copy(input);
    if (!['accepted', 'rejected'].includes(value.decision)) throw fail('人工评审请选择接受或驳回。');
    const comment = value.decision === 'rejected' ? text(value.comment, '驳回意见', 2000) : optionalText(value.comment, '评审意见', 2000);
    return this._mutate(value.changeId, async (data, change) => {
      const candidate = this._candidate(change, value.candidateId);
      if (change.adoptedCandidateId === candidate.id) throw fail('已采用的候选保留当时评审；请创建新候选继续修改。', 409);
      if (Object.hasOwn(value, 'expectedReview') && !isDeepStrictEqual(value.expectedReview, candidate.review)) {
        throw Object.assign(fail('候选评审已发生变化，请刷新并核对最新意见后再操作。', 409), { code: 'ART_CHANGE_REVIEW_CONFLICT' });
      }
      candidate.review = { decision: value.decision, comment, reviewedAt: now() };
      candidate.reviews.push(copy(candidate.review));
    });
  }
  async adopt(input) {
    fields(input, ['changeId', 'candidateId'], ['expectedAdoption']);
    const value = copy(input);
    return this._mutate(value.changeId, async (data, change) => {
      const candidate = this._candidate(change, value.candidateId);
      if (change.adoptedCandidateId === candidate.id) return; // Response-loss retries never reset a newer selection.
      if (Object.hasOwn(value, 'expectedAdoption') && !isDeepStrictEqual(value.expectedAdoption, change.adoption ?? null)) {
        throw Object.assign(fail('此修改请求已采用其他候选，请刷新并核对当前版本后再操作。', 409), { code: 'ART_CHANGE_ADOPTION_CONFLICT' });
      }
      if (candidate.review.decision !== 'accepted') throw fail('请先人工接受此候选，再采用。');
      const pair = this._pair(data, candidate.assetId, candidate.revisionId);
      if (!isDeepStrictEqual(pair.revision.files, candidate.files) || !isDeepStrictEqual(pair.revision.metadata, candidate.metadata)) throw fail('候选内容已不再匹配人工评审时的确切版本。', 409);
      const validation = await this._technical(pair.asset, pair.revision);
      if (validation.status !== 'passed') throw fail('候选技术检查失败，不能采用。');
      const original = this._pair(data, change.source.assetId, change.source.revisionId);
      if (!isDeepStrictEqual(original.revision.files, change.source.files)) throw fail('原素材基线的文件身份已改变，请重新建立修改请求。', 409);
      for (const file of original.revision.files) await this.project._readFile(original.asset.id, original.revision.id, file);
      const expected = change.adoption?.revisionId ?? change.adoptionBaseRevisionId;
      if (original.asset.selectedRevisionId !== expected) throw fail('原素材已被其他操作切换版本，请核对最新素材后建立新的修改请求。', 409);
      const files = [];
      for (const file of pair.revision.files) files.push({ ...file, buffer: await this.project._readFile(pair.asset.id, pair.revision.id, file) });
      const adopted = await this.project._writeRevision(original.asset.id, { parentId: expected, files: normalizeFiles(files), metadata: { ...copy(pair.revision.metadata),
        artChange: { changeId: change.id, candidateId: candidate.id, source: { assetId: change.source.assetId, revisionId: change.source.revisionId }, candidate: { assetId: candidate.assetId, revisionId: candidate.revisionId }, review: copy(candidate.review) } },
        recipe: { operation: 'change.adopt', version: 1, changeId: change.id, candidateId: candidate.id, input: { assetId: candidate.assetId, revisionId: candidate.revisionId }, sourceRecipe: copy(pair.revision.recipe) } });
      adopted.validation = copy(validation); candidate.validation = validation;
      original.asset.revisions.push(adopted); original.asset.selectedRevisionId = adopted.id;
      change.adoption = { candidateId: candidate.id, assetId: original.asset.id, revisionId: adopted.id, adoptedAt: now(), review: copy(candidate.review) };
      change.adoptedCandidateId = candidate.id; change.adoptions.push(copy(change.adoption));
    });
  }
}

export async function executeChangeCommand(service, body) {
  fields(body, ['type', 'payload']);
  const method = { 'change.create': 'create', 'change.prepare': 'prepare', 'change.candidate.attach': 'attach', 'change.candidate.process': 'process',
    'change.candidate.generate': 'generate', 'change.candidate.recover': 'recover', 'change.candidate.validate': 'validate', 'change.review': 'review', 'change.adopt': 'adopt',
    'change.spine.inspect': 'inspectSpine', 'change.candidate.spine-repair': 'repairSpine' }[body.type];
  if (!method) throw fail('未知的素材修改命令。');
  return service[method](body.payload);
}
