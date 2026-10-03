import { FwvProject } from '../core/project.mjs';
import { readAuthoring, writeAuthoring } from './authoring.mjs';
import { isGalleryImage } from './gallery2d-api.mjs';

export const CATALOG_FILE = 'catalog.json';
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'FWV_CATALOG_INVALID' });
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
function keys(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(`${label} 包含未知字段或不是对象。`);
}
async function checkedProject(options) {
  const project = new FwvProject(options.projectRoot), snapshot = await project._load();
  if (typeof options.expectedProjectId !== 'string' || snapshot.id !== options.expectedProjectId) throw fail('项目身份发生变化，请重启工作台。', 409);
  return { project, snapshot };
}

// IDs are opaque to clients. Registered filenames cannot contain path separators.
export const imageRowId = (assetId, revisionId, file) => `${assetId}/${revisionId}/${file}`;
export function imagePreviewUrl(assetId, revisionId, file, thumbnail = true) {
  const query = new URLSearchParams({ assetId, revisionId, file });
  if (thumbnail) query.set('thumbnail', '1');
  return `/api/fwv/image?${query}`;
}
export function skeletonPreviewUrl(assetId, revisionId) {
  return `/api/fwv/skeleton2d-thumbnail?${new URLSearchParams({ assetId, revisionId })}`;
}

// Only established state suffixes are inferred; arbitrary __names remain independent art.
const imageVariantStates = ['flash', 'stone', 'frozen', 'poor', 'unavailable', 'visited'];
const imageVariantPattern = new RegExp(`^(.+)__(${imageVariantStates.join('|')})(\\.[^.]+)$`);
const independentImageRoles = new Set(['source', 'preview', 'reference']);
function groupedRevisionImages(revision) {
  const files = revision.files.filter(isGalleryImage), byName = new Map(files.map(file => [file.name, file]));
  const candidates = new Map(), groups = new Map(), grouped = new Set();
  for (const file of files) {
    const match = imageVariantPattern.exec(file.name);
    if (!match || independentImageRoles.has(file.role)) continue;
    const baseName = `${match[1]}${match[3]}`;
    if (byName.has(baseName)) candidates.set(file.name, { baseName, state: match[2], file });
  }
  for (const [name, variant] of candidates) {
    // Do not hide a second-level suffix underneath another hidden variant.
    if (candidates.has(variant.baseName)) continue;
    if (!groups.has(variant.baseName)) groups.set(variant.baseName, []);
    groups.get(variant.baseName).push(variant); grouped.add(name);
  }
  return files.filter(file => !grouped.has(file.name)).map(file => ({ file,
    variants: [{ file, state: 'base' }, ...(groups.get(file.name) || []).sort((a, b) => imageVariantStates.indexOf(a.state) - imageVariantStates.indexOf(b.state))] }));
}
function projectImageVariant(assetId, revisionId, { file, state }) {
  return { state, file: file.name, name: file.name, mime: file.mime.toLowerCase(), bytes: file.bytes,
    thumbnailUrl: imagePreviewUrl(assetId, revisionId, file.name), reference: { assetId, revisionId, file: file.name } };
}

/** Metadata-only projection: keep originals and their state variants in one revision-local row. */
export function projectCatalog(snapshot) {
  const images = [], assets = new Map(), kinds = new Set(), versions = new Set();
  for (const asset of snapshot.assets) for (const [index, revision] of asset.revisions.entries()) {
    const version = `v${index + 1}`;
    for (const group of groupedRevisionImages(revision)) {
      const file = group.file, variants = group.variants.map(variant => projectImageVariant(asset.id, revision.id, variant));
      const variantCount = variants.length - 1;
      assets.set(asset.id, asset.name); kinds.add(asset.kind); versions.add(version);
      images.push({ id: imageRowId(asset.id, revision.id, file.name), assetId: asset.id, revisionId: revision.id,
        file: file.name, name: file.name, assetName: asset.name, kind: asset.kind, mime: file.mime.toLowerCase(), bytes: file.bytes,
        version, current: revision.id === asset.selectedRevisionId ? 'current' : 'historical',
        thumbnailUrl: imagePreviewUrl(asset.id, revision.id, file.name), reference: { assetId: asset.id, revisionId: revision.id, file: file.name },
        variants, variantCount, variantSummary: variantCount ? `原图 + ${variantCount} 种状态` : '原图', variantNames: variants.map(variant => variant.name).join(' ') });
    }
  }
  return { schemaVersion: 1, projectId: snapshot.id, images,
    assetOptions: [...assets].map(([id, name]) => ({ id, name })),
    kindOptions: [...kinds].sort().map(id => ({ id, name: id })),
    versionOptions: [...versions].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map(id => ({ id, name: id })) };
}
export async function readCatalog(options) {
  const { snapshot } = await checkedProject(options);
  return { name: CATALOG_FILE, type: 'json', exists: true, data: projectCatalog(snapshot) };
}
export async function listCatalog(options) {
  await checkedProject(options);
  return [{ name: CATALOG_FILE, label: '2D 美术素材', exists: true }];
}

function skeletonRevision(project, snapshot, row) {
  if (!plain(row) || typeof row.id !== 'string' || !plain(row.data) || row.data.assetId !== row.id || typeof row.data.revisionId !== 'string') throw fail('骨骼行必须引用其自身资源和明确版本。');
  const asset = project._asset(snapshot, row.id);
  if (asset.kind !== 'skeleton2d') throw fail('骨骼行只能引用已登记的 skeleton2d 资源。');
  return { asset, revision: project._revision(asset, row.data.revisionId) };
}
function skeletonRow(project, snapshot, asset, data) {
  const row = { id: asset.id, data }, { revision } = skeletonRevision(project, snapshot, row);
  const textures = revision.files.filter(isGalleryImage);
  return { id: asset.id, name: asset.name, revisionLabel: `v${asset.revisions.findIndex(item => item.id === revision.id) + 1}`,
    textureCount: textures.length, thumbnailUrl: skeletonPreviewUrl(asset.id, revision.id), data };
}

/** FWE owns editable data; catalogue fields and unedited placeholders are derived. */
export async function readProjectedAuthoring(options) {
  const { project, snapshot } = await checkedProject(options), resource = await readAuthoring(options);
  const saved = new Map(resource.data.skeleton2dDrafts.map(row => {
    skeletonRevision(project, snapshot, row); return [row.id, row.data];
  }));
  return { ...resource, data: { ...resource.data, skeleton2dDrafts: snapshot.assets.filter(asset => asset.kind === 'skeleton2d').map(asset =>
    skeletonRow(project, snapshot, asset, saved.get(asset.id) || { assetId: asset.id, revisionId: asset.selectedRevisionId })) } };
}
export async function writeProjectedAuthoring({ payload, ...options }) {
  keys(payload, ['data', 'revision', 'createOnly'], '保存参数');
  keys(payload.data, ['schemaVersion', 'projectId', 'skeleton2dDrafts'], '参数草稿');
  if (!Array.isArray(payload.data.skeleton2dDrafts)) throw fail('骨骼集合必须是数组。');
  const { project, snapshot } = await checkedProject(options), seen = new Set();
  const rows = payload.data.skeleton2dDrafts.map(row => {
    keys(row, ['id', 'name', 'revisionLabel', 'textureCount', 'thumbnailUrl', 'data'], '骨骼行');
    skeletonRevision(project, snapshot, row);
    if (seen.has(row.id)) throw fail('骨骼资源行不能重复。'); seen.add(row.id);
    return { id: row.id, data: row.data };
  }).filter(row => Object.keys(row.data).some(key => !['assetId', 'revisionId'].includes(key)));
  return writeAuthoring({ ...options, payload: { ...payload, data: { ...payload.data, skeleton2dDrafts: rows } } });
}
