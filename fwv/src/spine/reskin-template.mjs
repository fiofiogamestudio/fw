import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { inspectSpine, extractRegion, replaceRegion, parseAtlas, spineError } from './index.mjs';
import { inspectImage, imageMime, MAX_IMAGE_BYTES } from '../image/processor.mjs';

export const RESKIN_SHEET = Object.freeze({ version: 1, width: 1024, height: 1024, maxParts: 16, gutter: 24, minCellSize: 128, visibleAlphaThreshold: 1, lowCoverageRatio: 0.5 });
const warning = (code, message, extra = {}) => ({ severity: 'warning', code, message, ...extra });
const runtimeRoles = new Set(['skeleton', 'atlas', 'texture']);

async function readTemplate(project, { assetId, revisionId }) {
  const snapshot = await project.snapshot();
  const asset = snapshot.assets.find(asset => asset.id === assetId && asset.kind === 'spine');
  if (!asset) throw spineError('ASSET_NOT_FOUND', 'Select a registered Spine asset as the reskin template.');
  const revision = asset.revisions.find(revision => revision.id === (revisionId ?? asset.selectedRevisionId));
  if (!revision) throw spineError('REVISION_NOT_FOUND', 'The selected Spine template revision was not found.');
  const files = [];
  for (const file of revision.files.filter(file => runtimeRoles.has(file.role))) {
    const artifact = await project.readArtifact({ assetId, revisionId: revision.id, fileName: file.name });
    files.push({ name: file.name, role: file.role, mime: file.mime, buffer: artifact.buffer });
  }
  const skeletons = files.filter(file => file.role === 'skeleton' && /\.json$/i.test(file.name));
  const atlases = files.filter(file => file.role === 'atlas' && /\.atlas$/i.test(file.name));
  if (skeletons.length !== 1 || atlases.length !== 1 || files.some(file => file.role === 'texture' && !/\.png$/i.test(file.name))) throw spineError('INVALID_TEMPLATE', 'Template requires one Spine JSON skeleton, one text atlas and PNG textures.');
  const json = skeletons[0];
  const atlas = atlases[0];
  const pages = new Map(files.filter(file => file.role === 'texture').map(file => [file.name, file.buffer]));
  const inspected = await inspectSpine({ json: json.buffer, atlas: atlas.buffer, pages });
  const spine = { ...inspected, jsonFile: json.name, atlasFile: atlas.name };
  if (!spine.supported) throw spineError('INVALID_SPINE_ASSET', spine.issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join(' '), spine.issues);
  const parts = spine.regions.map((region, index) => {
    const attachments = spine.attachments.filter(attachment => attachment.path === region.name && ['region', 'mesh', 'linkedmesh'].includes(attachment.type));
    const usedSlots = new Set(attachments.map(attachment => attachment.slot));
    const slots = spine.slots.filter(slot => usedSlots.has(slot.name));
    return { id: `part_${String(index + 1).padStart(4, '0')}`, regionName: region.name,
      width: region.originalWidth, height: region.originalHeight,
      slotNames: slots.map(slot => slot.name), boneNames: [...new Set(slots.map(slot => slot.bone))],
      attachmentTypes: [...new Set(attachments.map(attachment => attachment.type))],
      drawOrder: spine.slots.map((slot, order) => usedSlots.has(slot.name) ? order : -1).filter(order => order >= 0) };
  });
  const warnings = [...spine.issues.filter(issue => issue.severity === 'warning')];
  const unused = parts.filter(part => !part.slotNames.length);
  if (unused.length) warnings.push(warning('RESKIN_UNUSED_REGIONS', 'Some atlas regions have no mapped rendered attachment; inspect these before selecting them.', { regionNames: unused.map(part => part.regionName) }));
  if (parts.some(part => part.attachmentTypes.some(type => type !== 'region'))) warnings.push(warning('RESKIN_EXISTING_WEIGHTS', 'Mesh attachments keep their existing vertices and weights. Texture replacement does not rebuild the rig.'));
  const report = { assetId: asset.id, revisionId: revision.id, name: asset.name, spine, parts, warnings };
  return { asset, revision, files, json, atlas, pages, report };
}

export async function inspectReskinTemplate(project, options) {
  return (await readTemplate(project, options)).report;
}

function selectedParts(report, regionNames) {
  const names = regionNames ?? report.parts.map(part => part.regionName);
  if (!Array.isArray(names) || !names.length || names.length > RESKIN_SHEET.maxParts || names.some(name => typeof name !== 'string' || !name)) throw spineError('RESKIN_SELECTION_LIMIT', 'Select between 1 and 16 atlas regions per reskin sheet. Larger characters require separate selected batches.');
  if (new Set(names).size !== names.length) throw spineError('DUPLICATE_REGION_SELECTION', 'Each region can appear only once in a reskin sheet.');
  const available = new Set(report.parts.map(part => part.regionName));
  for (const name of names) if (!available.has(name)) throw spineError('REGION_NOT_FOUND', `Template has no atlas region named ${name}.`);
  const selected = new Set(names);
  return report.parts.filter(part => selected.has(part.regionName));
}

function makeLayout(report, regionNames) {
  const parts = selectedParts(report, regionNames);
  const columns = Math.ceil(Math.sqrt(parts.length));
  const rows = Math.ceil(parts.length / columns);
  const cellWidth = Math.floor(RESKIN_SHEET.width / columns);
  const cellHeight = Math.floor(RESKIN_SHEET.height / rows);
  if (Math.min(cellWidth, cellHeight) < RESKIN_SHEET.minCellSize) throw spineError('RESKIN_CELL_LIMIT', 'Reskin cells must be at least 128 pixels in each dimension.');
  return { version: RESKIN_SHEET.version, source: { assetId: report.assetId, revisionId: report.revisionId },
    width: RESKIN_SHEET.width, height: RESKIN_SHEET.height, columns, rows,
    parts: parts.map((part, index) => {
      const cell = { x: index % columns * cellWidth, y: Math.floor(index / columns) * cellHeight, width: cellWidth, height: cellHeight };
      const ratio = Math.min((cell.width - 2 * RESKIN_SHEET.gutter) / part.width, (cell.height - 2 * RESKIN_SHEET.gutter) / part.height);
      const width = Math.max(1, Math.round(part.width * ratio));
      const height = Math.max(1, Math.round(part.height * ratio));
      return { id: part.id, regionName: part.regionName, originalWidth: part.width, originalHeight: part.height, cell,
        content: { x: cell.x + Math.floor((cell.width - width) / 2), y: cell.y + Math.floor((cell.height - height) / 2), width, height } };
    }) };
}

function layoutWarnings(layout) {
  const warnings = [];
  for (const part of layout.parts) {
    if (part.content.width < part.originalWidth || part.content.height < part.originalHeight) warnings.push(warning('RESKIN_DOWNSAMPLED', `Sheet content for ${part.regionName} is smaller than the original attachment; fine details may be lost.`, { regionName: part.regionName }));
    if (Math.min(part.content.width, part.content.height) < 8) warnings.push(warning('RESKIN_THIN_CONTENT', `Sheet content for ${part.regionName} is fewer than eight pixels across its thin dimension. Use a smaller selected batch or edit this part individually.`, { regionName: part.regionName }));
  }
  return warnings;
}

function requireReplaceable(template, layout) {
  const atlas = parseAtlas(template.atlas.buffer);
  for (const part of layout.parts) {
    const region = atlas.regions.find(region => region.name === part.regionName);
    if (region.properties.split || region.properties.pad) throw spineError('UNSUPPORTED_NINEPATCH', `Region ${region.name} is a ninepatch; it cannot be selected for automatic reskin assembly.`);
    for (const other of atlas.regions) {
      if (other === region || other.page !== region.page) continue;
      if (region.x < other.x + other.packedWidth && region.x + region.packedWidth > other.x && region.y < other.y + other.packedHeight && region.y + region.packedHeight > other.y) {
        throw spineError('OVERLAPPING_REGIONS', `Selected region ${region.name} overlaps ${other.name}; split or repack these regions before generating a reskin sheet.`);
      }
    }
  }
}

/** Deterministic reference pixels. Labels belong in the editor, outside this sheet. */
export async function buildReskinSheet(project, { assetId, revisionId, regionNames }) {
  const template = await readTemplate(project, { assetId, revisionId });
  const layout = makeLayout(template.report, regionNames);
  requireReplaceable(template, layout);
  const images = [];
  for (const part of layout.parts) {
    const extracted = await extractRegion({ atlas: template.atlas.buffer, pages: template.pages, regionName: part.regionName });
    const input = await sharp(extracted).resize(part.content.width, part.content.height, { fit: 'fill' }).png().toBuffer();
    images.push({ input, left: part.content.x, top: part.content.y });
  }
  const buffer = await sharp({ create: { width: layout.width, height: layout.height, channels: 4, background: '#00000000' } }).composite(images).png().toBuffer();
  return { buffer, layout, report: { ...template.report, warnings: [...template.report.warnings, ...layoutWarnings(layout)] } };
}

function validateLayout(report, value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.parts)) throw spineError('INVALID_RESKIN_LAYOUT', 'A saved template sheet layout is required.');
  const expected = makeLayout(report, value.parts.map(part => part?.regionName));
  if (!isDeepStrictEqual(value, expected)) throw spineError('INVALID_RESKIN_LAYOUT', 'Sheet layout does not match the selected template revision and its deterministic region cells. Rebuild the reference sheet.');
  return expected;
}

function provenanceValue(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw spineError('INVALID_RESKIN_PROVENANCE', 'Reskin provenance must be a JSON object.');
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw spineError('INVALID_RESKIN_PROVENANCE', 'Reskin provenance must be serializable JSON.'); }
  if (!serialized || Buffer.byteLength(serialized) > 256 * 1024) throw spineError('INVALID_RESKIN_PROVENANCE', 'Reskin provenance exceeds 256 KiB.');
  return JSON.parse(serialized);
}

function visiblePixels(data) {
  let count = 0;
  for (let offset = 3; offset < data.length; offset += 4) if (data[offset] >= RESKIN_SHEET.visibleAlphaThreshold) count++;
  return count;
}

async function cropPart(sheet, template, part, preserveAlpha) {
  const { data, info } = await sharp(sheet, { limitInputPixels: RESKIN_SHEET.width * RESKIN_SHEET.height, failOn: 'error' })
    .extract({ left: part.content.x, top: part.content.y, width: part.content.width, height: part.content.height })
    .resize(part.originalWidth, part.originalHeight, { fit: 'fill' }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const original = await extractRegion({ atlas: template.atlas.buffer, pages: template.pages, regionName: part.regionName });
  const mask = await sharp(original).ensureAlpha().raw().toBuffer();
  const sourceVisiblePixels = visiblePixels(mask);
  const generatedVisiblePixels = visiblePixels(data);
  if (preserveAlpha) for (let offset = 3; offset < data.length; offset += 4) data[offset] = Math.round(data[offset] * mask[offset] / 255);
  return { buffer: await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer(),
    sourceVisiblePixels, generatedVisiblePixels, maskedVisiblePixels: visiblePixels(data) };
}

/** Assemble into a NEW Spine asset. Existing skeleton, weights, animation and UV mapping are reused. */
export async function assembleReskinSheet(project, { assetId, revisionId, buffer, layout: inputLayout, preserveAlpha = true, transforms = {}, name, provenance, idempotencyKey }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES) throw spineError('INPUT_LIMIT', 'Generated sheet must be a nonempty image Buffer of at most 32 MiB.');
  // Capture caller-owned inputs before awaiting project or image I/O.
  const sheet = Buffer.from(buffer);
  let layout;
  try { layout = structuredClone(inputLayout); } catch { throw spineError('INVALID_RESKIN_LAYOUT', 'Sheet layout must be a serializable object.'); }
  const record = provenanceValue(provenance);
  if (typeof preserveAlpha !== 'boolean') throw spineError('INVALID_RESKIN_MASK', 'preserveAlpha must be true or false.');
  if (!transforms || typeof transforms !== 'object' || Array.isArray(transforms)) throw spineError('INVALID_TRANSFORM', 'Part transforms must be keyed by selected region name.');
  let transformInputs;
  try { transformInputs = structuredClone(transforms); } catch { throw spineError('INVALID_TRANSFORM', 'Part transforms must be serializable objects.'); }
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\x00-\x1f]/.test(name))) throw spineError('INVALID_ASSET_NAME', 'Reskin name must contain 1 to 160 readable characters.');
  const template = await readTemplate(project, { assetId, revisionId });
  layout = validateLayout(template.report, layout);
  requireReplaceable(template, layout);
  const selection = new Set(layout.parts.map(part => part.regionName));
  for (const key of Object.keys(transformInputs)) if (!selection.has(key)) throw spineError('INVALID_TRANSFORM', `Transform references unselected region ${key}.`);
  if (template.files.length >= 64) throw spineError('INPUT_LIMIT', 'The new asset requires room for its generated sheet reference within the 64-file revision limit.');
  let image;
  try { image = await inspectImage(sheet); } catch (error) { throw spineError('INVALID_RESKIN_SHEET', `Invalid generated sheet: ${error.message}`); }
  if (image.width !== layout.width || image.height !== layout.height || image.orientation && image.orientation !== 1) throw spineError('INVALID_RESKIN_SHEET', 'Generated sheet must be exactly 1024 by 1024 pixels without EXIF rotation.');
  let pages = new Map(template.pages);
  const warnings = [...template.report.warnings, ...layoutWarnings(layout)];
  warnings.push(warning(preserveAlpha ? 'RESKIN_SOURCE_SILHOUETTE' : 'RESKIN_UNMASKED', preserveAlpha
    ? 'Generated alpha is multiplied by the original attachment mask before transforms. This preserves the template outline; new limbs or a larger silhouette require separate authoring.'
    : 'Original alpha masking is disabled. Opaque backgrounds or changed silhouettes require visual review.'));
  const appliedTransforms = Object.create(null);
  const partChecks = [];
  for (const part of layout.parts) {
    const cropped = await cropPart(sheet, template, part, preserveAlpha);
    const result = await replaceRegion({ atlas: template.atlas.buffer, pages, regionName: part.regionName, buffer: cropped.buffer,
      transform: Object.hasOwn(transformInputs, part.regionName) ? transformInputs[part.regionName] : {} });
    pages = result.pages;
    appliedTransforms[part.regionName] = result.transform;
    warnings.push(...result.warnings);
    const output = await extractRegion({ atlas: template.atlas.buffer, pages, regionName: part.regionName });
    const outputVisiblePixels = visiblePixels(await sharp(output).ensureAlpha().raw().toBuffer());
    const check = { regionName: part.regionName, sourceVisiblePixels: cropped.sourceVisiblePixels,
      generatedVisiblePixels: cropped.generatedVisiblePixels, maskedVisiblePixels: cropped.maskedVisiblePixels,
      outputVisiblePixels, coverageRatio: cropped.sourceVisiblePixels ? outputVisiblePixels / cropped.sourceVisiblePixels : null,
      visibleAlphaThreshold: RESKIN_SHEET.visibleAlphaThreshold, scope: 'technical-alpha-coverage', visualAcceptance: 'not-reviewed' };
    partChecks.push(check);
    if (check.sourceVisiblePixels > 0 && check.outputVisiblePixels === 0) throw spineError('RESKIN_EMPTY_PART', `Selected part ${part.regionName} has no visible pixels after sheet cropping, masking and transforms. Check the generated cell alignment before assembling.`, [{ severity: 'error', code: 'RESKIN_EMPTY_PART', ...check }]);
    if (check.coverageRatio !== null && check.coverageRatio < RESKIN_SHEET.lowCoverageRatio) warnings.push(warning('RESKIN_LOW_COVERAGE', `Part ${part.regionName} retains less than half the template's visible pixel count. Inspect missing sections and generated cell alignment.`, check));
    if (!check.sourceVisiblePixels) warnings.push(warning('RESKIN_EMPTY_SOURCE', `Template region ${part.regionName} has no visible pixels; source masking cannot create a new silhouette.`, check));
  }
  const report = await inspectSpine({ json: template.json.buffer, atlas: template.atlas.buffer, pages });
  if (!report.supported) throw spineError('INVALID_SPINE_ASSET', 'Assembled textures failed Spine structure validation.', report.issues);
  const files = template.files.map(file => ({ ...file, buffer: file.role === 'texture' ? pages.get(file.name) : file.buffer }));
  const sheetSha256 = createHash('sha256').update(sheet).digest('hex');
  let generatedSheetFile = `reskin-sheet-${sheetSha256.slice(0, 16)}.${image.format === 'jpeg' ? 'jpg' : image.format}`;
  while (files.some(file => file.name.toLowerCase() === generatedSheetFile.toLowerCase())) generatedSheetFile = `_${generatedSheetFile}`;
  files.push({ name: generatedSheetFile, role: 'reference', mime: imageMime(image.format), buffer: sheet });
  const reskin = { source: layout.source, layout, preserveAlpha, transforms: appliedTransforms, generatedSheetFile, sheetSha256, provenance: record, partChecks };
  return project.importAsset({ name: name?.trim() ?? `${template.asset.name.slice(0, 150)} · 换皮`, kind: 'spine', files, idempotencyKey,
    metadata: { spine: { ...report, jsonFile: template.json.name, atlasFile: template.atlas.name, issues: [...report.issues, ...warnings] }, reskin },
    recipe: { operation: 'spine.reskin-sheet', version: 1, ...reskin } });
}
