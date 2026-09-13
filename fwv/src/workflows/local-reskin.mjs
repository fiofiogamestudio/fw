import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { safeFileName } from '../core/project.mjs';
import { inspectImage, imageMime, normalizeRecipe } from '../image/processor.mjs';
import { buildReskinSheet, assembleReskinSheet } from '../spine/reskin-template.mjs';
import { promptFor } from './reskin.mjs';

const copy = value => structuredClone(value);
const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function fields(input, required, optional = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) throw fail('本地 Agent 参数不匹配。');
}
function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw fail(`${label}需为 1 到 ${maximum} 字。`);
  return value.trim();
}
export function modeValue(value, fallback = 'api') {
  const mode = value ?? fallback;
  if (!['api', 'local'].includes(mode)) throw fail('换皮模式必须为 local 或 api。');
  return mode;
}
function attemptFrom(record, attemptId) {
  const attempt = record.document.attempts.find(item => item.id === attemptId);
  if (!attempt || attempt.mode !== 'local' || !attempt.local || !attempt.guide) throw fail('没有找到已准备好的本地 Agent 任务。');
  return attempt;
}
function claimed(attempt, claimId) {
  if (!claimId || attempt.local.claimId !== claimId) throw fail('本地任务领取凭据不匹配。', 409);
  if (attempt.cancelRequestedAt || attempt.cancelRequested || attempt.local.status === 'cancelled') throw fail('本地任务已取消，不能再分析、调用或回填。', 409);
}
function taskFor(record, attempt, includeClaim = false) {
  const document = record.document;
  return {
    workflowId: record.asset.id, attemptId: attempt.id, requestId: attempt.requestId,
    ...(includeClaim ? { claimId: attempt.local.claimId } : {}), workerId: attempt.local.workerId || null,
    status: attempt.local.status, canDispatch: attempt.local.status === 'claimed' && !attempt.cancelRequestedAt && !attempt.cancelRequested && Boolean(attempt.local.analysis),
    ...(attempt.local.dispatchedAt ? { dispatchedAt: attempt.local.dispatchedAt } : {}),
    prompt: attempt.prompt, reference: { assetId: attempt.guide.assetId, revisionId: attempt.guide.revisionId, fileName: attempt.guide.fileName },
    layout: copy(attempt.guide.layout), brief: attempt.brief, style: attempt.style,
    parts: copy(document.parts.filter(part => attempt.regionNames.includes(part.regionName)).map(part => ({ ...part, note: attempt.partNotes[part.regionName] || '' }))),
    template: copy(document.template), base: copy(attempt.base), analysis: copy(attempt.local.analysis || null),
    output: { width: 1024, height: 1024, format: 'png', preserveAlpha: document.preserveAlpha, silhouette: document.preserveAlpha ? 'original-mask' : 'unmasked' },
  };
}

/** Commit the output asset and its workflow receipt in the same manifest transaction.
 * Core's existing writer lock and revision writer are used directly to avoid nesting
 * importAsset/addRevision locks. Inputs are validated before the writer is acquired.
 */
async function commitAsset(service, record, document, payload, link) {
  if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 160 || /[\x00-\x1f]/.test(payload.name)) throw fail('本地产物名称无效。');
  if (!['image', 'spine'].includes(payload.kind) || !Array.isArray(payload.files) || !payload.files.length || payload.files.length > 64) throw fail('本地产物类型或文件数量无效。');
  const names = new Set(); let total = 0;
  const files = payload.files.map(file => {
    safeFileName(file.name);
    if (names.has(file.name.toLowerCase()) || !Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > 32 * 1024 * 1024 || !/^[a-z][a-z0-9-]{0,39}$/.test(file.role) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.mime)) throw fail('本地产物文件无效。');
    names.add(file.name.toLowerCase()); total += file.buffer.length;
    return { ...file, buffer: Buffer.from(file.buffer) };
  });
  if (total > 128 * 1024 * 1024) throw fail('本地产物超过版本总大小限制。');
  const project = service.project;
  return project._withLock(async () => {
    const data = await project._load();
    const workflowAsset = project._asset(data, record.asset.id);
    if (workflowAsset.selectedRevisionId !== record.revision.id) throw fail('流程已被另一任务更新，请重新读取后重试。', 409);
    const assetId = id('asset');
    const revision = await project._writeRevision(assetId, { files, metadata: payload.metadata, recipe: payload.recipe });
    const asset = { id: assetId, name: payload.name.trim(), kind: payload.kind, selectedRevisionId: revision.id, revisions: [revision] };
    link(asset, revision, document);
    document.updatedAt = now();
    const workflowRevision = await project._writeRevision(workflowAsset.id, { parentId: record.revision.id,
      files: [{ name: 'workflow.json', role: 'workflow', mime: 'application/json', buffer: Buffer.from(JSON.stringify(document)) }],
      metadata: { reskin: document }, recipe: { operation: 'reskin.workflow', version: 1 } });
    data.assets.push(asset); workflowAsset.revisions.push(workflowRevision); workflowAsset.selectedRevisionId = workflowRevision.id;
    await project._save(data);
    return { asset: copy(asset), workflow: service._view(workflowAsset, workflowRevision) };
  });
}

export async function generateLocal(service, record, document, attempt) {
  const built = await buildReskinSheet(service.project, { ...attempt.base, regionNames: attempt.regionNames });
  const prepared = { ...document, brief: attempt.brief, style: attempt.style, parts: document.parts.map(part => ({ ...part, note: attempt.partNotes[part.regionName] || '' })) };
  attempt.prompt = promptFor(prepared, built.layout, attempt.regionNames);
  attempt.status = 'waiting-local'; attempt.stage = 'waiting-local';
  attempt.local = { status: 'waiting', claimId: null, workerId: null };
  const image = await inspectImage(built.buffer);
  return (await commitAsset(service, record, document, { name: `${document.name} · 本地部件模板`, kind: 'image',
    files: [{ name: 'part-sheet.png', role: 'source', mime: 'image/png', buffer: built.buffer }],
    metadata: { image }, recipe: { operation: 'reskin.local-guide', version: 1, workflowId: record.asset.id, attemptId: attempt.id, base: attempt.base } }, asset => {
    attempt.guide = { assetId: asset.id, revisionId: asset.selectedRevisionId, fileName: 'part-sheet.png', layout: built.layout };
    attempt.updatedAt = now();
  })).workflow;
}

export async function localTask(service, input) {
  fields(input, ['workflowId', 'attemptId']);
  const record = await service._load(input.workflowId), attempt = attemptFrom(record, input.attemptId);
  return { workflow: service._view(record.asset, record.revision), task: taskFor(record, attempt) };
}
export async function localClaim(service, input) {
  fields(input, ['workflowId', 'attemptId', 'workerId']);
  const workerId = text(input.workerId, 'Agent 标识', 100);
  const claim = () => service._serial(input.workflowId, async () => {
    const record = await service._load(input.workflowId), attempt = attemptFrom(record, input.attemptId);
    if (attempt.cancelRequestedAt || attempt.local.status === 'cancelled') throw fail('本地任务已取消。', 409);
    if (attempt.local.workerId && attempt.local.workerId !== workerId) throw fail('本地任务已由另一 Agent 领取，不会重新分配已登记的调用。', 409);
    if (attempt.local.claimId) return { workflow: service._view(record.asset, record.revision), task: taskFor(record, attempt, true) };
    if (attempt.local.status !== 'waiting') throw fail('本地任务目前不能领取。', 409);
    attempt.local.status = 'claimed'; attempt.local.workerId = workerId; attempt.local.claimId = id('claim');
    attempt.local.claimedAt = now(); attempt.stage = 'agent-analysis'; attempt.updatedAt = now();
    const workflow = await service._write(record, record.document);
    return { workflow, task: taskFor(record, attempt, true) };
  });
  try { return await claim(); }
  catch (error) {
    if (error.status !== 409) throw error;
    const record = await service._load(input.workflowId), attempt = attemptFrom(record, input.attemptId);
    if (attempt.local.workerId === workerId && attempt.local.claimId && !attempt.cancelRequestedAt && attempt.local.status !== 'cancelled') return { workflow: service._view(record.asset, record.revision), task: taskFor(record, attempt, true) };
    throw error;
  }
}
export async function localAnalyze(service, input) {
  fields(input, ['workflowId', 'attemptId', 'claimId', 'analysis']);
  const analysis = copy(input.analysis);
  fields(analysis, ['summary', 'partNotes', 'risks']);
  analysis.summary = text(analysis.summary, 'Agent 理解摘要', 1200);
  if (!analysis.partNotes || typeof analysis.partNotes !== 'object' || Array.isArray(analysis.partNotes) || !Array.isArray(analysis.risks) || analysis.risks.length > 8) throw fail('Agent 部件说明或风险列表无效。');
  analysis.risks = analysis.risks.map(risk => text(risk, 'Agent 风险', 200));
  return service._serial(input.workflowId, async () => {
    const record = await service._load(input.workflowId), attempt = attemptFrom(record, input.attemptId);
    claimed(attempt, input.claimId);
    if (attempt.local.status !== 'claimed') throw fail('调用登记后不能修改 Agent 理解或提示词。', 409);
    for (const [regionName, note] of Object.entries(analysis.partNotes)) {
      if (!attempt.regionNames.includes(regionName)) throw fail('Agent 说明包含未选中的部件。');
      analysis.partNotes[regionName] = text(note, 'Agent 部件说明', 300);
    }
    const document = { ...record.document, brief: attempt.brief, style: attempt.style,
      parts: record.document.parts.map(part => ({ ...part, note: attempt.partNotes[part.regionName] || '' })), analysis };
    const prompt = promptFor(document, attempt.guide.layout, attempt.regionNames);
    attempt.local.analysis = analysis; attempt.local.analyzedAt = now(); attempt.prompt = prompt; attempt.updatedAt = now();
    return service._write(record, record.document);
  });
}
export async function localDispatch(service, input) {
  fields(input, ['workflowId', 'attemptId', 'claimId']);
  return service._serial(input.workflowId, async () => {
    const record = await service._load(input.workflowId), attempt = attemptFrom(record, input.attemptId);
    claimed(attempt, input.claimId);
    if (attempt.local.status !== 'claimed') throw fail('该调用已登记或任务已终止，禁止再次调用模型。', 409);
    if (!attempt.local.analysis) throw fail('请先记录 Agent 对角色与部件的理解再登记调用。');
    attempt.local.status = 'dispatched'; attempt.local.dispatchedAt = now(); attempt.stage = 'local-generation'; attempt.updatedAt = now();
    return service._write(record, record.document);
  });
}

async function registeredImage(project, assetId, revisionId) {
  const snapshot = await project.snapshot();
  const asset = snapshot.assets.find(asset => asset.id === assetId && asset.kind === 'image');
  const revision = asset?.revisions.find(revision => revision.id === revisionId);
  const file = revision?.files.find(file => file.role === 'image') ?? revision?.files.find(file => file.role === 'source');
  if (!file) throw fail('本地结果必须是已登记图片资源的指定版本。');
  const artifact = await project.readArtifact({ assetId, revisionId, fileName: file.name });
  const image = await inspectImage(artifact.buffer);
  if (image.width !== 1024 || image.height !== 1024 || image.orientation && image.orientation !== 1) throw fail('本地结果必须为 1024×1024 PNG/JPEG/WebP，且不带旋转方向。');
  if (!isDeepStrictEqual(image, revision.metadata.image)) throw fail('图片索引元数据与实际文件不一致，请检查指定版本。');
  return { asset, revision, file, buffer: artifact.buffer, image, sha256: digest(artifact.buffer) };
}
async function sourceResultFor(project, output) {
  const result = { assetId: output.asset.id, revisionId: output.revision.id, fileName: output.file.name, sha256: output.sha256 };
  if (!output.revision.parentId) return result;
  // Derived results must describe the actual FWV image operation. Do not copy
  // arbitrary recipe fields or accept caller-supplied normalization claims.
  const processingRecipe = normalizeRecipe(output.revision.recipe);
  if (!isDeepStrictEqual(processingRecipe, output.revision.recipe) || processingRecipe.width !== output.image.width || processingRecipe.height !== output.image.height) throw fail('派生图片的处理配方与指定版本尺寸不一致。');
  const parent = output.asset.revisions.find(revision => revision.id === output.revision.parentId);
  const file = parent?.files.find(file => file.role === 'image') ?? parent?.files.find(file => file.role === 'source');
  if (!file) throw fail('派生图片缺少可核实的父版本输入。');
  const artifact = await project.readArtifact({ assetId: output.asset.id, revisionId: parent.id, fileName: file.name });
  const source = await inspectImage(artifact.buffer);
  if (!isDeepStrictEqual(source, parent.metadata.image)) throw fail('父版本图片索引元数据与实际文件不一致。');
  return { ...result, parentRevisionId: parent.id, processingRecipe: copy(processingRecipe),
    sourceDimensions: { width: source.width, height: source.height }, resultDimensions: { width: output.image.width, height: output.image.height },
    parentInput: { assetId: output.asset.id, revisionId: parent.id, fileName: file.name, sha256: digest(artifact.buffer), width: source.width, height: source.height } };
}
function executionValue(value) {
  fields(value, ['provider', 'model', 'tool'], ['notes']);
  const result = Object.fromEntries(['provider', 'model', 'tool'].map(key => [key, text(value[key], `执行来源 ${key}`, 100)]));
  if (value.notes !== undefined) result.notes = text(value.notes, '执行说明', 1000);
  return result;
}
export async function localComplete(service, input) {
  fields(input, ['workflowId', 'attemptId', 'claimId', 'imageAssetId', 'imageRevisionId', 'execution']);
  const execution = executionValue(copy(input.execution));
  let shouldAssemble = false;
  const complete = async () => service._serial(input.workflowId, async () => {
    const record = await service._load(input.workflowId), attempt = attemptFrom(record, input.attemptId);
    claimed(attempt, input.claimId);
    if (!['dispatched', 'completed'].includes(attempt.local.status)) throw fail('请先登记模型调用，再回填其结果。', 409);
    const output = await registeredImage(service.project, input.imageAssetId, input.imageRevisionId);
    if (attempt.local.receipt) {
      if (attempt.local.receipt.assetId !== input.imageAssetId || attempt.local.receipt.revisionId !== input.imageRevisionId || attempt.local.receipt.fileName !== output.file.name || attempt.local.receipt.sha256 !== output.sha256 || !isDeepStrictEqual(attempt.local.receipt.execution, execution)) throw fail('本次调用已接收其他输出或执行来源，不能覆盖。', 409);
      shouldAssemble = !attempt.candidateAssetId;
      return service._view(record.asset, record.revision);
    }
    const guide = await service.project.readArtifact({ assetId: attempt.guide.assetId, revisionId: attempt.guide.revisionId, fileName: attempt.guide.fileName });
    const sourceResult = await sourceResultFor(service.project, output);
    const generation = { ...execution, mode: 'local', requestId: attempt.requestId, workflowId: record.asset.id, attemptId: attempt.id,
      prompt: attempt.prompt, analysis: copy(attempt.local.analysis), reference: { assetId: attempt.guide.assetId, revisionId: attempt.guide.revisionId, fileName: attempt.guide.fileName, sourceFile: 'reference.png', sha256: digest(guide.buffer) },
      sourceResult, template: copy(record.document.template), base: copy(attempt.base), layout: copy(attempt.guide.layout), size: '1024x1024', background: 'auto', generatedAt: now(), dispatchedAt: attempt.local.dispatchedAt };
    const fileName = `generated.${output.image.format === 'jpeg' ? 'jpg' : output.image.format}`;
    const result = await commitAsset(service, record, record.document, { name: `${record.document.name} · 本地生成部件图`, kind: 'image',
      files: [{ name: fileName, role: 'image', mime: imageMime(output.image.format), buffer: output.buffer }, { name: 'reference.png', role: 'reference', mime: 'image/png', buffer: guide.buffer }],
      metadata: { image: output.image, generation }, recipe: { operation: 'image.edit', version: 1, generation } }, asset => {
      attempt.sheetAssetId = asset.id; attempt.sheetRevisionId = asset.selectedRevisionId;
      attempt.local.receipt = { ...sourceResult, execution, receivedAt: now() };
      attempt.local.status = 'completed'; attempt.local.completedAt = now(); attempt.status = 'ready'; attempt.stage = 'local-sheet-saved'; attempt.error = null; attempt.updatedAt = now();
    });
    shouldAssemble = true; return result.workflow;
  });
  let workflow;
  try { workflow = await complete(); }
  catch (error) {
    if (error.status !== 409) throw error;
    // Another process may have atomically accepted this same result. Read it
    // again once; conflicting claims, cancellation and different bytes still fail.
    workflow = await complete();
  }
  if (shouldAssemble) {
    try { return await assembleLocal(service, { workflowId: input.workflowId, attemptId: input.attemptId }); }
    catch { return service.get({ workflowId: input.workflowId }); }
  }
  return workflow;
}

export async function assembleLocal(service, input) {
  return service._serial(input.workflowId, async () => {
    let record = await service._load(input.workflowId), attempt = attemptFrom(record, input.attemptId);
    if (attempt.cancelRequestedAt || attempt.cancelRequested) throw fail('本地任务已取消，不能重新装配。', 409);
    if (!attempt.sheetAssetId || attempt.local.status !== 'completed') throw fail('本地任务尚未接收生成部件图。');
    if (attempt.candidateAssetId && input.transforms === undefined) return service._view(record.asset, record.revision);
    const transforms = copy(input.transforms ?? attempt.transforms ?? {});
    const output = await registeredImage(service.project, attempt.sheetAssetId, attempt.sheetRevisionId);
    let committed;
    // Assemble performs its ordinary validation and pixel operations, then the
    // final import is atomically linked to this exact workflow revision.
    const project = Object.create(service.project);
    project.importAsset = async payload => {
      const result = await commitAsset(service, record, record.document, payload, (candidate, revision, document) => {
        attempt.status = 'succeeded'; attempt.stage = 'assembled'; attempt.error = null; attempt.transforms = copy(transforms); attempt.updatedAt = now();
        attempt.candidateAssetId = candidate.id; attempt.candidateRevisionId = revision.id;
        (attempt.assemblies ||= []).push({ assetId: candidate.id, revisionId: revision.id, transforms: copy(transforms), createdAt: now() });
        attempt.warnings = revision.metadata.spine?.issues?.filter(issue => issue.severity === 'warning') || [];
        document.selectedCandidateId = attempt.id;
      });
      committed = result.workflow; return result.asset;
    };
    try {
      await assembleReskinSheet(project, { ...attempt.base, buffer: output.buffer, layout: attempt.guide.layout, preserveAlpha: record.document.preserveAlpha,
        transforms, name: `${record.document.name} · 候选 ${record.document.attempts.indexOf(attempt) + 1}`,
        provenance: { mode: 'local', workflowId: record.asset.id, attemptId: attempt.id, originalTemplate: record.document.template,
          generatedSheet: { assetId: output.asset.id, revisionId: output.revision.id, fileName: output.file.name }, generation: output.revision.metadata.generation,
          prompt: attempt.prompt, analysis: attempt.local.analysis, brief: attempt.brief, style: attempt.style, partNotes: attempt.partNotes } });
      return committed;
    } catch (error) {
      record = await service._load(input.workflowId); attempt = attemptFrom(record, input.attemptId);
      if (error.status === 409 && attempt.candidateAssetId && isDeepStrictEqual(attempt.transforms || {}, transforms)) return service._view(record.asset, record.revision);
      if (!attempt.cancelRequestedAt && !attempt.candidateAssetId) {
        attempt.status = 'ready'; attempt.stage = 'assembly-failed'; attempt.error = `生成图已保留，装配尚未完成：${error.message}`; attempt.updatedAt = now();
        await service._write(record, record.document);
      }
      throw error;
    }
  });
}
export async function localFail(service, input) {
  fields(input, ['workflowId', 'attemptId', 'claimId', 'error']);
  const error = text(input.error, '本地执行中断原因', 1000);
  return service._serial(input.workflowId, async () => {
    const record = await service._load(input.workflowId), attempt = attemptFrom(record, input.attemptId);
    claimed(attempt, input.claimId);
    if (attempt.local.status === 'completed') return service._view(record.asset, record.revision);
    if (attempt.local.status === 'dispatched') { attempt.status = 'unknown'; attempt.stage = 'awaiting-local-result'; }
    else { attempt.local.status = 'cancelled'; attempt.status = 'cancelled'; attempt.stage = 'stopped'; }
    attempt.error = error; attempt.updatedAt = now();
    return service._write(record, record.document);
  });
}
