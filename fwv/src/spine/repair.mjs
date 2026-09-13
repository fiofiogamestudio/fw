import { isDeepStrictEqual } from 'node:util';
import { inspectSpine } from './index.mjs';

const copy = value => structuredClone(value);
const failure = message => Object.assign(new Error(message), { status: 400, code: 'SPINE_REPAIR_INVALID' });
const localDefaults = Object.freeze({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, length: 0 });
const coordinateLimit = 1e6;
const numeric = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= coordinateLimit;
function fields(value, required = [], optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw failure('Spine 修复参数不匹配。');
}
function name(value) { if (typeof value !== 'string' || !value || value.length > 160) throw failure('骨骼或附件名称无效。'); return value; }
function localTransform(bone) {
  return Object.fromEntries(Object.entries(localDefaults).map(([key, fallback]) => {
    const value = bone[key] ?? fallback;
    if (!numeric(value) || key === 'length' && value < 0) throw failure(`骨骼 ${bone.name} 的 ${key} 不是有效变换值。`);
    return [key, value];
  }));
}
function hierarchy(skeleton) {
  if (!Array.isArray(skeleton.bones) || !skeleton.bones.length) throw failure('Spine 缺少骨骼数组。');
  const byName = new Map();
  for (const [index, bone] of skeleton.bones.entries()) {
    name(bone.name); localTransform(bone);
    if (byName.has(bone.name)) throw failure(`重复骨骼：${bone.name}。`);
    byName.set(bone.name, { bone, index });
  }
  for (const { bone } of byName.values()) {
    const seen = new Set([bone.name]); let parent = bone.parent;
    while (parent) {
      if (!byName.has(parent)) throw failure(`骨骼 ${bone.name} 的父级 ${parent} 不存在。`);
      if (seen.has(parent)) throw failure(`骨骼 ${bone.name} 的父子关系形成循环。`);
      seen.add(parent); parent = byName.get(parent).bone.parent;
    }
  }
  for (const { bone, index } of byName.values()) if (bone.parent && byName.get(bone.parent).index >= index) throw failure(`父骨骼 ${bone.parent} 必须位于 ${bone.name} 之前；此修复器不重排骨骼索引。`);
  return byName;
}
function attachments(skeleton) {
  const result = [];
  for (const skin of skeleton.skins ?? []) for (const [slot, entries] of Object.entries(skin.attachments ?? {})) for (const [attachment, value] of Object.entries(entries)) result.push({ skin: skin.name, slot, attachment, value });
  return result;
}
const sameMesh = (left, right) => ['skin', 'slot', 'attachment'].every(key => left[key] === right[key]);
function readMesh(entry, skeleton, entries) {
  const mesh = entry.value, type = mesh.type ?? 'region';
  // The 4.2 official reader also treats type=mesh with a parent as a linked mesh.
  if (type === 'linkedmesh' || type === 'mesh' && mesh.parent) return { skin: entry.skin, slot: entry.slot, attachment: entry.attachment, type, weighted: null, editable: false, reason: '关联网格共享几何与权重；请在专业源工程中处理。', parent: mesh.parent };
  if (type !== 'mesh') return null;
  if (!Array.isArray(mesh.uvs) || mesh.uvs.length < 6 || mesh.uvs.length % 2 || mesh.uvs.some(value => !numeric(value)) || !Array.isArray(mesh.vertices)) throw failure(`网格 ${entry.attachment} 缺少有效 UV 或顶点数据。`);
  const vertexCount = mesh.uvs.length / 2;
  if (!Array.isArray(mesh.triangles) || !mesh.triangles.length || mesh.triangles.length % 3 || mesh.triangles.some(value => !Number.isSafeInteger(value) || value < 0 || value >= vertexCount)) throw failure(`网格 ${entry.attachment} 的三角形索引无效。`);
  const weighted = mesh.vertices.length !== mesh.uvs.length;
  const dependents = entries.filter(item => ['mesh', 'linkedmesh'].includes(item.value.type) && item.slot === entry.slot && item.value.parent === entry.attachment && (item.value.skin ?? 'default') === entry.skin)
    .map(item => ({ skin: item.skin, slot: item.slot, attachment: item.attachment }));
  const report = { skin: entry.skin, slot: entry.slot, attachment: entry.attachment, type, vertexCount, weighted, editable: weighted && !dependents.length,
    reason: weighted ? dependents.length ? '存在关联网格，修改共享权重会影响其他附件。' : null : '此网格没有骨骼权重；本修复器不自动创建绑定。', dependents, vertices: [] };
  if (!weighted) {
    if (mesh.vertices.some(value => !numeric(value))) throw failure(`网格 ${entry.attachment} 的坐标无效。`);
    return report;
  }
  let offset = 0;
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex++) {
    const count = mesh.vertices[offset++];
    if (!Number.isSafeInteger(count) || count < 1 || count > skeleton.bones.length || offset + count * 4 > mesh.vertices.length) throw failure(`网格 ${entry.attachment} 第 ${vertexIndex} 顶点的 influence 数量无效。`);
    const influences = [], seen = new Set();
    for (let index = 0; index < count; index++) {
      const boneIndex = mesh.vertices[offset], x = mesh.vertices[offset + 1], y = mesh.vertices[offset + 2], weight = mesh.vertices[offset + 3];
      if (!Number.isSafeInteger(boneIndex) || boneIndex < 0 || boneIndex >= skeleton.bones.length || seen.has(boneIndex)
        || !numeric(x) || !numeric(y) || !Number.isFinite(weight) || weight < 0 || weight > 1) throw failure(`网格 ${entry.attachment} 第 ${vertexIndex} 顶点的骨骼、绑定坐标或权重无效。`);
      seen.add(boneIndex);
      influences.push({ boneIndex, boneName: skeleton.bones[boneIndex].name, x, y, weight, weightOffset: offset + 3 });
      offset += 4;
    }
    report.vertices.push({ vertexIndex, sum: influences.reduce((sum, item) => sum + item.weight, 0), influences });
  }
  if (offset !== mesh.vertices.length) throw failure(`网格 ${entry.attachment} 的权重数组包含多余数据。`);
  report.influenceCount = report.vertices.reduce((sum, vertex) => sum + vertex.influences.length, 0);
  report.unnormalizedVertices = report.vertices.filter(vertex => Math.abs(vertex.sum - 1) > 1e-5).map(vertex => vertex.vertexIndex);
  return report;
}
function duration(animation) {
  let maximum = 0;
  function visit(value) {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (key === 'time' && typeof child === 'number' && Number.isFinite(child) && child >= 0) maximum = Math.max(maximum, child);
      else visit(child);
    }
  }
  visit(animation); return maximum;
}
function inspectDocument(skeleton, options = {}) {
  const byName = hierarchy(skeleton), entries = attachments(skeleton), meshes = entries.map(entry => readMesh(entry, skeleton, entries)).filter(Boolean);
  const diagnostics = [];
  const bones = skeleton.bones.map((bone, index) => {
    const local = localTransform(bone), children = skeleton.bones.filter(item => item.parent === bone.name).map(item => item.name);
    const constraints = ['ik', 'transform', 'path'].flatMap(type => (skeleton[type] ?? []).filter(item => item.target === bone.name || item.bones?.includes(bone.name)).map(item => ({ type, name: item.name })));
    if (!local.scaleX || !local.scaleY) diagnostics.push({ code: 'ZERO_BONE_SCALE', severity: 'warning', boneName: bone.name, message: '零缩放会压扁此骨骼及其后代，可检查 setup pose 的 scaleX/scaleY。' });
    if (constraints.length) diagnostics.push({ code: 'CONSTRAINED_BONE', severity: 'note', boneName: bone.name, message: '此骨骼参与约束，局部变换会受约束影响；应对照具体动作检查。' });
    return { name: bone.name, index, parent: bone.parent ?? null, children, local, constraints, allowedParents: skeleton.bones.slice(0, index).map(item => item.name),
      timelines: Object.entries(skeleton.animations ?? {}).filter(([, animation]) => animation.bones?.[bone.name]).map(([animation, value]) => ({ animation, properties: Object.keys(value.bones[bone.name]) })) };
  });
  for (const mesh of meshes) if (mesh.unnormalizedVertices?.length) diagnostics.push({ code: 'WEIGHTS_NOT_NORMALIZED', severity: 'warning', skin: mesh.skin, slot: mesh.slot, attachment: mesh.attachment,
    count: mesh.unnormalizedVertices.length, message: '存在权重和不为 1 的顶点；指定已有 influence 后可按比例归一该顶点。' });
  let vertex = null;
  if (options.mesh !== undefined) {
    fields(options.mesh, ['skin', 'slot', 'attachment']);
    const mesh = meshes.find(item => sameMesh(item, options.mesh));
    if (!mesh) throw failure('找不到指定网格。');
    if (options.vertexIndex !== undefined) {
      if (!Number.isSafeInteger(options.vertexIndex) || options.vertexIndex < 0 || options.vertexIndex >= (mesh.vertexCount || 0)) throw failure('顶点编号超出网格范围。');
      vertex = mesh.vertices?.[options.vertexIndex] ? copy(mesh.vertices[options.vertexIndex]) : null;
      if (vertex) vertex.influences = vertex.influences.map(({ weightOffset, ...influence }) => influence);
    }
  } else if (options.vertexIndex !== undefined) throw failure('读取顶点需要指定网格。');
  return { format: 'spine-4.2-json', bones, meshes: meshes.map(({ vertices, ...mesh }) => mesh), vertex,
    animations: Object.entries(skeleton.animations ?? {}).map(([name, value]) => ({ name, duration: duration(value) })), diagnostics,
    capabilities: { boneLocalTransform: true, earlierBoneParent: true, existingWeightedMeshInfluence: true, meshCreation: false, linkedMeshWeights: false, animationEditing: false },
    limits: ['只修改 setup pose 的指定局部字段或既有父级；不保持修改骨骼的世界空间姿势。', '保持骨骼数组顺序，不重写权重索引。父级变更会影响后代的世界空间姿势。', '不修改贴图、Atlas、slot、动画、IK/路径/变换约束；它们的运行效果仍需同动作时刻检查。', '单项权重操作只针对独立 weighted mesh 的既有 influence，同顶点其他权重按比例归一。'] };
}

export function inspectSpineBindings(skeleton) { return inspectDocument(skeleton); }

export async function loadSpineRepairSource(project, { asset, revision }) {
  if (asset.kind !== 'spine') throw failure('此工具只接受已有 Spine 素材。');
  const files = [];
  for (const file of revision.files) files.push({ ...copy(file), buffer: await project._readFile(asset.id, revision.id, file) });
  const skeletonFile = files.find(file => file.role === 'skeleton'), atlasFile = files.find(file => file.role === 'atlas');
  if (!skeletonFile || !atlasFile) throw failure('Spine 骨骼或 Atlas 文件缺失。');
  const pages = new Map(files.filter(file => file.role === 'texture').map(file => [file.name, file.buffer]));
  const validation = await inspectSpine({ json: skeletonFile.buffer, atlas: atlasFile.buffer, pages });
  if (!validation.supported) throw failure('素材超出此修复器支持范围：' + validation.issues.filter(item => item.severity === 'error').map(item => item.message).join(' '));
  let skeleton;
  try { skeleton = JSON.parse(skeletonFile.buffer.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw failure('Spine JSON 无法解析。'); }
  return { files, skeletonFile, atlasFile, pages, skeleton, validation };
}

export async function inspectSpineRepair(project, pair, options = {}) {
  const loaded = await loadSpineRepairSource(project, pair);
  return { assetId: pair.asset.id, revisionId: pair.revision.id, name: pair.asset.name, ...inspectDocument(loaded.skeleton, options) };
}

/** Pure candidate preparation: caller atomically registers the result and review
 * request together. The original skeleton file is never overwritten. */
export async function prepareSpineRepair(project, pair, input) {
  fields(input, [], ['boneEdits', 'weightEdits']);
  const boneEdits = copy(input.boneEdits ?? []), weightEdits = copy(input.weightEdits ?? []);
  if (!Array.isArray(boneEdits) || !Array.isArray(weightEdits) || !boneEdits.length && !weightEdits.length || boneEdits.length > 32 || weightEdits.length > 32) throw failure('请提交 1 到 32 项骨骼或权重修改。');
  const loaded = await loadSpineRepairSource(project, pair), skeleton = copy(loaded.skeleton), before = inspectDocument(skeleton), edits = [], changedNames = new Set();
  for (const edit of boneEdits) {
    fields(edit, ['boneName'], ['local', 'parent']); name(edit.boneName);
    if (changedNames.has(edit.boneName)) throw failure('一次候选不能重复修改同一骨骼。');
    changedNames.add(edit.boneName);
    const bone = skeleton.bones.find(item => item.name === edit.boneName);
    if (!bone) throw failure(`未知骨骼 ${edit.boneName}。`);
    const previous = copy(bone);
    if (edit.local !== undefined) {
      fields(edit.local, [], Object.keys(localDefaults));
      if (!Object.keys(edit.local).length) throw failure('局部变换不能为空。');
      for (const [key, value] of Object.entries(edit.local)) {
        if (!numeric(value) || key === 'length' && value < 0) throw failure(`局部变换 ${key} 必须为有效有限数值。`);
        bone[key] = value;
      }
    }
    if (edit.parent !== undefined) {
      name(edit.parent);
      if (skeleton.bones[0].name === edit.boneName) throw failure('此修复器不改变根骨骼父级。');
      bone.parent = edit.parent;
    }
    if (isDeepStrictEqual(previous, bone)) throw failure(`骨骼 ${edit.boneName} 没有实际修改。`);
    edits.push({ type: 'bone', boneName: edit.boneName, before: { parent: previous.parent ?? null, local: localTransform(previous) }, after: { parent: bone.parent ?? null, local: localTransform(bone) } });
  }
  hierarchy(skeleton); // Reject unknown parents, cycles and index reordering before any writes.
  const entries = attachments(skeleton), weightTargets = new Set();
  for (const edit of weightEdits) {
    fields(edit, ['skin', 'slot', 'attachment', 'vertexIndex', 'boneName', 'weight']);
    for (const key of ['skin', 'slot', 'attachment', 'boneName']) name(edit[key]);
    const key = JSON.stringify([edit.skin, edit.slot, edit.attachment, edit.vertexIndex]);
    if (weightTargets.has(key)) throw failure('一次候选只能对同一网格顶点提交一项权重重分配。');
    weightTargets.add(key);
    if (!Number.isFinite(edit.weight) || edit.weight < 0 || edit.weight > 1) throw failure('权重必须是 0 到 1 的有限数值。');
    const entry = entries.find(item => sameMesh(item, edit));
    if (!entry) throw failure('未知网格附件。');
    const mesh = readMesh(entry, skeleton, entries);
    if (!mesh?.editable) throw failure(mesh?.reason || '该附件不支持权重修改。');
    if (!Number.isSafeInteger(edit.vertexIndex) || edit.vertexIndex < 0 || edit.vertexIndex >= mesh.vertexCount) throw failure('顶点编号超出网格范围。');
    const vertex = mesh.vertices[edit.vertexIndex], influence = vertex.influences.find(item => item.boneName === edit.boneName);
    if (!influence) throw failure('该骨骼不是此顶点已有的 influence；此操作不新增绑定。');
    const other = vertex.influences.filter(item => item !== influence), sum = other.reduce((total, item) => total + item.weight, 0);
    if ((!other.length || sum === 0) && edit.weight !== 1) throw failure('其余 influence 没有可分配权重；此操作不推断新的绑定。');
    const previous = vertex.influences.map(({ weightOffset, ...item }) => item);
    entry.value.vertices[influence.weightOffset] = edit.weight;
    for (const item of other) entry.value.vertices[item.weightOffset] = sum ? item.weight / sum * (1 - edit.weight) : 0;
    const after = readMesh(entry, skeleton, entries).vertices[edit.vertexIndex].influences.map(({ weightOffset, ...item }) => item);
    if (isDeepStrictEqual(previous, after)) throw failure('此权重操作没有实际修改。');
    edits.push({ type: 'mesh-weight', skin: edit.skin, slot: edit.slot, attachment: edit.attachment, vertexIndex: edit.vertexIndex, before: previous, after, normalization: 'other-existing-influences-proportional' });
  }
  const after = inspectDocument(skeleton);
  if (!isDeepStrictEqual(skeleton.animations, loaded.skeleton.animations) || !isDeepStrictEqual(skeleton.slots, loaded.skeleton.slots)) throw failure('修复意外改变动画或 slot，已中止。');
  const buffer = Buffer.from(JSON.stringify(skeleton, null, 2) + '\n');
  const report = await inspectSpine({ json: buffer, atlas: loaded.atlasFile.buffer, pages: loaded.pages });
  if (!report.supported) throw failure('修复候选未通过 Spine 结构检查。');
  return { files: loaded.files.map(file => ({ ...file, buffer: file.name === loaded.skeletonFile.name ? buffer : file.buffer })),
    metadata: { ...copy(pair.revision.metadata), spine: { ...report, jsonFile: loaded.skeletonFile.name, atlasFile: loaded.atlasFile.name },
      spineRepair: { source: { assetId: pair.asset.id, revisionId: pair.revision.id }, edits, preserved: ['bone-order', 'atlas', 'textures', 'slots', 'animations', 'constraints'], beforeDiagnostics: before.diagnostics, afterDiagnostics: after.diagnostics } },
    recipe: { operation: 'spine.repair', version: 1, input: { assetId: pair.asset.id, revisionId: pair.revision.id }, boneEdits, weightEdits }, inspection: after };
}
