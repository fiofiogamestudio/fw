import sharp from 'sharp';
import { sampleSkeleton2d, skeleton2dMeshTriangles } from './sample.mjs';

const transparent = size => sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } }).png().toBuffer();
const fail = message => { throw new Error(`Skeleton2D thumbnail: ${message}`); };

function visibleBounds(sample) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (x, y, padding = 0) => {
    if (![x, y, padding].every(Number.isFinite)) fail('Sampled geometry must be finite.');
    minX = Math.min(minX, x - padding); minY = Math.min(minY, y - padding);
    maxX = Math.max(maxX, x + padding); maxY = Math.max(maxY, y + padding);
  };
  for (const slot of sample.slots) for (const point of slot.vertices) include(point.x, point.y);
  // Canvas uses butt caps and a miter limit of ten. Include the furthest allowed
  // stroke join so an authored line cannot escape the thumbnail's fitted bounds.
  for (const line of sample.lines) for (const point of line.points) include(point.x, point.y, line.width * 5);
  if (sample.clipBounds) {
    const clip = sample.clipBounds;
    minX = Math.max(minX, clip.x); minY = Math.max(minY, clip.y);
    maxX = Math.min(maxX, clip.x + clip.width); maxY = Math.min(maxY, clip.y + clip.height);
  }
  return maxX > minX && maxY > minY ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

/**
 * Render a complete sampled pose from a hash/PNG-validated readSkeleton2dBundle.
 * No paths, URLs, mutable project state or game-specific conventions are read.
 */
export async function renderSkeleton2dThumbnail(bundle, { size = 256, padding = 16, skin, animation, time = 0 } = {}) {
  if (!bundle?.document || !Array.isArray(bundle.files)) fail('A validated document and file buffers are required.');
  if (!Number.isInteger(size) || size < 16 || size > 1024 || !Number.isInteger(padding) || padding < 0 || padding * 2 >= size) fail('Output size or padding is invalid.');
  const sample = sampleSkeleton2d(bundle.document, { skin, animation, time });
  const bounds = visibleBounds(sample);
  if (!bounds) return transparent(size);
  const available = size - padding * 2, scale = Math.min(available / bounds.width, available / bounds.height);
  const byName = new Map(bundle.files.map(file => [file.name, file])), textures = new Map(), definitions = [];
  for (const slot of sample.slots) {
    if (textures.has(slot.fileName)) continue;
    const file = byName.get(slot.fileName);
    if (!file || file.role !== 'texture' || file.mime !== 'image/png' || !Buffer.isBuffer(file.buffer)
      || !file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail(`Missing validated PNG buffer for ${slot.fileName}.`);
    const id = `texture-${textures.size}`; textures.set(slot.fileName, id);
    definitions.push(`<image id="${id}" width="1" height="1" preserveAspectRatio="none" xlink:href="data:image/png;base64,${file.buffer.toString('base64')}"/>`);
  }
  const layers = [];
  // Match the Canvas panel: each slot's world-space lines precede that slot's image.
  for (const slot of sample.slots) {
    for (const line of sample.lines) if (line.slot === slot.name) {
      const opacity = line.color.length === 9 ? parseInt(line.color.slice(7), 16) / 255 : 1;
      layers.push(`<polyline points="${line.points.map(point => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="${line.color.slice(0, 7)}" stroke-opacity="${opacity}" stroke-width="${line.width}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10"/>`);
    }
    if (slot.type === 'mesh') {
      for (const triangle of skeleton2dMeshTriangles(slot, { seamPadding: 0.75 / scale })) {
        const id = `mesh-clip-${definitions.length}`;
        definitions.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><polygon points="${triangle.clipPoints.map(point => `${point.x},${point.y}`).join(' ')}"/></clipPath>`);
        layers.push(`<g clip-path="url(#${id})"><use xlink:href="#${textures.get(slot.fileName)}" transform="matrix(${triangle.matrix.join(' ')})"/></g>`);
      }
      continue;
    }
    const [a, b, c, d, x, y] = slot.matrix, w = slot.width, h = slot.height;
    // PNG coordinates are top-down. Map its unit square to the attachment's
    // centered y-up rectangle, then apply the already sampled attachment matrix.
    const matrix = [a * w, b * w, -c * h, -d * h, x - a * w / 2 + c * h / 2, y - b * w / 2 + d * h / 2];
    if (!matrix.every(Number.isFinite)) fail('Sampled image matrix must be finite.');
    layers.push(`<use xlink:href="#${textures.get(slot.fileName)}" transform="matrix(${matrix.join(' ')})"/>`);
  }
  const x = size / 2 - (bounds.x + bounds.width / 2) * scale;
  const y = size / 2 + (bounds.y + bounds.height / 2) * scale;
  const clip = sample.clipBounds;
  if (clip) definitions.push(`<clipPath id="pose-clip" clipPathUnits="userSpaceOnUse"><rect x="${clip.x}" y="${clip.y}" width="${clip.width}" height="${clip.height}"/></clipPath>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs>${definitions.join('')}</defs><g transform="matrix(${scale} 0 0 ${-scale} ${x} ${y})"><g${clip ? ' clip-path="url(#pose-clip)"' : ''}>${layers.join('')}</g></g></svg>`;
  return sharp(Buffer.from(svg), { limitInputPixels: size * size }).png().toBuffer();
}
