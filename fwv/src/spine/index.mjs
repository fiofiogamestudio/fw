import sharp from 'sharp';
import { parseAtlas, normalizePages, findRegion, SPINE_LIMITS, spineError } from './atlas.mjs';
export { parseAtlas, SPINE_LIMITS, spineError } from './atlas.mjs';

const imageOptions = { limitInputPixels: SPINE_LIMITS.pixels, failOn: 'warning' };
const issue = (severity, code, message, context = {}) => ({ severity, code, message, ...context });

function parseSkeleton(input) {
  if (Buffer.isBuffer(input) || typeof input === 'string') {
    if (Buffer.byteLength(input) > SPINE_LIMITS.jsonBytes) throw spineError('INPUT_LIMIT', 'Spine JSON exceeds 16 MiB.');
    try {
      const result = JSON.parse(input.toString().replace(/^\uFEFF/, ''));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected object');
      return result;
    }
    catch { throw spineError('INVALID_JSON', 'Skeleton must be valid Spine JSON; binary SKEL is not supported.'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw spineError('INVALID_JSON', 'Skeleton must be a JSON object.');
  return input;
}

async function readPage(buffer, name) {
  const meta = await sharp(buffer, imageOptions).metadata();
  if (meta.format !== 'png' || (meta.pages ?? 1) !== 1) throw spineError('UNSUPPORTED_PAGE', `Atlas page ${name} must be a single PNG image.`);
  if (meta.depth !== 'uchar') throw spineError('UNSUPPORTED_PAGE_DEPTH', `Atlas page ${name} must use 8-bit color channels.`);
  if (!meta.width || !meta.height || meta.width > SPINE_LIMITS.dimension || meta.height > SPINE_LIMITS.dimension || meta.width * meta.height > SPINE_LIMITS.pixels) throw spineError('INPUT_LIMIT', `Atlas page ${name} is too large.`);
  return meta;
}

function rectanglesOverlap(a, b, padding = 0) {
  return a.x - padding < b.x + b.packedWidth && a.x + a.packedWidth + padding > b.x && a.y - padding < b.y + b.packedHeight && a.y + a.packedHeight + padding > b.y;
}

export async function inspectSpine({ json, atlas: atlasInput, pages: pageInput }) {
  const skeleton = parseSkeleton(json);
  const atlas = parseAtlas(atlasInput);
  const pageBuffers = normalizePages(pageInput);
  const issues = [];
  if ((skeleton.physics ?? []).length) issues.push(issue('error', 'UNSUPPORTED_PHYSICS', 'Spine physics constraints are not supported by the initial deterministic preview workflow.'));
  if (new Set(atlas.pages.map(page => page.pma)).size > 1) issues.push(issue('error', 'MIXED_PMA', 'Atlas pages must use the same premultiplied alpha setting for the preview workflow.'));
  const version = skeleton.skeleton?.spine ?? null;
  if (typeof version !== 'string' || !/^4\.2(?:\.|$)/.test(version)) issues.push(issue('error', 'UNSUPPORTED_VERSION', 'Only Spine 4.2 JSON is supported.', { version }));
  const bones = Array.isArray(skeleton.bones) ? skeleton.bones : [];
  const slots = Array.isArray(skeleton.slots) ? skeleton.slots : [];
  const skins = Array.isArray(skeleton.skins) ? skeleton.skins : [];
  for (const [label, items] of [['bone', bones], ['slot', slots], ['skin', skins]]) {
    if (items.some(item => !item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name)) throw spineError('INVALID_SKELETON', `Each ${label} requires a nonempty name.`);
    if (new Set(items.map(item => item.name)).size !== items.length) issues.push(issue('error', 'DUPLICATE_SKELETON_NAME', `Duplicate ${label} names are not supported.`));
  }
  if (!bones.length) issues.push(issue('error', 'MISSING_BONES', 'Skeleton contains no bones.'));
  if (!Array.isArray(skeleton.skins)) issues.push(issue('error', 'UNSUPPORTED_SKINS', 'Spine 4.2 skins must be an array.'));
  const boneNames = new Set(bones.map(bone => bone.name));
  const slotNames = new Set(slots.map(slot => slot.name));
  for (const bone of bones) if (bone.parent && !boneNames.has(bone.parent)) issues.push(issue('error', 'MISSING_PARENT_BONE', `Bone ${bone.name} references missing parent ${bone.parent}.`));
  const earlierBones = new Set();
  for (const bone of bones) {
    if (bone.parent && !earlierBones.has(bone.parent)) issues.push(issue('error', 'INVALID_BONE_ORDER', `Bone ${bone.name} must appear after its parent ${bone.parent}.`));
    earlierBones.add(bone.name);
  }
  for (const slot of slots) if (!boneNames.has(slot.bone)) issues.push(issue('error', 'MISSING_SLOT_BONE', `Slot ${slot.name} references missing bone ${slot.bone}.`));
  const regionNames = new Set(atlas.regions.map(region => region.name));
  const attachments = [];
  const knownAttachments = new Map();
  for (const skin of skins) {
    for (const [slot, values] of Object.entries(skin.attachments ?? {})) {
      if (!slotNames.has(slot)) issues.push(issue('error', 'MISSING_SLOT', `Skin ${skin.name} references missing slot ${slot}.`));
      for (const [name, attachment] of Object.entries(values)) {
        if (!attachment || typeof attachment !== 'object') { issues.push(issue('error', 'INVALID_ATTACHMENT', `Invalid attachment ${name}.`)); continue; }
        const type = attachment.type ?? 'region';
        const path = attachment.path ?? name;
        const item = { skin: skin.name, slot, name, type, path, parent: attachment.parent ?? null };
        attachments.push(item);
        knownAttachments.set(`${skin.name}\u0000${slot}\u0000${name}`, item);
        if (attachment.sequence) issues.push(issue('error', 'UNSUPPORTED_SEQUENCE', `Attachment ${name} uses an indexed sequence; sequence replacement is not supported.`));
        if (['region', 'mesh', 'linkedmesh'].includes(type) && !attachment.sequence && !regionNames.has(path)) issues.push(issue('error', 'MISSING_REGION', `Attachment ${name} references missing atlas region ${path}.`, { skin: skin.name, slot, attachment: name, path }));
        if (!['region', 'mesh', 'linkedmesh', 'boundingbox', 'path', 'point', 'clipping'].includes(type)) issues.push(issue('error', 'UNSUPPORTED_ATTACHMENT', `Unsupported attachment type ${type}.`));
        if (type === 'linkedmesh' && !attachment.parent) issues.push(issue('error', 'MISSING_LINKED_MESH', `Linked mesh ${name} has no parent.`));
      }
    }
  }
  for (const slot of slots) {
    if (slot.attachment && !attachments.some(item => item.slot === slot.name && item.name === slot.attachment)) issues.push(issue('error', 'MISSING_ATTACHMENT', `Slot ${slot.name} references missing setup attachment ${slot.attachment}.`));
  }
  for (const attachment of attachments) {
    if (attachment.type !== 'linkedmesh' || !attachment.parent) continue;
    const source = skins.find(skin => skin.name === attachment.skin)?.attachments?.[attachment.slot]?.[attachment.name];
    const parentSkin = source.skin ?? 'default';
    if (!knownAttachments.has(`${parentSkin}\u0000${attachment.slot}\u0000${attachment.parent}`)) issues.push(issue('error', 'MISSING_LINKED_MESH', `Linked mesh ${attachment.name} references missing parent ${attachment.parent} in skin ${parentSkin}.`));
  }
  const animationEntries = Object.entries(skeleton.animations ?? {});
  for (const [name, animation] of animationEntries) {
    for (const [slot, timeline] of Object.entries(animation.slots ?? {})) {
      if (!slotNames.has(slot)) issues.push(issue('error', 'MISSING_ANIMATION_SLOT', `Animation ${name} references missing slot ${slot}.`));
      for (const frame of timeline.attachment ?? []) if (frame.name && !attachments.some(item => item.slot === slot && item.name === frame.name)) issues.push(issue('error', 'MISSING_ANIMATION_ATTACHMENT', `Animation ${name} references missing attachment ${frame.name}.`));
    }
  }
  const pageReports = [];
  for (const page of atlas.pages) {
    const buffer = pageBuffers.get(page.name);
    if (!buffer) { issues.push(issue('error', 'MISSING_PAGE', `Missing atlas texture ${page.name}.`, { page: page.name })); pageReports.push({ name: page.name, width: page.width, height: page.height, pma: page.pma, present: false }); continue; }
    try {
      const meta = await readPage(buffer, page.name);
      if ((page.width && page.width !== meta.width) || (page.height && page.height !== meta.height)) issues.push(issue('error', 'PAGE_SIZE_MISMATCH', `Atlas dimensions do not match PNG ${page.name}.`));
      for (const region of page.regions) {
        if (region.x + region.packedWidth > meta.width || region.y + region.packedHeight > meta.height) issues.push(issue('error', 'REGION_OUT_OF_BOUNDS', `Region ${region.name} is outside ${page.name}.`));
      }
      pageReports.push({ name: page.name, width: meta.width, height: meta.height, pma: page.pma, present: true });
    } catch (error) { issues.push(issue('error', error.code ?? 'INVALID_PAGE', `${page.name}: ${error.message}`)); }
  }
  if (regionNames.size !== atlas.regions.length) issues.push(issue('error', 'AMBIGUOUS_REGION', 'Duplicate atlas region names or indexed sequences are not supported for replacement.'));
  let overlaps = 0;
  overlapScan: for (const page of atlas.pages) {
    const ordered = [...page.regions].sort((a, b) => a.x - b.x);
    for (let a = 0; a < ordered.length; a++) for (let b = a + 1; b < ordered.length && ordered[b].x < ordered[a].x + ordered[a].packedWidth; b++) {
      if (rectanglesOverlap(ordered[a], ordered[b])) {
        issues.push(issue('warning', 'OVERLAPPING_REGIONS', `Regions ${ordered[a].name} and ${ordered[b].name} overlap; overlapping regions cannot be replaced.`, { regions: [ordered[a].name, ordered[b].name] }));
        if (++overlaps >= 100) { issues.push(issue('warning', 'OVERLAP_REPORT_LIMIT', 'Additional overlapping regions are omitted from this report. Replacement checks every region before writing.')); break overlapScan; }
      }
    }
  }
  return { format: 'spine-json-atlas', version, supported: !issues.some(item => item.severity === 'error'), bones: bones.map(({ name, parent }) => ({ name, parent: parent ?? null })), slots: slots.map(({ name, bone, attachment }) => ({ name, bone, attachment: attachment ?? null })), skins: skins.map(skin => skin.name), animations: animationEntries.map(([name]) => name), attachments, pages: pageReports, regions: atlas.regions.map(({ properties, ...region }) => region), issues, validationScope: 'Structure and texture mapping only; playback and visual acceptance require a compatible Spine runtime.' };
}

async function regionContext(atlasInput, pageInput, regionName) {
  const atlas = parseAtlas(atlasInput);
  const pages = normalizePages(pageInput);
  const region = findRegion(atlas, regionName);
  const page = atlas.pages.find(item => item.name === region.page);
  const buffer = pages.get(page.name);
  if (!buffer) throw spineError('MISSING_PAGE', `Missing atlas texture ${page.name}.`);
  const metadata = await readPage(buffer, page.name);
  if ((page.width && page.width !== metadata.width) || (page.height && page.height !== metadata.height)) throw spineError('PAGE_SIZE_MISMATCH', `Atlas dimensions do not match PNG ${page.name}.`);
  if (region.x + region.packedWidth > metadata.width || region.y + region.packedHeight > metadata.height) throw spineError('REGION_OUT_OF_BOUNDS', `Region ${region.name} is outside ${page.name}.`);
  return { atlas, pages, region, page, metadata, buffer };
}

function alphaConvert(data, premultiply) {
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    for (let c = 0; c < 3; c++) data[offset + c] = premultiply ? Math.round(data[offset + c] * alpha / 255) : alpha ? Math.min(255, Math.round(data[offset + c] * 255 / alpha)) : 0;
  }
  return data;
}

export async function extractRegion({ atlas, pages, regionName, restoreTrim = true }) {
  const context = await regionContext(atlas, pages, regionName);
  const { region, page } = context;
  let extracted = await sharp(context.buffer, imageOptions).ensureAlpha().extract({ left: region.x, top: region.y, width: region.packedWidth, height: region.packedHeight }).raw().toBuffer({ resolveWithObject: true });
  if (page.pma) alphaConvert(extracted.data, false);
  let image = sharp(extracted.data, { raw: { width: extracted.info.width, height: extracted.info.height, channels: 4 } });
  if (region.rotation === 90) image = image.rotate(90);
  const unrotated = await image.png().toBuffer();
  if (!restoreTrim) return unrotated;
  return sharp({ create: { width: region.originalWidth, height: region.originalHeight, channels: 4, background: '#00000000' } }).composite([{ input: unrotated, left: region.offsetX, top: region.offsetTop }]).png().toBuffer();
}

function validateTransform(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw spineError('INVALID_TRANSFORM', 'Transform must be an object.');
  const allowed = new Set(['fit', 'scale', 'rotation', 'offsetX', 'offsetY', 'flipX', 'flipY', 'extrude']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw spineError('INVALID_TRANSFORM', `Unknown transform property ${key}.`);
  const transform = { fit: 'contain', scale: 1, rotation: 0, offsetX: 0, offsetY: 0, flipX: false, flipY: false, extrude: 0, ...input };
  if (!['contain', 'cover', 'fill'].includes(transform.fit)) throw spineError('INVALID_TRANSFORM', 'Fit must be contain, cover or fill.');
  for (const key of ['scale', 'rotation', 'offsetX', 'offsetY', 'extrude']) if (!Number.isFinite(transform[key])) throw spineError('INVALID_TRANSFORM', `${key} must be finite.`);
  if (transform.scale <= 0 || transform.scale > 8 || Math.abs(transform.rotation) > 360 || Math.abs(transform.offsetX) > SPINE_LIMITS.dimension || Math.abs(transform.offsetY) > SPINE_LIMITS.dimension || !Number.isInteger(transform.extrude) || transform.extrude < 0 || transform.extrude > 4 || typeof transform.flipX !== 'boolean' || typeof transform.flipY !== 'boolean') throw spineError('INVALID_TRANSFORM', 'Transform exceeds supported bounds.');
  return transform;
}

async function prepareReplacement(buffer, region, transform) {
  if (!Buffer.isBuffer(buffer) || buffer.length > SPINE_LIMITS.fileBytes) throw spineError('INPUT_LIMIT', 'Replacement must be an image Buffer no larger than 64 MiB.');
  const metadata = await sharp(buffer, imageOptions).metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw spineError('UNSUPPORTED_REPLACEMENT', 'Replacement must be a single PNG, JPEG or WebP image.');
  if (!metadata.width || !metadata.height || metadata.width > SPINE_LIMITS.dimension || metadata.height > SPINE_LIMITS.dimension) throw spineError('INPUT_LIMIT', 'Replacement image dimensions exceed supported limits.');
  const ratio = transform.fit === 'cover' ? Math.max(region.originalWidth / metadata.width, region.originalHeight / metadata.height) : Math.min(region.originalWidth / metadata.width, region.originalHeight / metadata.height);
  const width = Math.max(1, Math.round((transform.fit === 'fill' ? region.originalWidth : metadata.width * ratio) * transform.scale));
  const height = Math.max(1, Math.round((transform.fit === 'fill' ? region.originalHeight : metadata.height * ratio) * transform.scale));
  if (width > SPINE_LIMITS.dimension || height > SPINE_LIMITS.dimension || width * height > SPINE_LIMITS.pixels) throw spineError('INPUT_LIMIT', 'Transformed replacement is too large.');
  const radians = transform.rotation * Math.PI / 180;
  const rotatedWidth = Math.ceil(Math.abs(Math.cos(radians)) * width + Math.abs(Math.sin(radians)) * height - 1e-8);
  const rotatedHeight = Math.ceil(Math.abs(Math.sin(radians)) * width + Math.abs(Math.cos(radians)) * height - 1e-8);
  if (rotatedWidth > SPINE_LIMITS.dimension || rotatedHeight > SPINE_LIMITS.dimension || rotatedWidth * rotatedHeight > SPINE_LIMITS.pixels) throw spineError('INPUT_LIMIT', 'Rotated replacement is too large.');
  let resized = await sharp(buffer, imageOptions).rotate().ensureAlpha().resize(width, height, { fit: 'fill' }).png().toBuffer();
  let operation = sharp(resized, imageOptions);
  if (transform.flipX) operation = operation.flop();
  if (transform.flipY) operation = operation.flip();
  if (transform.rotation) operation = operation.rotate(transform.rotation, { background: '#00000000' });
  const { data, info } = await operation.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const canvas = Buffer.alloc(region.originalWidth * region.originalHeight * 4);
  const left = Math.round((region.originalWidth - info.width) / 2 + transform.offsetX);
  const top = Math.round((region.originalHeight - info.height) / 2 + transform.offsetY);
  let clippedPixels = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if ((x + left < 0 || x + left >= region.originalWidth || y + top < 0 || y + top >= region.originalHeight) && data[(y * info.width + x) * 4 + 3]) clippedPixels++;
  }
  for (let y = Math.max(0, top); y < Math.min(region.originalHeight, top + info.height); y++) {
    const start = Math.max(0, left);
    const count = Math.min(region.originalWidth, left + info.width) - start;
    if (count > 0) data.copy(canvas, (y * region.originalWidth + start) * 4, ((y - top) * info.width + start - left) * 4, ((y - top) * info.width + start - left + count) * 4);
  }
  for (let y = 0; y < region.originalHeight; y++) for (let x = 0; x < region.originalWidth; x++) {
    if ((x < region.offsetX || x >= region.offsetX + region.width || y < region.offsetTop || y >= region.offsetTop + region.height) && canvas[(y * region.originalWidth + x) * 4 + 3]) clippedPixels++;
  }
  let crop = await sharp(canvas, { raw: { width: region.originalWidth, height: region.originalHeight, channels: 4 } }).extract({ left: region.offsetX, top: region.offsetTop, width: region.width, height: region.height }).png().toBuffer();
  let packing = sharp(crop);
  if (region.rotation === 90) packing = packing.rotate(270);
  return { ...(await packing.ensureAlpha().raw().toBuffer({ resolveWithObject: true })), clippedPixels };
}

export async function replaceRegion({ atlas, pages, regionName, buffer, transform = {} }) {
  const context = await regionContext(atlas, pages, regionName);
  const settings = validateTransform(transform);
  const { region, page, metadata } = context;
  if (region.properties.split || region.properties.pad) throw spineError('UNSUPPORTED_NINEPATCH', 'Ninepatch region replacement is not supported.');
  const padding = settings.extrude;
  if (region.x - padding < 0 || region.y - padding < 0 || region.x + region.packedWidth + padding > metadata.width || region.y + region.packedHeight + padding > metadata.height) throw spineError('UNSAFE_EXTRUSION', 'Requested extrusion exceeds atlas page bounds.');
  for (const other of page.regions) if (other !== region && rectanglesOverlap(region, other, padding)) throw spineError('OVERLAPPING_REGIONS', `Replacement or extrusion would overwrite region ${other.name}.`);
  const replacement = await prepareReplacement(buffer, region, settings);
  if (page.pma) alphaConvert(replacement.data, true);
  const pageData = await sharp(context.buffer, imageOptions).ensureAlpha().raw().toBuffer();
  const width = region.packedWidth;
  const height = region.packedHeight;
  for (let y = -padding; y < height + padding; y++) for (let x = -padding; x < width + padding; x++) {
    const source = (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4;
    const target = ((region.y + y) * metadata.width + region.x + x) * 4;
    replacement.data.copy(pageData, target, source, source + 4);
  }
  const output = await sharp(pageData, { raw: { width: metadata.width, height: metadata.height, channels: 4 } }).png().toBuffer();
  const resultPages = new Map(context.pages);
  resultPages.set(page.name, output);
  const warnings = [];
  if (replacement.clippedPixels) warnings.push(issue('warning', 'TRIM_CLIPPED', `${replacement.clippedPixels} opaque pixels fall outside the existing trim rectangle and were clipped. Adjust the image or transform.`, { pixels: replacement.clippedPixels }));
  return { pages: resultPages, pageName: page.name, buffer: output, region: { ...region, properties: undefined }, transform: settings, warnings };
}
