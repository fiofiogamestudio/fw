import { inspectGlb, repairGlb, extractTexture, inspectVertex } from './glb.mjs';
import { safeFileName } from '../core/project.mjs';
import { inspectImage } from '../image/processor.mjs';

const fail = message => Object.assign(new Error(message), { status: 400, code: 'MODEL_INVALID' });
export async function readModel(project, { assetId, revisionId }) {
  if (!revisionId) throw fail('必须选择确切模型版本。');
  const data = await project.snapshot(), asset = project._asset(data, assetId), revision = project._revision(asset, revisionId);
  if (asset.kind !== 'model3d') throw fail('此素材不是 3D 模型。');
  const file = revision.files.find(item => item.role === 'model'); if (!file) throw fail('模型文件缺失。');
  return { asset, revision, file, buffer: await project._readFile(asset.id, revision.id, file) };
}
export async function importModel(project, { name, fileName, buffer }) {
  safeFileName(fileName); if (!/\.glb$/i.test(fileName)) throw fail('请导入 .glb 文件。');
  const bytes = Buffer.from(buffer), model = await inspectGlb(bytes);
  return project.importAsset({ name, kind: 'model3d', files: [{ name: fileName, role: 'model', mime: 'model/gltf-binary', buffer: bytes }], metadata: { model }, recipe: { operation: 'model.import', version: 1 } });
}
export async function inspectModel(project, input) {
  const { asset, revision, buffer } = await readModel(project, input);
  return { assetId: asset.id, revisionId: revision.id, ...await inspectGlb(buffer) };
}
export async function modelTexture(project, input) { const { buffer } = await readModel(project, input); return extractTexture(buffer, input.imageIndex); }
export async function modelVertex(project, input) { const { buffer } = await readModel(project, input); return inspectVertex(buffer, input); }
export async function extractModelTexture(project, input) {
  const { asset, revision, buffer } = await readModel(project, input), texture = extractTexture(buffer, input.imageIndex);
  const image = await inspectImage(texture.buffer);
  return project.importAsset({ name: `${asset.name.slice(0, 120)} · 贴图 ${input.imageIndex}`, kind: 'image',
    idempotencyKey: `texture:${asset.id}:${revision.id}:${input.imageIndex}`,
    files: [{ name: 'texture.' + (texture.mime === 'image/png' ? 'png' : 'jpg'), role: 'image', mime: texture.mime, buffer: texture.buffer }],
    metadata: { image, modelSource: { assetId: asset.id, revisionId: revision.id, imageIndex: input.imageIndex } }, recipe: { operation: 'model.texture.extract', version: 1 } });
}
export async function repairModelCandidate(state, input) {
  const spec = { boneEdits: input.boneEdits || [], weightEdits: input.weightEdits || [], textureEdits: input.textureEdits || [] };
  return state.artChanges.addPreparedCandidate({ changeId: input.changeId, requestId: input.requestId, operation: 'model.repair', spec,
    note: input.note, execution: { kind: 'model-repair', tool: 'fwd-glb' } }, async (pair, fixed) => {
    if (pair.asset.kind !== 'model3d') throw fail('模型修复必须对应 3D 素材问题。');
    const file = pair.revision.files.find(item => item.role === 'model'); if (!file) throw fail('模型文件缺失。');
    const textureEdits = [];
    for (const edit of fixed.textureEdits) {
      if (!edit || Object.keys(edit).sort().join(',') !== 'assetId,imageIndex,revisionId' || !edit.revisionId) throw fail('请选择贴图和已导入图片的确切版本。');
      const data = await state.application.snapshot(), asset = state.application._asset(data, edit.assetId), revision = state.application._revision(asset, edit.revisionId);
      if (asset.kind !== 'image') throw fail('贴图候选必须是图片素材。');
      const imageFile = revision.files.find(item => item.role === 'image') || revision.files.find(item => item.role === 'source');
      if (!imageFile) throw fail('图片文件缺失。');
      const bytes = await state.application._readFile(asset.id, revision.id, imageFile), image = await inspectImage(bytes);
      if (!['png', 'jpeg'].includes(image.format)) throw fail('GLB 贴图候选需 PNG/JPEG；请先在图片加工页转换。');
      textureEdits.push({ imageIndex: edit.imageIndex, buffer: bytes, mime: image.format === 'png' ? 'image/png' : 'image/jpeg' });
    }
    const repaired = await repairGlb(await state.application._readFile(pair.asset.id, pair.revision.id, file), { ...fixed, textureEdits });
    const files = [];
    for (const sourceFile of pair.revision.files) files.push({ ...sourceFile, buffer: sourceFile.name === file.name ? repaired.buffer
      : await state.application._readFile(pair.asset.id, pair.revision.id, sourceFile) });
    return { files, metadata: { ...pair.revision.metadata, model: repaired.summary },
      recipe: { operation: 'model.repair', version: 1, source: { assetId: pair.asset.id, revisionId: pair.revision.id }, parameters: fixed } };
  });
}
