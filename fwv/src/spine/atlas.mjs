/** Spine text atlas parsing. Source format: https://esotericsoftware.com/spine-atlas-format */
export const SPINE_LIMITS = Object.freeze({ atlasBytes: 4 * 1024 * 1024, jsonBytes: 16 * 1024 * 1024, fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, dimension: 8192, pixels: 32 * 1024 * 1024, regions: 10000 });

export function spineError(code, message, issues) {
  const error = new Error(message);
  error.code = code;
  if (issues) error.issues = issues;
  return error;
}

export function fileName(name) {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[\\/:\x00-\x1f]/.test(name)) {
    throw spineError('INVALID_FILE_NAME', 'Spine files must have plain filenames without folders.');
  }
  return name;
}

function tuple(value, count, label) {
  const result = value.split(',').map(part => Number(part.trim()));
    if (result.length !== count || value.split(',').some(part => !part.trim()) || result.some(item => !Number.isSafeInteger(item))) {
    throw spineError('INVALID_ATLAS', `${label} must contain ${count} integers.`);
  }
  return result;
}

function property(line, number) {
  const colon = line.indexOf(':');
  if (colon < 1) throw spineError('INVALID_ATLAS', `Invalid atlas property on line ${number}.`);
  return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
}

export function parseAtlas(input) {
  if (!(typeof input === 'string' || Buffer.isBuffer(input))) throw spineError('INVALID_ATLAS', 'Atlas must be text or a Buffer.');
  if (Buffer.byteLength(input) > SPINE_LIMITS.atlasBytes) throw spineError('INPUT_LIMIT', 'Atlas exceeds the 4 MiB input limit.');
  const lines = input.toString().replace(/^\uFEFF/, '').split(/\r?\n/);
  const pages = [];
  const regions = [];
  let page = null;
  let current = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) { page = null; current = null; continue; }
    if (!page) {
      const name = fileName(line);
      if (!/\.png$/i.test(name)) throw spineError('UNSUPPORTED_PAGE', 'Only PNG atlas pages are supported.');
      if (pages.some(item => item.name.toLowerCase() === name.toLowerCase())) throw spineError('DUPLICATE_PAGE', `Duplicate atlas page: ${name}`);
      page = { name, width: 0, height: 0, pma: false, properties: {}, regions: [] };
      pages.push(page);
      current = page;
      continue;
    }
    if (line.includes(':')) {
      const [key, value] = property(line, index + 1);
      if (Object.hasOwn(current.properties, key)) throw spineError('INVALID_ATLAS', `Duplicate ${key} property on line ${index + 1}.`);
      Object.defineProperty(current.properties, key, { value, enumerable: true, configurable: true, writable: true });
      continue;
    }
    current = { name: line, page: page.name, properties: {} };
    page.regions.push(current);
    regions.push(current);
    if (regions.length > SPINE_LIMITS.regions) throw spineError('INPUT_LIMIT', 'Atlas contains too many regions.');
  }
  if (!pages.length || !regions.length) throw spineError('INVALID_ATLAS', 'Atlas must contain at least one page and region.');
  for (const item of pages) {
    const values = item.properties;
    if (values.size) [item.width, item.height] = tuple(values.size, 2, 'Page size');
    if (item.width < 0 || item.height < 0 || item.width > SPINE_LIMITS.dimension || item.height > SPINE_LIMITS.dimension) throw spineError('INPUT_LIMIT', 'Atlas page dimensions exceed supported limits.');
    if (values.pma && !['true', 'false'].includes(values.pma)) throw spineError('INVALID_ATLAS', 'Atlas pma must be true or false.');
    item.pma = values.pma === 'true';
    item.filter = values.filter ?? 'Nearest,Nearest';
    item.repeat = values.repeat ?? 'none';
  }
  for (const region of regions) {
    const values = region.properties;
    if (values.bounds) {
      if (values.xy || values.size) throw spineError('INVALID_ATLAS', `Region ${region.name} mixes bounds and legacy coordinates.`);
      [region.x, region.y, region.width, region.height] = tuple(values.bounds, 4, 'Region bounds');
    } else if (values.xy && values.size) {
      [region.x, region.y] = tuple(values.xy, 2, 'Region xy');
      [region.width, region.height] = tuple(values.size, 2, 'Region size');
    } else throw spineError('INVALID_ATLAS', `Region ${region.name} is missing bounds or xy/size.`);
    const rotation = values.rotate === 'true' ? 90 : values.rotate === 'false' || values.rotate === undefined ? 0 : Number(values.rotate);
    if (![0, 90].includes(rotation)) throw spineError('UNSUPPORTED_ROTATION', `Region ${region.name}: only atlas rotation 0 or 90 is supported.`);
    region.rotation = rotation;
    region.packedWidth = rotation === 90 ? region.height : region.width;
    region.packedHeight = rotation === 90 ? region.width : region.height;
    region.offsetX = 0;
    region.offsetY = 0;
    region.originalWidth = region.width;
    region.originalHeight = region.height;
    if (values.offsets) {
      if (values.offset || values.orig) throw spineError('INVALID_ATLAS', `Region ${region.name} mixes offsets and legacy trim metadata.`);
      [region.offsetX, region.offsetY, region.originalWidth, region.originalHeight] = tuple(values.offsets, 4, 'Region offsets');
    } else {
      if (values.offset) [region.offsetX, region.offsetY] = tuple(values.offset, 2, 'Region offset');
      if (values.orig) [region.originalWidth, region.originalHeight] = tuple(values.orig, 2, 'Region orig');
    }
    region.index = values.index === undefined ? -1 : tuple(values.index, 1, 'Region index')[0];
    if ([region.x, region.y, region.offsetX, region.offsetY].some(value => value < 0) || [region.width, region.height, region.originalWidth, region.originalHeight].some(value => value <= 0 || value > SPINE_LIMITS.dimension)) throw spineError('INVALID_ATLAS', `Invalid region dimensions: ${region.name}`);
    if (region.originalWidth * region.originalHeight > SPINE_LIMITS.pixels || region.offsetX + region.width > region.originalWidth || region.offsetY + region.height > region.originalHeight) throw spineError('INVALID_ATLAS', `Invalid trim offsets: ${region.name}`);
    region.offsetTop = region.originalHeight - region.height - region.offsetY;
  }
  return { pages, regions };
}

export function normalizePages(input) {
  const entries = input instanceof Map ? [...input] : Object.entries(input ?? {});
  const pages = new Map();
  let total = 0;
  for (const [name, buffer] of entries) {
    fileName(name);
    if (!Buffer.isBuffer(buffer) || buffer.length > SPINE_LIMITS.fileBytes) throw spineError('INPUT_LIMIT', `Invalid or oversized image: ${name}`);
    total += buffer.length;
    if (total > SPINE_LIMITS.totalBytes) throw spineError('INPUT_LIMIT', 'Atlas pages exceed the 256 MiB total input limit.');
    pages.set(name, buffer);
  }
  return pages;
}

export function findRegion(atlas, name) {
  const matches = atlas.regions.filter(region => region.name === name);
  if (matches.length !== 1) throw spineError(matches.length ? 'AMBIGUOUS_REGION' : 'REGION_NOT_FOUND', `Expected one atlas region named ${name}; found ${matches.length}. Indexed sequences are not supported for replacement.`);
  return matches[0];
}
