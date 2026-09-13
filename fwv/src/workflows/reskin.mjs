import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectReskinTemplate, buildReskinSheet, assembleReskinSheet } from '../spine/reskin-template.mjs';
import { localTask, localClaim, localAnalyze, localDispatch, localComplete, localFail, generateLocal, assembleLocal, modeValue } from './local-reskin.mjs';

const copy = value => structuredClone(value);
const now = () => new Date().toISOString();
const active = state => ['queued', 'running'].includes(state);
const failure = message => Object.assign(new Error(message), { status: 400 });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function fields(input, required, optional = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) throw failure('角色换皮参数不匹配。');
}
function text(value, label, maximum, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw failure(`${label}需为 1 到 ${maximum} 字。`);
  return value.trim();
}
function selection(parts, names) {
  const selected = names ?? parts.map(part => part.regionName);
  if (!Array.isArray(selected) || !selected.length || selected.length > 16 || new Set(selected).size !== selected.length || selected.some(name => !parts.some(part => part.regionName === name))) throw failure('每次请选择 1 到 16 个不重复的模板部件。');
  return parts.filter(part => selected.includes(part.regionName)).map(part => part.regionName);
}
function notes(parts, value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(name => !parts.some(part => part.regionName === name))) throw failure('部件说明必须对应已选择的模板区域。');
  return parts.map(part => ({ ...part, note: Object.hasOwn(value, part.regionName) ? (value[part.regionName] === '' ? '' : text(value[part.regionName], '部件说明', 300)) : (part.note || '') }));
}
export function promptFor(document, layout, regionNames) {
  const lines = [
    'Edit this 2D game character PART SHEET. Return exactly one 1024x1024 PNG sheet with the SAME layout.',
    `Character design: ${document.brief}`,
    `Shared visual style and palette: ${document.style || 'Match the coherent style of the reference character.'}`,
    'Each existing part must remain in its own exact pixel rectangle below. Preserve its pose, orientation, proportions, joint connection locations and silhouette. Do not assemble a character on this sheet.',
    'Keep empty space visually empty and use a plain background. No text, labels, borders, drop shadows, new cells or extra parts. Apply the character design consistently to all listed parts in this single image. Output transparency is not guaranteed; assembly uses the original alpha mask when enabled.',
    document.preserveAlpha ? 'Original silhouettes will be used as alpha masks during assembly. Paint within those shapes; do not add features outside them.' : 'Preserve the existing attachment canvas and joint positions. New pixels outside the existing atlas trim rectangle will be clipped.',
  ];
  for (const cell of layout.parts) {
    const part = document.parts.find(part => part.regionName === cell.regionName);
    if (!regionNames.includes(cell.regionName)) continue;
    lines.push(`Part ${cell.id}: ${cell.regionName}; rectangle x=${cell.content.x}, y=${cell.content.y}, width=${cell.content.width}, height=${cell.content.height}; original attachment ${cell.originalWidth}x${cell.originalHeight}; slots=${part?.slotNames?.join(',') || 'see reference'}; ${part?.note || 'Apply the shared character design; keep this part recognizable.'}`);
  }
  if (document.analysis) {
    lines.push(`Agent interpretation: ${document.analysis.summary}`);
    for (const [regionName, note] of Object.entries(document.analysis.partNotes)) lines.push(`Agent part instruction (${regionName}): ${note}`);
    for (const risk of document.analysis.risks) lines.push(`Agent risk to address: ${risk}`);
  }
  const prompt = lines.join('\n');
  if (prompt.length > 8000) throw failure('整套生成说明超过 8000 字，请缩短角色设定或部件说明。');
  return prompt;
}

/** Durable authoring workflow. Paid jobs never resume automatically across services. */
export class ReskinWorkflows {
  constructor({ project, generationJobs }) {
    this.project = project; this.generationJobs = generationJobs; this.sessionId = randomUUID();
    this.closed = false; this.chains = new Map(); this.runners = new Map(); this.assembling = new Set();
  }
  _serial(id, work) {
    const next = (this.chains.get(id) || Promise.resolve()).then(work);
    const tail = next.catch(() => {}); this.chains.set(id, tail);
    tail.finally(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
    return next;
  }
  _generationJob(attempt) {
    const job = this.generationJobs?.get(attempt.generationJobId ? { jobId:attempt.generationJobId } : { requestId:attempt.id });
    if (!job || !attempt.guide || !attempt.prompt || job.requestId !== attempt.id || job.input?.requestId !== attempt.id
      || job.input.prompt !== attempt.prompt || ['assetId','revisionId','fileName'].some(key => job.input.reference?.[key] !== attempt.guide[key])
      || ['baseUrl','model','protocol'].some(key => job.provider?.[key] !== attempt.provider?.[key])
      || job.input.size !== '1024x1024' || job.input.quality !== 'auto' || job.input.background !== 'auto') return null;
    return job;
  }
  _view(asset, revision) {
    const view = { ...copy(revision.metadata.reskin), assetId: asset.id, revisionId: revision.id };
    view.mode ||= 'api';
    for (const attempt of view.attempts) {
      attempt.mode ||= 'api';
      if (attempt.mode === 'local') { if (attempt.local) delete attempt.local.claimId; continue; }
      if ((active(attempt.status) || ['ready','unknown'].includes(attempt.status) && !attempt.sheetAssetId) && attempt.sessionId !== this.sessionId) {
        const job = this._generationJob(attempt), recoverable = job && ['ready','succeeded'].includes(job.status);
        attempt.status = attempt.sheetAssetId || recoverable ? 'ready' : 'unknown';
        attempt.error = attempt.sheetAssetId ? '服务已重启，已保存生成图，可继续本地装配。'
          : recoverable ? '已找回本次生成图，可继续保存并装配，不会再次调用模型。'
          : job?.error || '服务已重启，远端结果需要核实；不会自动重新调用模型。';
      }
    }
    return view;
  }
  async _load(workflowId) {
    const snapshot = await this.project.snapshot();
    const asset = snapshot.assets.find(asset => asset.id === workflowId && asset.kind === 'reskin');
    const revision = asset?.revisions.find(revision => revision.id === asset.selectedRevisionId);
    if (!revision?.metadata.reskin || revision.metadata.reskin.schemaVersion !== 1) throw failure('没有找到角色换皮流程。');
    // Document bytes are authoritative too; reject damaged workflow history.
    const artifact = await this.project.readArtifact({ assetId: asset.id, revisionId: revision.id, fileName: 'workflow.json' });
    if (JSON.stringify(JSON.parse(artifact.buffer.toString('utf8'))) !== JSON.stringify(revision.metadata.reskin)) throw failure('流程文件与索引不一致。');
    return { asset, revision, document: copy(revision.metadata.reskin) };
  }
  async _write(record, document) {
    document.updatedAt = now();
    const asset = await this.project.addRevision({ assetId: record.asset.id, parentRevisionId: record.revision.id,
      expectedSelectedRevisionId: record.revision.id, files: [{ name: 'workflow.json', role: 'workflow', mime: 'application/json', buffer: Buffer.from(JSON.stringify(document)) }],
      metadata: { reskin: document }, recipe: { operation: 'reskin.workflow', version: 1 } });
    return this._view(asset, asset.revisions.at(-1));
  }
  async list() {
    await this.generationJobs?.initialize?.();
    const snapshot = await this.project.snapshot();
    return snapshot.assets.filter(asset => asset.kind === 'reskin').map(asset => this._view(asset, asset.revisions.find(rev => rev.id === asset.selectedRevisionId))).reverse();
  }
  async get({ workflowId }) { await this.generationJobs?.initialize?.(); const record = await this._load(workflowId); return this._view(record.asset, record.revision); }
  async create(input) {
    if (this.closed) throw failure('换皮服务正在关闭。');
    fields(input, ['templateAssetId', 'templateRevisionId', 'name', 'brief'], ['style', 'regionNames', 'preserveAlpha', 'partNotes', 'mode']);
    const mode = modeValue(input.mode);
    const name = text(input.name, '角色名称', 100), brief = text(input.brief, '角色设定', 1800);
    const style = input.style === '' ? '' : text(input.style, '画风与配色', 700, '');
    if (input.preserveAlpha !== undefined && typeof input.preserveAlpha !== 'boolean') throw failure('轮廓保护参数无效。');
    const report = await inspectReskinTemplate(this.project, { assetId: input.templateAssetId, revisionId: input.templateRevisionId });
    const regionNames = selection(report.parts, input.regionNames);
    const parts = notes(report.parts.filter(part => regionNames.includes(part.regionName)), input.partNotes);
    const built = await buildReskinSheet(this.project, { assetId: report.assetId, revisionId: report.revisionId, regionNames });
    const document = { schemaVersion: 1, name, template: { assetId: report.assetId, revisionId: report.revisionId, name: report.name },
      mode, brief, style, parts, preserveAlpha: input.preserveAlpha ?? true, sheet: null, attempts: [], selectedCandidateId: null,
      warnings: report.warnings || [], createdAt: now(), updatedAt: now() };
    promptFor(document, built.layout, regionNames); // Validate final prompt before any asset writes.
    const sheet = await this.project.importImage({ name: `${name} · 部件模板`, fileName: 'part-sheet.png', buffer: built.buffer });
    document.sheet = { assetId: sheet.id, revisionId: sheet.selectedRevisionId, fileName: 'part-sheet.png', layout: built.layout };
    const asset = await this.project.importAsset({ name: `${name} · 换皮流程`, kind: 'reskin',
      files: [{ name: 'workflow.json', role: 'workflow', mime: 'application/json', buffer: Buffer.from(JSON.stringify(document)) }],
      metadata: { reskin: document }, recipe: { operation: 'reskin.create', version: 1 } });
    return this._view(asset, asset.revisions[0]);
  }
  _edit(document, input) {
    document.mode = modeValue(input.mode, document.mode || 'api');
    if (input.brief !== undefined) document.brief = text(input.brief, '角色设定', 1800);
    if (input.style !== undefined) document.style = input.style === '' ? '' : text(input.style, '画风与配色', 700);
    if (input.partNotes !== undefined) document.parts = notes(document.parts, input.partNotes);
  }
  async update(input) {
    fields(input, ['workflowId'], ['brief', 'style', 'partNotes', 'mode']);
    return this._serial(input.workflowId, async () => { const record = await this._load(input.workflowId); this._edit(record.document, input); return this._write(record, record.document); });
  }
  async generate(input) {
    if (this.closed) throw failure('换皮服务正在关闭。');
    fields(input, ['workflowId', 'requestId'], ['regionNames', 'brief', 'style', 'partNotes', 'mode']);
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId)) throw failure('请求编号无效。');
    return this._serial(input.workflowId, async () => {
      const record = await this._load(input.workflowId), document = record.document;
      // Persisted request IDs are never dispatched again, even after restart.
      if (document.attempts.some(attempt => attempt.requestId === input.requestId)) return this._view(record.asset, record.revision);
      if (this._view(record.asset, record.revision).attempts.some(attempt => active(attempt.status) || attempt.status === 'waiting-local')) throw failure('这个角色已有生成、装配或等待本地 Agent 的任务。');
      if (document.attempts.length >= 50) throw failure('当前流程已保留 50 次生成记录，请从选中的候选创建新流程。');
      this._edit(document, input);
      const mode = document.mode;
      const config = mode === 'api' ? this.generationJobs?.provider.publicConfig() : null;
      if (mode === 'api' && !(config?.canGenerate ?? config?.keyConfigured)) throw failure('请先到 AI 生图页配置模型服务和 API Key。');
      const regionNames = selection(document.parts, input.regionNames);
      const selected = document.attempts.find(attempt => attempt.id === document.selectedCandidateId);
      const base = selected?.candidateAssetId ? { assetId: selected.candidateAssetId, revisionId: selected.candidateRevisionId } : { assetId: document.template.assetId, revisionId: document.template.revisionId };
      const attempt = { id: `attempt_${randomUUID().replaceAll('-', '')}`, requestId: input.requestId, mode, sessionId: this.sessionId,
        regionNames, base, brief: document.brief, style: document.style, partNotes: Object.fromEntries(document.parts.map(part => [part.regionName, part.note])),
        ...(config ? { provider: { baseUrl: config.baseUrl, model: config.model, protocol: config.protocol } } : {}),
        status: 'queued', stage: 'preparing', createdAt: now(), updatedAt: now(), error: null, prompt: null, cancelRequested: false };
      document.attempts.push(attempt);
      if (mode === 'local') return generateLocal(this, record, document, attempt);
      const view = await this._write(record, document);
      const runner = this._run(input.workflowId, attempt.id).catch(() => {});
      this.runners.set(attempt.id, runner); runner.finally(() => this.runners.delete(attempt.id));
      return view;
    });
  }
  async _change(workflowId, attemptId, edit) {
    return this._serial(workflowId, async () => { const record = await this._load(workflowId); const attempt = record.document.attempts.find(entry => entry.id === attemptId);
      if (!attempt) throw failure('没有找到本次角色生成记录。');
      await edit(attempt, record.document); attempt.updatedAt = now(); return this._write(record, record.document); });
  }
  async _run(workflowId, attemptId) {
    let generationJobId;
    try {
      const workflow = await this.get({ workflowId });
      const attempt = workflow.attempts.find(item => item.id === attemptId);
      if (this.closed || attempt.cancelRequested) { await this._change(workflowId, attemptId, attempt => { attempt.status = 'cancelled'; }); return; }
      const built = await buildReskinSheet(this.project, { ...attempt.base, regionNames: attempt.regionNames });
      const document = { ...workflow, brief: attempt.brief, style: attempt.style, parts: notes(workflow.parts, attempt.partNotes) };
      const prompt = promptFor(document, built.layout, attempt.regionNames);
      const sheet = await this.project.importImage({ name: `${workflow.name} · 本次部件模板`, fileName: 'part-sheet.png', buffer: built.buffer });
      const guide = { assetId: sheet.id, revisionId: sheet.selectedRevisionId, fileName: 'part-sheet.png', layout: built.layout };
      await this._change(workflowId, attemptId, async attempt => {
        attempt.guide = guide; attempt.prompt = prompt;
        if (this.closed || attempt.cancelRequested) { attempt.status = 'cancelled'; return; }
        attempt.status = 'running'; attempt.stage = 'generating';
      });
      const ready = (await this.get({ workflowId })).attempts.find(item => item.id === attemptId);
      if (ready.status === 'cancelled' || ready.cancelRequested || this.closed) {
        await this._change(workflowId, attemptId, attempt => { attempt.status = 'cancelled'; }); return;
      }
      const config = this.generationJobs.provider.publicConfig();
      if (['baseUrl', 'model', 'protocol'].some(key => config[key] !== attempt.provider[key])) throw failure('准备模板期间模型服务发生改变，请检查服务配置后重新发起。');
      const job = await this.generationJobs.start({ requestId: attempt.id, name: `${workflow.name} · 生成部件图`, prompt,
        size: '1024x1024', quality: 'auto', background: 'auto',
        reference: { assetId: guide.assetId, revisionId: guide.revisionId, fileName: guide.fileName } });
      generationJobId = job.id;
      await this._change(workflowId, attemptId, attempt => { attempt.generationJobId = job.id; });
      while (true) {
        const current = (await this.get({ workflowId })).attempts.find(item => item.id === attemptId);
        if (current.cancelRequested || this.closed) await this.generationJobs.cancel({ jobId: job.id });
        const status = this.generationJobs.get({ jobId: job.id });
        if (status.status === 'succeeded') {
          await this._change(workflowId, attemptId, attempt => { attempt.status = 'running'; attempt.stage = 'assembling'; attempt.sheetAssetId = status.assetId; attempt.sheetRevisionId = status.revisionId; });
          if (!this.closed) await this.assemble({ workflowId, attemptId });
          return;
        }
        if (!active(status.status)) {
          await this._change(workflowId, attemptId, attempt => { attempt.status = status.status; attempt.stage = status.status === 'ready' ? 'save-generated-sheet' : 'stopped'; attempt.error = status.error || null; }); return;
        }
        await delay(300);
      }
    } catch (error) {
      try {
        await this._change(workflowId, attemptId, attempt => { attempt.status = attempt.sheetAssetId ? 'ready' : generationJobId ? 'unknown' : 'failed'; attempt.error = error.message; });
      } catch { /* Persisted pre-dispatch reservation prevents replay after storage failure. */ }
      if (generationJobId) await this.generationJobs.cancel({ jobId: generationJobId }).catch(() => {});
    }
  }
  async assemble(input) {
    fields(input, ['workflowId', 'attemptId'], ['transforms']);
    const initial = await this.get({ workflowId: input.workflowId });
    if (initial.attempts.find(attempt => attempt.id === input.attemptId)?.mode === 'local') return assembleLocal(this, input);
    const key = `${input.workflowId}:${input.attemptId}`;
    if (this.assembling.has(key)) throw failure('该候选正在装配，请等待完成。');
    this.assembling.add(key);
    try {
      let workflow = await this.get({ workflowId: input.workflowId });
      let attempt = workflow.attempts.find(item => item.id === input.attemptId);
      if (!attempt) throw failure('没有找到本次角色生成记录。');
      const transforms = copy(input.transforms ?? attempt.transforms ?? {});
      if (attempt.status === 'succeeded' && attempt.candidateAssetId && JSON.stringify(canonical(transforms)) === JSON.stringify(canonical(attempt.transforms || {}))) return workflow;
      if (!attempt.sheetAssetId) {
        let job = this._generationJob(attempt);
        if (!job) throw failure('没有找到与本次换皮的请求、模板和提示词一致的生成任务；未重新调用模型。');
        if (job?.status === 'ready') job = await this.generationJobs.save({ jobId: job.id });
        if (job?.status === 'succeeded') {
          workflow = await this._change(input.workflowId, input.attemptId, attempt => { attempt.generationJobId = job.id; attempt.sheetAssetId = job.assetId; attempt.sheetRevisionId = job.revisionId; });
          attempt = workflow.attempts.find(item => item.id === input.attemptId);
        }
      }
      if (!attempt.sheetAssetId || !attempt.guide) throw failure('该记录尚无通过检查的生成部件图。请查看生成任务状态；不会重新调用模型。');
      const snapshot = await this.project.snapshot();
      const imageAsset = snapshot.assets.find(asset => asset.id === attempt.sheetAssetId && asset.kind === 'image');
      const imageRevision = imageAsset?.revisions.find(rev => rev.id === attempt.sheetRevisionId);
      const imageFile = imageRevision?.files.find(file => file.role === 'image');
      if (!imageFile) throw failure('生成部件图的指定版本已不可用。');
      const image = await this.project.readArtifact({ assetId: imageAsset.id, revisionId: imageRevision.id, fileName: imageFile.name });
      await this._change(input.workflowId, input.attemptId, attempt => { attempt.status = 'running'; attempt.stage = 'assembling'; attempt.sessionId = this.sessionId; });
      const candidate = await assembleReskinSheet(this.project, { ...attempt.base, buffer: image.buffer, layout: attempt.guide.layout,
        preserveAlpha: workflow.preserveAlpha, transforms, name: `${workflow.name} · 候选 ${workflow.attempts.indexOf(attempt) + 1}`,
        idempotencyKey: `reskin:${attempt.id}:${createHash('sha256').update(JSON.stringify(canonical({ workflowId:input.workflowId, base:attempt.base, sheet:{assetId:imageAsset.id,revisionId:imageRevision.id}, layout:attempt.guide.layout, preserveAlpha:workflow.preserveAlpha, transforms }))).digest('hex')}`,
        provenance: { workflowId: workflow.assetId, attemptId: attempt.id, originalTemplate: workflow.template,
          generatedSheet: { assetId: imageAsset.id, revisionId: imageRevision.id, fileName: imageFile.name }, generation: imageRevision.metadata.generation || null,
          brief: attempt.brief, style: attempt.style, partNotes: attempt.partNotes } });
      const candidateRevisionId = candidate.importReceipt?.revisionId || candidate.selectedRevisionId;
      return await this._change(input.workflowId, input.attemptId, (attempt, document) => {
        attempt.status = 'succeeded'; attempt.stage = 'assembled'; attempt.error = null; attempt.transforms = copy(transforms);
        attempt.candidateAssetId = candidate.id; attempt.candidateRevisionId = candidateRevisionId;
        if (!(attempt.assemblies ||= []).some(item => item.assetId === candidate.id && item.revisionId === candidateRevisionId)) attempt.assemblies.push({ assetId: candidate.id, revisionId: candidateRevisionId, transforms: copy(transforms), createdAt: now() });
        attempt.warnings = candidate.revisions.find(item => item.id === candidateRevisionId).metadata.spine?.issues?.filter(issue => issue.severity === 'warning') || [];
        document.selectedCandidateId = attempt.id;
      });
    } catch (error) {
      try {
        const record = await this._load(input.workflowId), failedAttempt = record.document.attempts.find(item => item.id === input.attemptId);
        const held = ['ready','succeeded'].includes(this._generationJob(failedAttempt)?.status);
        if (failedAttempt.status !== 'succeeded' && (failedAttempt.sheetAssetId || held)) await this._change(input.workflowId, input.attemptId, attempt => {
          if (attempt.status !== 'succeeded') { attempt.status = 'ready'; attempt.error = `生成图已保留，装配尚未完成：${error.message}`; }
        });
      } catch {}
      throw error;
    } finally { this.assembling.delete(key); }
  }
  async cancel(input) {
    fields(input, ['workflowId', 'attemptId'], ['error']);
    if (input.error !== undefined) text(input.error, '中断原因', 1000);
    const view = await this._change(input.workflowId, input.attemptId, attempt => {
      if (attempt.mode === 'local') {
        if (attempt.sheetAssetId || attempt.local.status === 'completed' || attempt.local.status === 'cancelled') return;
        attempt.cancelRequested = true; attempt.cancelRequestedAt = now();
        if (attempt.local.status === 'dispatched') { attempt.status = 'unknown'; attempt.stage = 'awaiting-local-result'; attempt.error = input.error || '本地调用已经登记，结果需要核实；不会自动重发。'; }
        else { attempt.status = 'cancelled'; attempt.stage = 'stopped'; attempt.local.status = 'cancelled'; attempt.error = input.error || null; }
        return;
      }
      if (!active(attempt.status) || attempt.sheetAssetId) return;
      attempt.cancelRequested = true;
      if (attempt.sessionId !== this.sessionId) { attempt.status = 'unknown'; attempt.error = '远端结果需要核实，未重新提交请求。'; }
    });
    const attempt = view.attempts.find(item => item.id === input.attemptId);
    if (attempt.generationJobId && attempt.sessionId === this.sessionId) await this.generationJobs.cancel({ jobId: attempt.generationJobId });
    return view;
  }
  localTask(input) { return localTask(this, input); }
  localClaim(input) { return localClaim(this, input); }
  localAnalyze(input) { return localAnalyze(this, input); }
  localDispatch(input) { return localDispatch(this, input); }
  localComplete(input) { return localComplete(this, input); }
  localFail(input) { return localFail(this, input); }
  async select(input) {
    fields(input, ['workflowId', 'attemptId']);
    return this._change(input.workflowId, input.attemptId, (attempt, document) => {
      if (!attempt.candidateAssetId) throw failure('这个生成记录尚未形成角色候选。');
      document.selectedCandidateId = attempt.id;
    });
  }
  close() { this.closed = true; }
}
