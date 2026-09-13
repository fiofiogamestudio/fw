import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { inspectImage, imageMime } from '../image/processor.mjs';
import { inspectSpine } from '../spine/index.mjs';
import { RIG_LIMITS, RIG_ROLES, rigError, validateParts, validateMotion, cutParts } from './geometry.mjs';
export { RIG_LIMITS, RIG_ROLES } from './geometry.mjs';

const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const warn = (code, message, extra = {}) => ({ severity: 'warning', code, message, ...extra });
const selected = asset => ({ asset, revision: asset.revisions.find(revision => revision.id === asset.selectedRevisionId) });
const decoder = buffer => sharp(buffer, { limitInputPixels: RIG_LIMITS.sourcePixels, failOn: 'error' });

async function sourceImage(buffer) {
  const image = await inspectImage(buffer);
  if (image.orientation && image.orientation !== 1) throw rigError('RIG_SOURCE_ORIENTATION', 'Source images with EXIF rotation must be normalized in the image workbench first.');
  if (!image.alpha.bounds) throw rigError('RIG_EMPTY_SOURCE', 'Rig source image has no visible pixels.');
  if (image.width * image.height > RIG_LIMITS.sourcePixels) throw rigError('RIG_PIXEL_LIMIT', 'Rig source exceeds 16 megapixels.');
  const { data } = await decoder(buffer).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { image, data };
}
function presetParts(bounds) {
  const point = (x, y) => ({ x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y });
  const rectangle = (left, top, right, bottom) => [point(left, top), point(right, top), point(right, bottom), point(left, bottom)];
  return [
    { id: 'arm-left', name: '左臂', role: 'arm-left', parentId: 'torso', polygon: rectangle(0, .28, .30, .72), pivot: point(.27, .32) },
    { id: 'leg-left', name: '左腿', role: 'leg-left', parentId: 'torso', polygon: rectangle(.23, .62, .50, 1), pivot: point(.40, .65) },
    { id: 'leg-right', name: '右腿', role: 'leg-right', parentId: 'torso', polygon: rectangle(.50, .62, .77, 1), pivot: point(.60, .65) },
    { id: 'torso', name: '躯干', role: 'torso', parentId: null, polygon: rectangle(.25, .27, .75, .68), pivot: point(.50, .64) },
    { id: 'head', name: '头部', role: 'head', parentId: 'torso', polygon: rectangle(.20, 0, .80, .32), pivot: point(.50, .29) },
    { id: 'arm-right', name: '右臂', role: 'arm-right', parentId: 'torso', polygon: rectangle(.70, .28, 1, .72), pivot: point(.73, .32) },
  ];
}
function analysisWarnings(analysis, preset) {
  const warnings = [warn('RIG_MANUAL_SEGMENTATION', preset === 'humanoid6' ? 'Six-part regions are proportional guides based on alpha bounds, not AI segmentation. Correct polygons, pivots, hierarchy and draw order before building.' : 'Part masks and pivots are manually authored; hidden anatomy is not reconstructed.')];
  if (analysis.overlappingPixels) warnings.push(warn('RIG_OVERLAPPING_PARTS', 'Visible source pixels occur in multiple parts. They may double-composite or reveal seams while moving.', { pixels: analysis.overlappingPixels }));
  if (analysis.uncoveredPixels) warnings.push(warn('RIG_MISSING_COVERAGE', 'Some visible source pixels are outside every part mask.', { pixels: analysis.uncoveredPixels, ratio: analysis.uncoveredPixels / analysis.sourceVisiblePixels }));
  for (const cutout of analysis.cutouts) if (!cutout.visiblePixels) warnings.push(warn('RIG_EMPTY_PART', `Part ${cutout.part.name} contains no visible source pixels. Adjust its polygon before building.`, { partId: cutout.part.id }));
  warnings.push(warn('RIG_RULE_MOTION', 'Generated motion uses fixed rotation and translation rules. It does not add hidden pixels, mesh weights, inverse kinematics or physical constraints.'));
  return warnings;
}
function partChecks(analysis) {
  return analysis.cutouts.map(cutout => ({ id: cutout.part.id, name: cutout.part.name, regionName: `part_${cutout.part.id}`, boneName: `part_${cutout.part.id}`, bounds: cutout.bounds, visiblePixels: cutout.visiblePixels, alphaThreshold: 1, maskSampling: 'pixel-center', visualAcceptance: 'not-reviewed' }));
}
function draftFiles(document, buffer, mime) {
  return [{ name: 'rig.json', role: 'reference', mime: 'application/json', buffer: jsonBytes(document) },
    { name: document.source.referenceFile, role: 'reference', mime, buffer }];
}

export async function createRigDraft(project, { sourceAssetId, sourceRevisionId, name, preset = 'humanoid6' }) {
  if (preset !== 'humanoid6') throw rigError('INVALID_RIG_PRESET', 'Only the editable humanoid6 guide preset is supported.');
  const snapshot = await project.snapshot();
  const sourceAsset = snapshot.assets.find(asset => asset.id === sourceAssetId && asset.kind === 'image');
  const sourceRevision = sourceAsset?.revisions.find(revision => revision.id === (sourceRevisionId ?? sourceAsset.selectedRevisionId));
  const file = sourceRevision?.files.find(file => file.role === 'image') ?? sourceRevision?.files.find(file => file.role === 'source');
  if (!sourceAsset || !sourceRevision || !file) throw rigError('RIG_SOURCE_NOT_FOUND', 'Select a registered image asset and revision as the rig source.');
  const artifact = await project.readArtifact({ assetId: sourceAsset.id, revisionId: sourceRevision.id, fileName: file.name });
  const { image, data } = await sourceImage(artifact.buffer);
  const parts = validateParts(presetParts(image.alpha.bounds), image.width, image.height);
  const analysis = cutParts(data, image.width, image.height, parts);
  const stamp = new Date().toISOString();
  const document = { schemaVersion: 1, preset, source: { assetId: sourceAsset.id, revisionId: sourceRevision.id, fileName: file.name,
    width: image.width, height: image.height, referenceFile: `rig-source.${image.format === 'jpeg' ? 'jpg' : image.format}`, sha256: hash(artifact.buffer) },
    parts, motion: { idle: true, walk: true, wave: true }, warnings: analysisWarnings(analysis, preset), partChecks: partChecks(analysis), createdAt: stamp, updatedAt: stamp };
  const asset = await project.importAsset({ name: name ?? `${sourceAsset.name.slice(0, 145)} · 拆件骨骼`, kind: 'rig',
    files: draftFiles(document, artifact.buffer, imageMime(image.format)), metadata: { rig: document }, recipe: { operation: 'rig.draft', version: 1, source: document.source, preset } });
  return selected(asset);
}

export async function loadRigDraft(project, { assetId, revisionId }) {
  const snapshot = await project.snapshot();
  const asset = snapshot.assets.find(asset => asset.id === assetId && asset.kind === 'rig');
  const revision = asset?.revisions.find(revision => revision.id === (revisionId ?? asset.selectedRevisionId));
  if (!asset || !revision) throw rigError('RIG_DRAFT_NOT_FOUND', 'Registered rig draft revision was not found.');
  const file = revision.files.find(file => file.name === 'rig.json' && file.role === 'reference');
  if (!file) throw rigError('INVALID_RIG_DOCUMENT', 'Rig draft is missing its reference rig.json document.');
  let document;
  try { document = JSON.parse((await project.readArtifact({ assetId, revisionId: revision.id, fileName: file.name })).buffer.toString('utf8')); }
  catch (error) { throw rigError('INVALID_RIG_DOCUMENT', `Cannot read rig document: ${error.message}`); }
  if (!document || document.schemaVersion !== 1 || !isDeepStrictEqual(document, revision.metadata.rig)) throw rigError('RIG_DOCUMENT_MISMATCH', 'Rig document and revision metadata do not match.');
  if (!document.source || typeof document.source.referenceFile !== 'string' || !Number.isInteger(document.source.width) || !Number.isInteger(document.source.height) || document.source.width < 1 || document.source.height < 1 || document.source.width > RIG_LIMITS.dimension || document.source.height > RIG_LIMITS.dimension || document.source.width * document.source.height > RIG_LIMITS.sourcePixels) throw rigError('INVALID_RIG_DOCUMENT', 'Rig source dimensions or reference are invalid.');
  validateParts(document.parts, document.source.width, document.source.height); validateMotion(document.motion);
  const reference = revision.files.find(file => file.name === document.source.referenceFile && file.role === 'reference');
  if (!reference) throw rigError('INVALID_RIG_DOCUMENT', 'Rig source reference is not registered in this revision.');
  const source = await project.readArtifact({ assetId, revisionId: revision.id, fileName: reference.name });
  if (hash(source.buffer) !== document.source.sha256) throw rigError('RIG_SOURCE_HASH_MISMATCH', 'Rig source reference does not match its recorded hash.');
  const { image } = await sourceImage(source.buffer);
  if (image.width !== document.source.width || image.height !== document.source.height) throw rigError('RIG_SOURCE_DIMENSION_MISMATCH', 'Rig source dimensions do not match the source image.');
  return { asset, revision, document };
}

async function loadWithPixels(project, options) {
  const loaded = await loadRigDraft(project, options);
  const reference = await project.readArtifact({ assetId: loaded.asset.id, revisionId: loaded.revision.id, fileName: loaded.document.source.referenceFile });
  const { data, image } = await sourceImage(reference.buffer);
  return { ...loaded, buffer: reference.buffer, data, image };
}

export async function forkRigDraft(project, { assetId, revisionId, name, parts, motion }) {
  // A fork reads an immutable revision and never changes the source asset's selection.
  const loaded = await loadWithPixels(project, { assetId, revisionId });
  const normalizedParts = validateParts(structuredClone(parts === undefined ? loaded.document.parts : parts), loaded.image.width, loaded.image.height);
  const normalizedMotion = validateMotion(structuredClone(motion === undefined ? loaded.document.motion : motion));
  const analysis = cutParts(loaded.data, loaded.image.width, loaded.image.height, normalizedParts);
  const forkedFrom = { assetId: loaded.asset.id, revisionId: loaded.revision.id };
  const stamp = new Date().toISOString();
  const document = { ...loaded.document, forkedFrom, parts: normalizedParts, motion: normalizedMotion,
    warnings: analysisWarnings(analysis, loaded.document.preset), partChecks: partChecks(analysis), createdAt: stamp, updatedAt: stamp };
  const asset = await project.importAsset({ name: name ?? `${loaded.asset.name.slice(0, 140)} · 副本`, kind: 'rig',
    files: draftFiles(document, loaded.buffer, imageMime(loaded.image.format)), metadata: { rig: document },
    recipe: { operation: 'rig.fork', version: 1, source: document.source, forkedFrom } });
  return selected(asset);
}

export async function saveRigDraft(project, { assetId, revisionId, parts, motion }) {
  let savedParts, savedMotion;
  try { savedParts = structuredClone(parts); savedMotion = structuredClone(motion); } catch { throw rigError('INVALID_RIG_DOCUMENT', 'Rig edits must be serializable data.'); }
  const loaded = await loadWithPixels(project, { assetId, revisionId });
  if (loaded.asset.selectedRevisionId !== loaded.revision.id) throw rigError('RIG_REVISION_CONFLICT', 'Rig draft changed; reload its current revision before saving.', { status: 409 });
  const normalizedParts = validateParts(savedParts, loaded.image.width, loaded.image.height), normalizedMotion = validateMotion(savedMotion);
  const analysis = cutParts(loaded.data, loaded.image.width, loaded.image.height, normalizedParts);
  const document = { ...loaded.document, parts: normalizedParts, motion: normalizedMotion, warnings: analysisWarnings(analysis, loaded.document.preset), partChecks: partChecks(analysis), updatedAt: new Date().toISOString() };
  const asset = await project.addRevision({ assetId, parentRevisionId: loaded.revision.id, expectedSelectedRevisionId: loaded.revision.id,
    files: draftFiles(document, loaded.buffer, imageMime(loaded.image.format)), metadata: { rig: document }, recipe: { operation: 'rig.edit', version: 1, source: document.source } });
  return selected(asset);
}

function packing(cutouts) {
  const padding = RIG_LIMITS.padding;
  const maxWidth = Math.max(...cutouts.map(cutout => cutout.bounds.width + 2 * padding));
  const maxHeight = Math.max(...cutouts.map(cutout => cutout.bounds.height + 2 * padding));
  const total = cutouts.reduce((sum, cutout) => sum + (cutout.bounds.width + 2 * padding) * (cutout.bounds.height + 2 * padding), 0);
  let width = Math.min(RIG_LIMITS.dimension, Math.max(maxWidth, Math.ceil(Math.sqrt(total))));
  width = Math.min(width, Math.floor(RIG_LIMITS.pagePixels / maxHeight));
  const height = Math.min(RIG_LIMITS.dimension, Math.floor(RIG_LIMITS.pagePixels / width));
  if (width < maxWidth || height < maxHeight || maxWidth > RIG_LIMITS.dimension || maxHeight > RIG_LIMITS.dimension) throw rigError('RIG_ATLAS_LIMIT', 'A part exceeds the atlas page budget including padding. Resize the source or reduce polygon bounds.');
  const pages = []; let page, x, y, rowHeight;
  function nextPage() { page = { name: `rig-page-${String(pages.length + 1).padStart(2, '0')}.png`, width: 0, height: 0, regions: [] }; pages.push(page); x = padding; y = padding; rowHeight = 0; }
  nextPage();
  for (const cutout of cutouts) {
    if (x + cutout.bounds.width + padding > width) { x = padding; y += rowHeight + 2 * padding; rowHeight = 0; }
    if (y + cutout.bounds.height + padding > height) nextPage();
    const region = { cutout, x, y, width: cutout.bounds.width, height: cutout.bounds.height };
    page.regions.push(region); page.width = Math.max(page.width, x + region.width + padding); page.height = Math.max(page.height, y + region.height + padding);
    x += region.width + 2 * padding; rowHeight = Math.max(rowHeight, region.height);
  }
  if (pages.reduce((sum, page) => sum + page.width * page.height, 0) > RIG_LIMITS.atlasPixels) throw rigError('RIG_ATLAS_LIMIT', 'Combined atlas page allocation exceeds 32 megapixels. Reduce cutout bounds.');
  return pages;
}

function skeletonJson(document, cutouts) {
  const byId = new Map(document.parts.map(part => [part.id, part])), ordered = [], visited = new Set();
  function append(part) { if (visited.has(part.id)) return; if (part.parentId) append(byId.get(part.parentId)); visited.add(part.id); ordered.push(part); }
  for (const part of document.parts) append(part);
  const name = part => `part_${part.id}`;
  const bones = [{ name: 'root' }, ...ordered.map(part => {
    const parent = part.parentId ? byId.get(part.parentId) : null;
    return { name: name(part), parent: parent ? name(parent) : 'root', x: part.pivot.x - (parent ? parent.pivot.x : document.source.width / 2), y: (parent ? parent.pivot.y : document.source.height) - part.pivot.y };
  })];
  const attachments = {};
  for (const cutout of cutouts) {
    const part = cutout.part, box = cutout.bounds, regionName = name(part);
    attachments[`slot_${part.id}`] = { [regionName]: { type: 'region', path: regionName, x: box.x + box.width / 2 - part.pivot.x, y: part.pivot.y - box.y - box.height / 2, width: box.width, height: box.height } };
  }
  const animations = {};
  if (document.motion.idle) animations.idle = { bones: { root: { translate: [{ time: 0, y: 0 }, { time: 1, y: document.source.height * .012 }, { time: 2, y: 0 }] } } };
  if (document.motion.walk) {
    const animated = { root: { translate: [{ time: 0, y: 0 }, { time: .25, y: document.source.height * .008 }, { time: .5, y: 0 }, { time: .75, y: document.source.height * .008 }, { time: 1, y: 0 }] } };
    for (const part of document.parts) {
      const magnitude = { 'leg-left': 18, 'leg-right': -18, 'arm-left': -10, 'arm-right': 10 }[part.role];
      if (magnitude) animated[name(part)] = { rotate: [{ time: 0, value: 0 }, { time: .25, value: magnitude }, { time: .5, value: 0 }, { time: .75, value: -magnitude }, { time: 1, value: 0 }] };
    }
    animations.walk = { bones: animated };
  }
  if (document.motion.wave) {
    const animated = {};
    for (const part of document.parts.filter(part => part.role === 'arm-right')) animated[name(part)] = { rotate: [{ time: 0, value: 0 }, { time: .35, value: 60 }, { time: .65, value: 40 }, { time: .95, value: 60 }, { time: 1.3, value: 0 }] };
    // A missing right arm is diagnosed rather than fabricating a different gesture.
    if (Object.keys(animated).length) animations.wave = { bones: animated };
  }
  return { skeleton: { spine: '4.2.120', x: -document.source.width / 2, y: 0, width: document.source.width, height: document.source.height, images: './' },
    bones, slots: document.parts.map(part => ({ name: `slot_${part.id}`, bone: name(part), attachment: name(part) })), skins: [{ name: 'default', attachments }], animations };
}

export async function buildRigCandidate(project, { assetId, revisionId }) {
  const loaded = await loadWithPixels(project, { assetId, revisionId });
  const analysis = cutParts(loaded.data, loaded.image.width, loaded.image.height, loaded.document.parts);
  const empty = analysis.cutouts.find(cutout => !cutout.visiblePixels);
  if (empty) throw rigError('RIG_EMPTY_PART', `Part ${empty.part.name} contains no visible pixels; correct its polygon before building.`);
  const pages = packing(analysis.cutouts), buffers = new Map();
  const atlasSections = [];
  for (const page of pages) {
    const pixels = Buffer.alloc(page.width * page.height * 4);
    const lines = [page.name, `size:${page.width},${page.height}`, 'filter:Linear,Linear', 'pma:false'];
    for (const region of page.regions) {
      for (let row = 0; row < region.height; row++) region.cutout.data.copy(pixels, ((region.y + row) * page.width + region.x) * 4, row * region.width * 4, (row + 1) * region.width * 4);
      lines.push(`part_${region.cutout.part.id}`, `bounds:${region.x},${region.y},${region.width},${region.height}`);
    }
    buffers.set(page.name, await sharp(pixels, { raw: { width: page.width, height: page.height, channels: 4 } }).png().toBuffer());
    atlasSections.push(lines.join('\n'));
  }
  const json = jsonBytes(skeletonJson(loaded.document, analysis.cutouts)), atlas = Buffer.from(atlasSections.join('\n\n') + '\n');
  const spine = await inspectSpine({ json, atlas, pages: buffers });
  if (!spine.supported) throw rigError('INVALID_RIG_SPINE', 'Built skeleton failed Spine structure validation.', { issues: spine.issues });
  const warnings = analysisWarnings(analysis, loaded.document.preset);
  if (loaded.document.motion.wave && !loaded.document.parts.some(part => part.role === 'arm-right')) warnings.push(warn('RIG_WAVE_UNAVAILABLE', 'Wave was requested but no arm-right part exists; no wave animation was generated.'));
  const draft = { assetId: loaded.asset.id, revisionId: loaded.revision.id };
  const candidateDocument = { ...loaded.document, draft, warnings, partChecks: partChecks(analysis), builtAt: new Date().toISOString() };
  const files = [{ name: 'character.json', role: 'skeleton', mime: 'application/json', buffer: json }, { name: 'character.atlas', role: 'atlas', mime: 'text/plain', buffer: atlas },
    ...[...buffers].map(([name, buffer]) => ({ name, role: 'texture', mime: 'image/png', buffer })), ...draftFiles(candidateDocument, loaded.buffer, imageMime(loaded.image.format))];
  const asset = await project.importAsset({ name: `${loaded.asset.name.slice(0, 145)} · 动画候选`, kind: 'spine', files,
    metadata: { spine: { ...spine, jsonFile: 'character.json', atlasFile: 'character.atlas', issues: [...spine.issues, ...warnings] }, rig: candidateDocument,
      rigBuild: { draft, partChecks: candidateDocument.partChecks, atlasPages: pages.map(page => ({ name: page.name, width: page.width, height: page.height })), worldOrigin: 'source-bottom-center' } },
    recipe: { operation: 'rig.build', version: 1, draft, source: loaded.document.source, parts: loaded.document.parts, motion: loaded.document.motion, maskSampling: 'pixel-center', alphaThreshold: 1 } });
  return selected(asset);
}
