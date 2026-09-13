import validator from 'gltf-validator';
import { inspectImage } from '../image/processor.mjs';

const fail = message => Object.assign(new Error(message), { status: 400, code: 'MODEL_INVALID' });
const JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
const supportedExtensions = new Set(['KHR_materials_unlit', 'KHR_texture_transform']);
const counts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const formats = { 5121: [1, 'readUInt8', 255], 5123: [2, 'readUInt16LE', 65535], 5125: [4, 'readUInt32LE', 4294967295], 5126: [4, 'readFloatLE', 1] };
function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw fail('3D 操作参数不匹配。');
}
function vector(value, size, label) {
  if (!Array.isArray(value) || value.length !== size || !value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e8)) throw fail(`${label}需要 ${size} 个有限数值。`);
  return [...value];
}
function index(value, array, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= (array?.length || 0)) throw fail(`${label}不存在。`);
  return array[value];
}

/** Only self-contained GLB is accepted. No loader can resolve project input as a URL. */
export function decodeGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 28 || buffer.length > 20 * 1024 * 1024 || buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) throw fail('需要完整的 glTF 2.0 GLB 文件（最多 20 MiB）。');
  const chunks = []; let offset = 12;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw fail('GLB 分块头被截断。');
    const size = buffer.readUInt32LE(offset), type = buffer.readUInt32LE(offset + 4); offset += 8;
    if (size % 4 || offset + size > buffer.length) throw fail('GLB 分块长度无效。');
    chunks.push({ type, bytes: buffer.subarray(offset, offset + size) }); offset += size;
  }
  if (chunks.length !== 2 || chunks[0].type !== JSON_CHUNK || chunks[1].type !== BIN_CHUNK) throw fail('目前支持包含一个 JSON 块和一个内嵌 BIN 块的 GLB。');
  let json;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(chunks[0].bytes)); } catch { throw fail('GLB JSON 无效。'); }
  if (json?.asset?.version !== '2.0' || json.buffers?.length !== 1 || json.buffers[0].uri !== undefined) throw fail('目前只支持 glTF 2.0 和单个内嵌 buffer。');
  const binary = chunks[1].bytes, size = json.buffers[0].byteLength;
  if (!Number.isSafeInteger(size) || size <= 0 || size > binary.length || binary.length - size > 3) throw fail('GLB 内嵌数据长度不匹配。');
  // Bound traversal and reject extension-driven external resources before either validator or renderer runs.
  const todo = [{ value: json, depth: 0 }]; let visited = 0;
  while (todo.length) {
    const { value, depth } = todo.pop();
    if (!value || typeof value !== 'object') continue;
    if (++visited > 300000 || depth > 64) throw fail('模型 JSON 结构过大。');
    if (value.extensions && Object.keys(value.extensions).some(name => !supportedExtensions.has(name))) throw fail('当前查看器只支持基础 glTF、unlit 和 texture_transform；请先导出无压缩 GLB。');
    for (const child of Object.values(value)) todo.push({ value: child, depth: depth + 1 });
  }
  if ([...(json.extensionsRequired || []), ...(json.extensionsUsed || [])].some(name => !supportedExtensions.has(name))) throw fail('模型包含尚未适配的 glTF 扩展。');
  for (const image of json.images || []) if (image.uri !== undefined || !['image/png', 'image/jpeg'].includes(image.mimeType) || !Number.isInteger(image.bufferView)) throw fail('贴图须为 GLB 内嵌 PNG/JPEG，暂不支持外部文件或 URL。');
  return { json, binary: Buffer.from(binary.subarray(0, size)) };
}

export function encodeGlb(json, binary) {
  const bytes = Buffer.from(JSON.stringify(json)), jsonSize = Math.ceil(bytes.length / 4) * 4, binSize = Math.ceil(binary.length / 4) * 4;
  const buffer = Buffer.alloc(12 + 8 + jsonSize + 8 + binSize);
  buffer.writeUInt32LE(0x46546c67, 0); buffer.writeUInt32LE(2, 4); buffer.writeUInt32LE(buffer.length, 8);
  buffer.writeUInt32LE(jsonSize, 12); buffer.writeUInt32LE(JSON_CHUNK, 16); buffer.fill(32, 20, 20 + jsonSize); bytes.copy(buffer, 20);
  buffer.writeUInt32LE(binSize, 20 + jsonSize); buffer.writeUInt32LE(BIN_CHUNK, 24 + jsonSize); binary.copy(buffer, 28 + jsonSize);
  return buffer;
}

function accessorData({ json, binary }, accessorIndex) {
  const accessor = index(accessorIndex, json.accessors, 'Accessor'), format = formats[accessor.componentType], count = counts[accessor.type];
  if (!format || !count || accessor.sparse) throw fail('此编辑操作暂不支持 sparse accessor 或该数据类型。');
  const view = index(accessor.bufferView, json.bufferViews, 'BufferView'), stride = view.byteStride ?? format[0] * count;
  const viewStart = view.byteOffset ?? 0, localStart = accessor.byteOffset ?? 0, viewEnd = viewStart + view.byteLength;
  const start = viewStart + localStart, end = start + (accessor.count - 1) * stride + count * format[0];
  if (![accessor.count, stride, viewStart, localStart, view.byteLength, end].every(Number.isSafeInteger) || accessor.count < 1 || view.buffer !== 0
    || stride < count * format[0] || stride % format[0] || start % format[0] || localStart % format[0] || viewStart < 0 || localStart < 0 || view.byteLength < 1
    || end > viewEnd || viewEnd > binary.length) throw fail('Accessor 超出其 BufferView 或内嵌 buffer。');
  return { accessor, read(row) { if (!Number.isInteger(row) || row < 0 || row >= accessor.count) throw fail('顶点编号超出范围。');
    return Array.from({ length: count }, (_, i) => binary[format[1]](start + row * stride + i * format[0]) / (accessor.normalized ? format[2] : 1)); } };
}

function imageBytes({ json, binary }, imageIndex) {
  const image = index(imageIndex, json.images, '贴图'), view = index(image.bufferView, json.bufferViews, '贴图数据');
  const start = view.byteOffset ?? 0, end = start + view.byteLength;
  if (view.buffer !== 0 || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength <= 0 || end > binary.length) throw fail('贴图超出内嵌数据。');
  return { buffer: Buffer.from(binary.subarray(start, end)), mime: image.mimeType };
}
const extraInfluences = primitive => Object.keys(primitive.attributes || {}).some(key => /^(?:WEIGHTS|JOINTS)_[1-9]\d*$/.test(key));

export async function inspectGlb(buffer) {
  const model = decodeGlb(buffer), { json } = model;
  const report = await validator.validateBytes(new Uint8Array(buffer), { maxIssues: 100, externalResourceFunction: () => Promise.reject(new Error('External resources are disabled.')) });
  // The validator stops checking after reaching maxIssues. Zero errors before
  // truncation cannot certify binary data that it never reached.
  if (report.issues.truncated) throw fail('模型诊断超过 100 条，检查尚未完成；请先清理未使用对象或分拆素材后重试。');
  const issues = report.issues.messages.map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message, pointer: issue.pointer || '' }));
  const repairable = new Set(['ACCESSOR_WEIGHTS_NON_NORMALIZED', 'ACCESSOR_WEIGHTS_NEGATIVE', 'ACCESSOR_WEIGHTS_GREATER_THAN_ONE']);
  if (issues.some(issue => issue.severity === 0 && !repairable.has(issue.code)) || report.issues.truncated && report.issues.numErrors) throw fail('模型结构不能安全读取：' + issues.filter(issue => issue.severity === 0).slice(0, 3).map(issue => issue.message).join(' '));
  for (let imageIndex = 0; imageIndex < (json.images?.length || 0); imageIndex++) {
    const image = imageBytes(model, imageIndex), decoded = await inspectImage(image.buffer);
    if (!['png', 'jpeg'].includes(decoded.format) || image.mime !== (decoded.format === 'png' ? 'image/png' : 'image/jpeg')) throw fail('GLB 内嵌贴图的实际格式与声明不一致。');
  }
  const nodes = json.nodes || [], joints = new Set((json.skins || []).flatMap(skin => skin.joints)), parents = new Map();
  nodes.forEach((node, parent) => (node.children || []).forEach(child => parents.set(child, parent)));
  const summary = {
    format: 'glTF 2.0 GLB', bytes: buffer.length,
    nodes: nodes.map((node, i) => ({ index: i, name: node.name || `Node ${i}`, parent: parents.get(i) ?? null, children: node.children || [], joint: joints.has(i), mesh: node.mesh ?? null, skin: node.skin ?? null,
      translation: node.translation || [0, 0, 0], rotation: node.rotation || [0, 0, 0, 1], scale: node.scale || [1, 1, 1], matrix: Boolean(node.matrix) })),
    meshes: (json.meshes || []).map((mesh, i) => ({ index: i, name: mesh.name || `Mesh ${i}`, instances: nodes.filter(node => node.mesh === i).length,
      primitives: mesh.primitives.map((primitive, p) => ({ index: p, vertices: json.accessors?.[primitive.attributes.POSITION]?.count || 0, material: primitive.material ?? null,
        weightEditable: Number.isInteger(primitive.attributes.WEIGHTS_0) && Number.isInteger(primitive.attributes.JOINTS_0) && !extraInfluences(primitive) && !json.accessors[primitive.attributes.WEIGHTS_0]?.sparse && !json.accessors[primitive.attributes.JOINTS_0]?.sparse })) })),
    skins: (json.skins || []).map((skin, i) => ({ index: i, name: skin.name || `Skin ${i}`, joints: skin.joints, skeleton: skin.skeleton ?? null })),
    materials: (json.materials || []).map((material, i) => ({ index: i, name: material.name || `Material ${i}`, baseColor: material.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1],
      metallic: material.pbrMetallicRoughness?.metallicFactor ?? 1, roughness: material.pbrMetallicRoughness?.roughnessFactor ?? 1,
      textures: Object.fromEntries([['baseColor', material.pbrMetallicRoughness?.baseColorTexture], ['metallicRoughness', material.pbrMetallicRoughness?.metallicRoughnessTexture], ['normal', material.normalTexture], ['occlusion', material.occlusionTexture], ['emissive', material.emissiveTexture]].filter(([, value]) => value).map(([key, value]) => [key, { texture: value.index, image: json.textures?.[value.index]?.source, texCoord: value.texCoord || 0 }])) })),
    images: (json.images || []).map((item, i) => ({ index: i, name: item.name || `Texture ${i}`, mime: item.mimeType, bytes: json.bufferViews[item.bufferView].byteLength })),
    animations: (json.animations || []).map((item, i) => ({ index: i, name: item.name || `Animation ${i}`, channels: item.channels.length })),
    validation: { status: report.issues.numErrors ? 'failed' : 'passed', repairable: report.issues.numErrors > 0 && !report.issues.truncated && issues.every(issue => issue.severity !== 0 || repairable.has(issue.code)), errors: report.issues.numErrors, warnings: report.issues.numWarnings, issues, validatorVersion: validator.version() },
  };
  return summary;
}

export function extractTexture(buffer, imageIndex) {
  return imageBytes(decodeGlb(buffer), imageIndex);
}

export function inspectVertex(buffer, { meshIndex, primitiveIndex, vertexIndex }) {
  const model = decodeGlb(buffer), mesh = index(meshIndex, model.json.meshes, '网格'), primitive = index(primitiveIndex, mesh.primitives, 'Primitive');
  if (extraInfluences(primitive)) throw fail('当前权重编辑只支持每顶点最多四个既有 influence。');
  const joints = accessorData(model, primitive.attributes.JOINTS_0), weights = accessorData(model, primitive.attributes.WEIGHTS_0);
  if (joints.accessor.type !== 'VEC4' || ![5121, 5123].includes(joints.accessor.componentType) || joints.accessor.normalized
    || weights.accessor.type !== 'VEC4' || ![5121, 5123, 5126].includes(weights.accessor.componentType)
    || weights.accessor.componentType !== 5126 && weights.accessor.normalized !== true || weights.accessor.componentType === 5126 && weights.accessor.normalized === true
    || joints.accessor.count !== weights.accessor.count) throw fail('既有 joints/weights accessor 不符合四项 influence 格式。');
  return { meshIndex, primitiveIndex, vertexIndex, joints: joints.read(vertexIndex), weights: weights.read(vertexIndex) };
}

/** Edits append replacement data. Existing texture/geometry/animation bytes remain intact. */
export async function repairGlb(buffer, input) {
  fields(input, [], ['boneEdits', 'weightEdits', 'textureEdits']);
  await inspectGlb(buffer);
  const model = decodeGlb(buffer), { json } = model;
  const boneEdits = input.boneEdits || [], weightEdits = input.weightEdits || [], textureEdits = input.textureEdits || [];
  if (![boneEdits, weightEdits, textureEdits].every(Array.isArray) || !boneEdits.length && !weightEdits.length && !textureEdits.length || boneEdits.length > 64 || weightEdits.length > 256 || textureEdits.length > 16) throw fail('请提供有限的骨骼、顶点或贴图修改。');
  const seen = new Set(), joints = new Set((json.skins || []).flatMap(skin => skin.joints));
  for (const edit of boneEdits) {
    fields(edit, ['nodeIndex'], ['translation', 'rotation', 'scale']); const node = index(edit.nodeIndex, json.nodes, '骨骼');
    if (!joints.has(edit.nodeIndex) || node.matrix || seen.has(edit.nodeIndex)) throw fail('请一次修改一个既有 TRS 骨骼；矩阵节点需先在 DCC 转换。');
    if (Object.keys(edit).length === 1) throw fail('骨骼修改没有局部变换值。'); seen.add(edit.nodeIndex);
    for (const name of ['translation', 'rotation', 'scale']) if (edit[name] !== undefined) {
      const value = vector(edit[name], name === 'rotation' ? 4 : 3, name);
      if (name === 'rotation') { const length = Math.hypot(...value); if (length < 1e-8) throw fail('旋转四元数不能为零。'); node[name] = value.map(v => v / length); }
      else { if (name === 'scale' && value.some(v => Math.abs(v) < 1e-8)) throw fail('缩放不能为零。'); node[name] = value; }
    }
  }
  const append = bytes => {
    const offset = Math.ceil(model.binary.length / 4) * 4;
    model.binary = Buffer.concat([model.binary, Buffer.alloc(offset - model.binary.length), bytes]); json.buffers[0].byteLength = model.binary.length;
    (json.bufferViews ||= []).push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }); return json.bufferViews.length - 1;
  };
  const groups = new Map();
  for (const edit of weightEdits) {
    fields(edit, ['meshIndex', 'primitiveIndex', 'vertexIndex', 'weights']);
    const weights = vector(edit.weights, 4, '权重'); if (weights.some(v => v < 0) || weights.reduce((a, b) => a + b, 0) <= 1e-8) throw fail('权重必须非负且总和大于零。');
    const current = inspectVertex(buffer, edit), mesh = index(edit.meshIndex, json.meshes, '网格'), primitive = index(edit.primitiveIndex, mesh.primitives, 'Primitive');
    const key = `${edit.meshIndex}:${edit.primitiveIndex}`, source = accessorData(decodeGlb(buffer), primitive.attributes.WEIGHTS_0);
    if (source.accessor.type !== 'VEC4' || ![5121, 5123, 5126].includes(source.accessor.componentType)) throw fail('权重必须为 VEC4 的 float 或归一化无符号整数。');
    let group = groups.get(key);
    if (!group) { group = { primitive, source, rows: new Map() }; groups.set(key, group); }
    if (group.rows.has(edit.vertexIndex)) throw fail('同一顶点不能重复修改。');
    // An existing JOINTS_0 entry is the sole influence identity. Never retarget it implicitly.
    const total = weights.reduce((a, b) => a + b, 0); group.rows.set(current.vertexIndex, weights.map(v => v / total));
  }
  for (const { primitive, source, rows } of groups.values()) {
    const bytes = Buffer.alloc(source.accessor.count * 16);
    for (let row = 0; row < source.accessor.count; row++) (rows.get(row) || source.read(row)).forEach((value, column) => bytes.writeFloatLE(value, row * 16 + column * 4));
    const view = append(bytes); json.accessors.push({ bufferView: view, componentType: 5126, count: source.accessor.count, type: 'VEC4' }); primitive.attributes.WEIGHTS_0 = json.accessors.length - 1;
  }
  const imagesSeen = new Set();
  for (const edit of textureEdits) {
    fields(edit, ['imageIndex', 'buffer', 'mime']); const image = index(edit.imageIndex, json.images, '贴图');
    if (imagesSeen.has(edit.imageIndex) || !Buffer.isBuffer(edit.buffer) || !edit.buffer.length || !['image/png', 'image/jpeg'].includes(edit.mime)) throw fail('贴图替换需唯一索引和 PNG/JPEG 内容。');
    imagesSeen.add(edit.imageIndex); image.bufferView = append(edit.buffer); image.mimeType = edit.mime;
  }
  const output = encodeGlb(json, model.binary), summary = await inspectGlb(output);
  if (summary.validation.status !== 'passed') throw fail('候选仍有结构或权重错误，请修复后再生成：' + summary.validation.issues.filter(i => i.severity === 0).map(i => i.message).join(' '));
  return { buffer: output, summary };
}
