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

function boundedInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

function parseColor(color, allowTransparent = true) {
  if (allowTransparent && color === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) {
    throw new Error('Color must be #RRGGBB or #RRGGBBAA' + (allowTransparent ? ' or transparent.' : '.'));
  }
  return {
    r: parseInt(color.slice(1, 3), 16), g: parseInt(color.slice(3, 5), 16), b: parseInt(color.slice(5, 7), 16),
    alpha: color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1,
  };
}

export function normalizeRecipe(recipe = {}) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw new Error('Recipe must be an object.');
  const allowed = new Set(['version', 'width', 'height', 'padding', 'trim', 'fit', 'background', 'removeBackground']);
  for (const key of Object.keys(recipe)) if (!allowed.has(key)) throw new Error(`Unknown image recipe field: ${key}.`);
  if (recipe.version !== undefined && recipe.version !== 1) throw new Error('Only image recipe version 1 is supported.');
  const normalized = {
    version: 1,
    width: boundedInteger(recipe.width ?? 256, 'width', 1, MAX_IMAGE_DIMENSION),
    height: boundedInteger(recipe.height ?? 256, 'height', 1, MAX_IMAGE_DIMENSION),
    padding: boundedInteger(recipe.padding ?? 0, 'padding', 0, MAX_IMAGE_DIMENSION / 2),
    trim: recipe.trim ?? false,
    fit: recipe.fit ?? 'contain',
    background: recipe.background ?? 'transparent',
  };
  if (normalized.width * normalized.height > MAX_IMAGE_PIXELS) throw new Error('Output exceeds the 16 megapixel limit.');
  if (normalized.padding * 2 >= Math.min(normalized.width, normalized.height)) throw new Error('Padding must leave a nonempty content area.');
  if (typeof normalized.trim !== 'boolean') throw new Error('trim must be boolean.');
  if (!['contain', 'cover', 'fill'].includes(normalized.fit)) throw new Error('fit must be contain, cover or fill.');
  parseColor(normalized.background);
  if (recipe.removeBackground !== undefined) {
    const removal = recipe.removeBackground;
    if (!removal || typeof removal !== 'object' || Array.isArray(removal)) throw new Error('removeBackground must be an object.');
    for (const key of Object.keys(removal)) if (!['color', 'tolerance'].includes(key)) throw new Error(`Unknown removeBackground field: ${key}.`);
    parseColor(removal.color, false);
    normalized.removeBackground = {
      color: removal.color,
      tolerance: boundedInteger(removal.tolerance ?? 0, 'tolerance', 0, 255),
    };
  }
  return normalized;
}

export async function processImageBuffer(buffer, rawRecipe) {
  await inspectImage(buffer);
  const recipe = normalizeRecipe(rawRecipe);
  const { data, info } = await decoder(buffer).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (recipe.removeBackground) {
    const color = parseColor(recipe.removeBackground.color, false);
    const tolerance = recipe.removeBackground.tolerance;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.max(Math.abs(data[i] - color.r), Math.abs(data[i + 1] - color.g), Math.abs(data[i + 2] - color.b)) <= tolerance) data[i + 3] = 0;
    }
  }
  let pipeline = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
  if (recipe.trim) {
    const bounds = inspectAlpha(data, info.width, info.height).bounds;
    if (bounds) pipeline = pipeline.extract({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height });
  }
  const background = parseColor(recipe.background);
  pipeline = pipeline.resize({
    width: recipe.width - 2 * recipe.padding,
    height: recipe.height - 2 * recipe.padding,
    fit: recipe.fit, background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  if (recipe.padding) pipeline = pipeline.extend({
    top: recipe.padding, bottom: recipe.padding, left: recipe.padding, right: recipe.padding, background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  let output = await pipeline.png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  if (background.alpha > 0) {
    output = await sharp({ create: { width: recipe.width, height: recipe.height, channels: 4, background } })
      .composite([{ input: output }]).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  }
  return { buffer: output, recipe, metadata: { image: await inspectImage(output) } };
}
