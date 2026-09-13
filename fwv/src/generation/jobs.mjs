import { createHash, randomUUID } from 'node:crypto';
import { inspectImage, imageMime } from '../image/processor.mjs';
import { validateGeneration } from './provider.mjs';
import { GenerationRecovery } from './recovery.mjs';

const clone = value => structuredClone(value);
const active = new Set(['queued', 'running']);
const fail = message => Object.assign(new Error(message), { status: 400 });
function normalize(input) {
  const required = ['requestId', 'prompt'];
  const allowed = [...required, 'name', 'size', 'quality', 'background', 'reference'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || required.some(key => !Object.hasOwn(input, key))
    || Object.keys(input).some(key => !allowed.includes(key))) throw fail('生图参数不匹配。');
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId)) throw fail('任务请求编号无效。');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) throw fail('请填写 1 到 8000 字的生成要求。');
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160 || /[\x00-\x1f]/.test(input.name))) throw fail('资源名称需为 1 到 160 字。');
  const normalized = { requestId: input.requestId, name: input.name?.trim() || 'AI 生成图片', prompt: input.prompt.trim(),
    size: input.size ?? '1024x1024', quality: input.quality ?? 'auto', background: input.background ?? 'auto' };
  try { validateGeneration(normalized); } catch (error) { throw fail(error.message); }
  if (input.reference !== undefined) {
    const ref = input.reference;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).sort().join(',') !== 'assetId,fileName,revisionId'
      || ['assetId', 'revisionId', 'fileName'].some(key => typeof ref[key] !== 'string' || !ref[key])) throw fail('参考图必须指向已入库图片的指定版本。');
    normalized.reference = { assetId: ref.assetId, revisionId: ref.revisionId, fileName: ref.fileName };
  }
  return normalized;
}

function safeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
  for (const key of ['input_tokens_details', 'output_tokens_details']) {
    if (value[key] && typeof value[key] === 'object') {
      const details = {};
      for (const name of ['text_tokens', 'image_tokens', 'cached_tokens']) if (Number.isFinite(value[key][name]) && value[key][name] >= 0) details[name] = value[key][name];
      if (Object.keys(details).length) result[key] = details;
    }
  }
  return Object.keys(result).length ? result : null;
}

/** Generation requests are journaled before dispatch; exact results are staged before asset registration. */
export class GenerationJobs {
  constructor({ project, provider }) {
    this.project = project; this.provider = provider; this.recovery = new GenerationRecovery(project);
    this.jobs = new Map(); this.requests = new Map(); this.pending = new Set(); this.closed = false;
  }
  _record(job) {
    const { controller, output, bundle, referenceFile, saving, ...view } = job;
    return clone(view);
  }
  _public(job) { const { fingerprint, ...view } = this._record(job); return view; }
  list() {
    const recent = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const pending = recent.filter(job => active.has(job.status) || job.status === 'ready');
    const history = recent.filter(job => !pending.includes(job)).slice(0, Math.max(0, 100 - pending.length));
    return [...pending, ...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => this._public(job));
  }
  get({ jobId, requestId } = {}) { const job = this.jobs.get(jobId ?? this.requests.get(requestId)); return job ? this._public(job) : null; }
  _required(jobId) { const job = this.jobs.get(jobId); if (!job) throw fail('没有找到该生成任务。'); return job; }
  _remember(job) { this.jobs.set(job.id, job); this.requests.set(job.requestId, job.id); return job; }
  _track(work) { this.pending.add(work); work.finally(() => this.pending.delete(work)).catch(() => {}); return work; }

  async initialize() {
    this.initialized ||= (async () => {
      for (const record of await this.recovery.records()) this._remember(await this._restore(record));
    })();
    await this.initialized;
    return this;
  }
  async _restore(record) {
    const payload = normalize(record.input);
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (record.requestId !== payload.requestId || fingerprint !== record.fingerprint
      || !['queued', 'running', 'ready', 'succeeded', 'failed', 'unknown', 'cancelled'].includes(record.status)
      || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('生成任务恢复记录损坏，未重新派发任何请求。');
    const job = { ...record, controller: new AbortController() };
    if (job.status === 'succeeded') return job;
    try {
      const committed = await this._saved(job);
      if (committed) return Object.assign(job, committed);
      const bundle = await this.recovery.read(job.id, job.fingerprint);
      if (bundle) {
        job.status = 'ready'; job.stage = 'recovered'; job.durability = 'staged';
        job.recoveryPath = '.fwv/generation/' + job.id + '/result.json';
        job.error = '已从磁盘恢复生成图片。点击“保存已生成图片”继续入库，不会再次调用模型。';
      } else if (active.has(job.status) || job.status === 'ready') {
        const saved = await this._saved(job);
        if (saved) return Object.assign(job, saved);
        job.status = 'unknown'; job.stage = 'interrupted';
        job.durability = 'none';
        job.error = job.dispatched ? '服务在取得可恢复结果前中断。远端可能已执行，请核对服务商记录；不会重新提交此请求。' : '未确认原服务中该任务的最终结果。任务可能尚未派发或仍在执行；不会重新提交此请求。';
      }
    } catch (error) {
      try { const saved = await this._saved(job); if (saved) return Object.assign(job, saved); } catch {}
      job.status = 'unknown'; job.stage = 'recovery-failed'; job.durability = 'unverified';
      job.error = '恢复文件未通过检查：' + error.message + '。保留原文件，不会重新调用模型。';
    }
    return job;
  }
  async _finish(job, patch) {
    const next = { ...this._record(job), ...patch, updatedAt: new Date().toISOString() };
    delete next.journalError;
    try { Object.assign(next, await this.recovery.write(next)); }
    catch (error) { next.journalError = '任务状态写入失败：' + error.message; }
    delete job.journalError;
    Object.assign(job, next);
  }
  start(input) {
    // Capture and validate caller-owned input before the first asynchronous boundary.
    let payload;
    try { payload = normalize(input); } catch (error) { return Promise.reject(error); }
    return this._track(this._start(payload));
  }
  async _start(payload) {
    if (this.closed) throw fail('生成服务正在关闭。');
    await this.initialize();
    if (this.closed) throw fail('生成服务正在关闭。');
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const existing = this.jobs.get(this.requests.get(payload.requestId));
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw fail('相同请求编号对应了不同内容，请查询原任务。');
      return this._public(existing);
    }
    if ([...this.jobs.values()].filter(job => active.has(job.status)).length >= 2) throw fail('已有两个生成任务在执行，请等待完成。');
    if ([...this.jobs.values()].filter(job => job.status === 'ready').length >= 100) throw fail('已有 100 个生成结果等待入库，请先保存这些图片。');
    if ([...this.jobs.values()].reduce((total, job) => total + (job.output?.buffer.length || 0), 0) >= 64 * 1024 * 1024) throw fail('已有生成结果等待保存，请先保存这些图片。');
    const config = this.provider.publicConfig();
    if (!(config.canGenerate ?? config.keyConfigured)) throw fail('请先配置生图服务的 API Key。');
    const job = { id: 'gen_' + randomUUID().replaceAll('-', ''), requestId: payload.requestId, input: payload,
      provider: { baseUrl: config.baseUrl, model: config.model, protocol: config.protocol },
      status: 'queued', stage: 'preparing', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      fingerprint, controller: new AbortController(), dispatched: false, durability: 'none' };
    // Reserve in memory before awaiting the shared on-disk reservation. Both guard duplicate requests.
    this._remember(job);
    try {
      const reservation = await this.recovery.reserve(this._record(job));
      if (!reservation.created) {
        const restored = await this._restore(reservation.job);
        this.jobs.delete(job.id); this._remember(restored); return this._public(restored);
      }
    } catch (error) {
      this.jobs.delete(job.id); this.requests.delete(job.requestId);
      throw fail('任务未派发，无法保存请求记录：' + error.message);
    }
    this._track(this._run(job));
    return this._public(job);
  }
  async _run(job) {
    try {
      if (job.controller.signal.aborted) { await this._finish(job, { status: 'cancelled' }); return; }
      job.status = 'running'; job.updatedAt = new Date().toISOString();
      if (job.input.reference) {
        const ref = job.input.reference;
        const snapshot = await this.project.snapshot();
        const asset = snapshot.assets.find(asset => asset.id === ref.assetId && asset.kind === 'image');
        const revision = asset?.revisions.find(revision => revision.id === ref.revisionId);
        const file = revision?.files.find(file => file.name === ref.fileName && ['source', 'image'].includes(file.role));
        if (!file) throw fail('参考图必须是已登记的图片资源。');
        const artifact = await this.project.readArtifact(ref);
        const image = await inspectImage(artifact.buffer);
        job.referenceFile = { buffer: artifact.buffer, name: artifact.name, mime: imageMime(image.format), sha256: file.sha256 };
      }
      if (job.controller.signal.aborted) { await this._finish(job, { status: 'cancelled' }); job.referenceFile = null; return; }
      const config = this.provider.publicConfig();
      if (config.baseUrl !== job.provider.baseUrl || config.model !== job.provider.model || config.protocol !== job.provider.protocol) throw fail('生成准备期间服务配置改变，请重新发起任务。');
      // Commit dispatch intent first. A crash after this write is conservatively unknown, never resent.
      await this.recovery.write({ ...this._record(job), dispatched: true, stage: 'generating' });
      if (job.controller.signal.aborted) { await this._finish(job, { status: 'cancelled', dispatched: false }); return; }
      job.dispatched = true; job.stage = 'generating';
      const output = await this.provider.generate({ prompt: job.input.prompt, size: job.input.size,
        quality: job.input.quality, background: job.input.background, reference: job.referenceFile, signal: job.controller.signal });
      job.output = { ...output, buffer: Buffer.from(output.buffer) };
      job.generatedAt = new Date().toISOString();
      await this._save(job);
    } catch (error) {
      await this._finish(job, { status: error.uncertain ? 'unknown' : job.controller.signal.aborted ? 'cancelled' : 'failed', error: error.message || '生成请求失败。' });
      job.referenceFile = null;
    }
  }
  async _bundle(job) {
    if (job.bundle) return job.bundle;
    if (job.durability === 'staged') {
      try {
        const bundle = await this.recovery.read(job.id, job.fingerprint);
        if (!bundle) throw new Error('Generation recovery result is missing.');
        return job.bundle = bundle;
      } catch (error) { job.durability = 'unverified'; throw error; }
    }
    const result = job.output;
    const image = await inspectImage(result.buffer);
    const fileName = 'generated.' + (image.format === 'jpeg' ? 'jpg' : image.format);
    const files = [{ name: fileName, role: 'image', mime: imageMime(image.format), buffer: result.buffer }];
    let reference;
    if (job.referenceFile) {
      const refImage = await inspectImage(job.referenceFile.buffer);
      const refName = 'reference.' + (refImage.format === 'jpeg' ? 'jpg' : refImage.format);
      files.push({ name: refName, role: 'reference', mime: imageMime(refImage.format), buffer: job.referenceFile.buffer });
      reference = { ...job.input.reference, sourceFile: refName, sha256: job.referenceFile.sha256 };
    }
    const provenance = { ...job.provider, requestId: job.requestId, providerRequestId: result.requestId || null,
      prompt: job.input.prompt, revisedPrompt: result.revisedPrompt || null, size: job.input.size, quality: job.input.quality,
      background: job.input.background, usage: safeUsage(result.usage), generatedAt: job.generatedAt,
      ...(reference ? { reference } : {}) };
    job.bundle = { fingerprint: job.fingerprint, name: job.input.name, kind: 'image', files,
      metadata: { image, generation: provenance }, recipe: { operation: reference ? 'image.edit' : 'image.generate', version: 1, generation: provenance } };
    return job.bundle;
  }
  async _saved(job) {
    const snapshot = await this.project.snapshot();
    const asset = snapshot.assets.find(asset => asset.importReceipt?.key === job.id);
    if (!asset) return null;
    const revision = asset.revisions.find(revision => revision.id === asset.importReceipt.revisionId);
    const provenance = revision?.metadata?.generation;
    const expected = { ...job.provider, requestId: job.requestId, prompt: job.input.prompt, size: job.input.size, quality: job.input.quality, background: job.input.background };
    if (asset.kind !== 'image' || !provenance || Object.entries(expected).some(([key, value]) => provenance[key] !== value)
      || JSON.stringify(revision.recipe.generation) !== JSON.stringify(provenance)
      || revision.recipe.operation !== (job.input.reference ? 'image.edit' : 'image.generate')
      || Boolean(provenance.reference) !== Boolean(job.input.reference)
      || Object.entries(job.input.reference || {}).some(([key, value]) => provenance.reference[key] !== value)) {
      throw new Error('Registered generation receipt does not match the original request.');
    }
    for (const file of revision.files) await this.project.readArtifact({ assetId: asset.id, revisionId: revision.id, fileName: file.name });
    return { status: 'succeeded', stage: 'saved', assetId: asset.id, revisionId: revision.id,
      usage: provenance.usage, durability: 'saved', error: null, recoveryPath: null };
  }
  async _complete(job, result) {
    await this._finish(job, result);
    // Keep staging if the success journal could not be committed; restart can reconcile the immutable receipt.
    if (!job.journalError) await this.recovery.clearOutput(job.id).catch(() => {});
    job.output = null; job.bundle = null; job.referenceFile = null;
  }
  async _save(job) {
    if (job.saving) return job.saving;
    job.saving = (async () => {
      job.status = 'running'; job.stage = 'saving'; job.updatedAt = new Date().toISOString();
      try {
        const committed = await this._saved(job);
        if (committed) {
          await this._complete(job, committed);
          return;
        }
        const bundle = await this._bundle(job);
        if (job.durability !== 'staged') {
          job.recoveryPath = await this.recovery.stage(job.id, bundle);
          job.durability = 'staged';
        }
        const { fingerprint, ...input } = bundle;
        const asset = await this.project.importAsset({ ...input, idempotencyKey: job.id });
        const result = { status: 'succeeded', stage: 'saved', assetId: asset.id,
          revisionId: asset.importReceipt.revisionId, usage: bundle.metadata.generation.usage,
          durability: 'saved', error: null, recoveryPath: null };
        await this._complete(job, result);
      } catch (error) {
        // Another service may have committed the asset and removed its staging files while we read them.
        // The immutable import receipt wins over this service's stale local view.
        try {
          const committed = await this._saved(job);
          if (committed) {
            await this._complete(job, committed);
            return;
          }
        } catch (receiptError) { job.durability = 'unverified'; error = receiptError; }
        const staged = job.durability === 'staged';
        if (job.durability === 'unverified') {
          await this._finish(job, { status: 'unknown', stage: 'recovery-failed', error: '恢复文件未通过检查：' + error.message + '。保留原文件，不会重新调用模型。' });
          return;
        }
        await this._finish(job, { status: 'ready', stage: staged ? 'save-failed' : 'stage-failed', durability: staged ? 'staged' : 'memory',
          error: staged ? '图片已安全暂存到磁盘，但入库失败：' + error.message + '。可以重试保存，服务重启后仍可恢复。'
            : '图片已生成，但尚未落盘：' + error.message + '。结果仅在当前服务内存中，请勿关闭服务；恢复磁盘写入后重试保存。' });
        if (staged) { job.output = null; job.bundle = null; job.referenceFile = null; }
      }
    })();
    try { await job.saving; } finally { delete job.saving; }
  }
  async save({ jobId }) {
    await this.initialize();
    const job = this._required(jobId);
    if (job.status === 'succeeded') return this._public(job);
    if (job.saving) { await job.saving; return this._public(job); }
    if (job.status !== 'ready' || !job.output && !job.bundle && job.durability !== 'staged') throw fail('该任务没有等待保存的生成结果。');
    await this._track(this._save(job)); return this._public(job);
  }
  async cancel({ jobId }) {
    const job = this._required(jobId);
    if (!active.has(job.status) || job.output || job.bundle) return this._public(job);
    job.controller.abort();
    if (!job.dispatched) await this._finish(job, { status: 'cancelled' });
    return this._public(job);
  }
  close() {
    this.closed = true;
    for (const job of this.jobs.values()) if (active.has(job.status) && !job.output && !job.bundle) job.controller.abort();
    return (async () => { while (this.pending.size) await Promise.allSettled([...this.pending]); })();
  }
}
