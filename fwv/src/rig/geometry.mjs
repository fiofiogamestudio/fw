export const RIG_LIMITS = Object.freeze({ parts: 16, vertices: 64, sourcePixels: 16 * 1024 * 1024, cutoutPixels: 32 * 1024 * 1024, atlasPixels: 32 * 1024 * 1024, pagePixels: 16 * 1024 * 1024, dimension: 8192, padding: 2 });
export const RIG_ROLES = Object.freeze(['torso', 'head', 'arm-left', 'arm-right', 'leg-left', 'leg-right', 'accessory']);
export const rigError = (code, message, extra = {}) => Object.assign(new Error(message), { code, status: 400, ...extra });
const epsilon = 1e-8;
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const between = (a, b, p) => p.x >= Math.min(a.x, b.x) - epsilon && p.x <= Math.max(a.x, b.x) + epsilon && p.y >= Math.min(a.y, b.y) - epsilon && p.y <= Math.max(a.y, b.y) + epsilon;
function intersects(a, b, c, d) {
  const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
  if (ac * ad < -epsilon && ca * cb < -epsilon) return true;
  return Math.abs(ac) <= epsilon && between(a, b, c) || Math.abs(ad) <= epsilon && between(a, b, d) || Math.abs(ca) <= epsilon && between(c, d, a) || Math.abs(cb) <= epsilon && between(c, d, b);
}
function point(value, width, height) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'x,y' || !Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.y < 0 || value.x > width || value.y > height) throw rigError('INVALID_RIG_POINT', 'Polygon vertices and pivots must be finite points inside the source image.');
  return { x: value.x, y: value.y };
}
export function validateParts(input, width, height) {
  if (!Array.isArray(input) || !input.length || input.length > RIG_LIMITS.parts) throw rigError('INVALID_RIG_PARTS', 'A rig draft requires between 1 and 16 parts.');
  const ids = new Set();
  const parts = input.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,name,parentId,pivot,polygon,role') throw rigError('INVALID_RIG_PART', 'Each part requires id, name, role, parentId, polygon and pivot.');
    if (typeof value.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(value.id) || ids.has(value.id)) throw rigError('INVALID_RIG_ID', 'Part IDs must be unique ASCII identifiers starting with a letter, up to 48 characters.');
    ids.add(value.id);
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || /[\x00-\x1f]/.test(value.name)) throw rigError('INVALID_RIG_NAME', 'Part names must contain 1 to 100 readable characters.');
    if (!RIG_ROLES.includes(value.role)) throw rigError('INVALID_RIG_ROLE', 'Unsupported rig part role.');
    if (value.parentId !== null && typeof value.parentId !== 'string') throw rigError('INVALID_RIG_PARENT', 'A part parent must be another part ID or null.');
    if (!Array.isArray(value.polygon) || value.polygon.length < 3 || value.polygon.length > RIG_LIMITS.vertices) throw rigError('INVALID_RIG_POLYGON', 'Part polygons need 3 to 64 vertices.');
    const polygon = value.polygon.map(value => point(value, width, height));
    if (new Set(polygon.map(p => `${p.x},${p.y}`)).size !== polygon.length) throw rigError('INVALID_RIG_POLYGON', 'Polygon vertices must be distinct; do not repeat the closing vertex.');
    const area = polygon.reduce((sum, p, index) => { const q = polygon[(index + 1) % polygon.length]; return sum + p.x * q.y - q.x * p.y; }, 0) / 2;
    if (Math.abs(area) <= epsilon) throw rigError('INVALID_RIG_POLYGON', 'Part polygons must have nonzero area.');
    for (let i = 0; i < polygon.length; i++) for (let j = i + 1; j < polygon.length; j++) {
      if (j === i + 1 || i === 0 && j === polygon.length - 1) continue;
      if (intersects(polygon[i], polygon[(i + 1) % polygon.length], polygon[j], polygon[(j + 1) % polygon.length])) throw rigError('INVALID_RIG_POLYGON', 'Part polygons cannot self-intersect or touch nonadjacent edges.');
    }
    return { id: value.id, name: value.name.trim(), role: value.role, parentId: value.parentId, polygon, pivot: point(value.pivot, width, height) };
  });
  for (const part of parts) if (part.parentId !== null && !ids.has(part.parentId)) throw rigError('INVALID_RIG_PARENT', `Part ${part.id} references an unknown parent.`);
  const visited = new Set(), visiting = new Set(), byId = new Map(parts.map(part => [part.id, part]));
  function visit(part) {
    if (visiting.has(part.id)) throw rigError('RIG_PARENT_CYCLE', 'Rig part parents cannot form a cycle.');
    if (visited.has(part.id)) return;
    visiting.add(part.id); if (part.parentId) visit(byId.get(part.parentId)); visiting.delete(part.id); visited.add(part.id);
  }
  for (const part of parts) visit(part);
  return parts;
}
export function validateMotion(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'idle,walk,wave' || ['idle', 'walk', 'wave'].some(key => typeof input[key] !== 'boolean')) throw rigError('INVALID_RIG_MOTION', 'Motion must contain boolean idle, walk and wave flags.');
  return { idle: input.idle, walk: input.walk, wave: input.wave };
}
export function polygonBounds(polygon) {
  const left = Math.floor(Math.min(...polygon.map(p => p.x))), top = Math.floor(Math.min(...polygon.map(p => p.y)));
  return { x: left, y: top, width: Math.ceil(Math.max(...polygon.map(p => p.x))) - left, height: Math.ceil(Math.max(...polygon.map(p => p.y))) - top };
}

/** Hard polygon mask samples pixel centers; source RGBA bytes are copied without compositing. */
export function cutParts(source, width, height, parts) {
  const bounds = parts.map(part => polygonBounds(part.polygon));
  if (bounds.reduce((sum, box) => sum + box.width * box.height, 0) > RIG_LIMITS.cutoutPixels) throw rigError('RIG_PIXEL_LIMIT', 'Combined part cutout bounds exceed 32 megapixels. Reduce overlap or resize the source.');
  const coverage = new Uint8Array(width * height);
  const cutouts = parts.map((part, index) => {
    const box = bounds[index], data = Buffer.alloc(box.width * box.height * 4);
    let visiblePixels = 0;
    for (let y = box.y; y < box.y + box.height; y++) {
      const scanY = y + 0.5, intersections = [];
      for (let edge = 0; edge < part.polygon.length; edge++) {
        const a = part.polygon[edge], b = part.polygon[(edge + 1) % part.polygon.length];
        if ((a.y > scanY) !== (b.y > scanY)) intersections.push(a.x + (scanY - a.y) * (b.x - a.x) / (b.y - a.y));
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const start = Math.max(box.x, Math.ceil(intersections[i] - 0.5)), end = Math.min(box.x + box.width, Math.ceil(intersections[i + 1] - 0.5));
        for (let x = start; x < end; x++) {
          const src = (y * width + x) * 4, dst = ((y - box.y) * box.width + x - box.x) * 4;
          source.copy(data, dst, src, src + 4);
          if (source[src + 3]) { visiblePixels++; coverage[y * width + x]++; }
        }
      }
    }
    return { part, bounds: box, data, visiblePixels };
  });
  let sourceVisiblePixels = 0, uncoveredPixels = 0, overlappingPixels = 0;
  for (let index = 0; index < coverage.length; index++) if (source[index * 4 + 3]) { sourceVisiblePixels++; if (!coverage[index]) uncoveredPixels++; if (coverage[index] > 1) overlappingPixels++; }
  return { cutouts, sourceVisiblePixels, uncoveredPixels, overlappingPixels };
}
