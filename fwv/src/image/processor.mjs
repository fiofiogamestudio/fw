import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8192;
const SUPPORTED_FORMATS = new Set(['png', 'jpeg', 'webp']);
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

function decoder(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Image must be a nonempty Buffer of at most 32 MiB.');
  }
  return sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' });
}

export async function inspectImage(buffer) {
  const metadata = await decoder(buffer).metadata();
  if (!SUPPORTED_FORMATS.has(metadata.format)) throw new Error('Only PNG, JPEG and WebP images are supported.');
  if ((metadata.pages ?? 1) !== 1) throw new Error('Animated or multi-page images are not supported.');
  if (!metadata.width || !metadata.height || metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION) {
    throw new Error(`Image dimensions must be between 1 and ${MAX_IMAGE_DIMENSION}.`);
  }
  // Force full decoding: reading a header alone does not establish image integrity.
  const { data, info } = await decoder(buffer).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    hasAlpha: Boolean(metadata.hasAlpha),
    ...(metadata.orientation ? { orientation: metadata.orientation } : {}),
    alpha: inspectAlpha(data, info.width, info.height, info.channels),
  };
}

export function imageMime(format) { return MIME[format]; }

export function inspectAlpha(data, width, height, channels = 4) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let transparentPixels = 0;
  let opaquePixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * channels + channels - 1];
      if (alpha === 0) transparentPixels += 1;
      else {
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x); bottom = Math.max(bottom, y);
        if (alpha === 255) opaquePixels += 1;
      }
    }
  }
  return {
    transparentPixels,
    opaquePixels,
    bounds: right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 },
  };
}
