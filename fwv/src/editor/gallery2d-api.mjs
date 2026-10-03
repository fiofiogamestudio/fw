import { inspectImage, imageMime } from '../image/processor.mjs';
import sharp from 'sharp';
const mimes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const fail = message => Object.assign(new Error(message), { status: 400, code: 'GALLERY2D_INVALID' });
export const isGalleryImage = file => typeof file.mime === 'string' && mimes.has(file.mime.toLowerCase());
const imageStates = new WeakMap();
const MAX_THUMBNAIL_CACHE_BYTES = 32 * 1024 * 1024;
function imageState(project) {
  let state = imageStates.get(project);
  if (!state) { state = { thumbnails: new Map(), bytes: 0, active: 0, waiting: [] }; imageStates.set(project, state); }
  return state;
}
async function withImageDecode(state, callback) {
  if (state.active >= 4) await new Promise(resolve => state.waiting.push(resolve));
  else state.active++;
  try { return await callback(); }
  finally { if (state.waiting.length) state.waiting.shift()(); else state.active--; }
}

/** Fixed registered identity only; cached thumbnails never bypass source checks. */
export async function readGalleryImage(project, { assetId, revisionId, file: fileName, thumbnail = false }, { snapshot } = {}) {
  if (typeof revisionId !== 'string' || typeof fileName !== 'string' || typeof thumbnail !== 'boolean') throw fail('图片要求明确的素材、版本和登记文件。');
  const current = snapshot ?? await project._load(), asset = project._asset(current, assetId), revision = project._revision(asset, revisionId);
  const file = revision.files.find(entry => entry.name === fileName);
  if (!file || !isGalleryImage(file)) throw fail('图片未登记于此素材版本。');
  const state = imageState(project);
  return withImageDecode(state, async () => {
    const buffer = await project._readFile(asset.id, revision.id, file), metadata = await inspectImage(buffer), mime = file.mime.toLowerCase();
    if (imageMime(metadata.format) !== mime) throw fail(`登记图片类型与真实内容不一致：${file.name}。`);
    if (!thumbnail) return { buffer, mime };
    const key = `${file.sha256}:256`, cached = state.thumbnails.get(key);
    if (cached) { state.thumbnails.delete(key); state.thumbnails.set(key, cached); return { buffer: cached, mime: 'image/png' }; }
    const resized = await sharp(buffer).rotate().resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    if (resized.length <= MAX_THUMBNAIL_CACHE_BYTES) {
      while (state.bytes + resized.length > MAX_THUMBNAIL_CACHE_BYTES && state.thumbnails.size) {
        const oldest = state.thumbnails.keys().next().value; state.bytes -= state.thumbnails.get(oldest).length; state.thumbnails.delete(oldest);
      }
      // Parallel decodes of the same registered bytes may finish together.
      if (state.thumbnails.has(key)) state.bytes -= state.thumbnails.get(key).length;
      state.thumbnails.set(key, resized); state.bytes += resized.length;
    }
    return { buffer: resized, mime: 'image/png' };
  });
}
export async function handleImageApi({ state, req, res, url, snapshot }) {
  if (req.method !== 'GET' || url.pathname !== '/api/fwv/image') return false;
  const allowed = ['assetId', 'revisionId', 'file', 'thumbnail'];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
    || ['assetId', 'revisionId', 'file'].some(key => url.searchParams.getAll(key).length !== 1)
    || url.searchParams.has('thumbnail') && url.searchParams.get('thumbnail') !== '1') throw fail('图片查询参数不匹配。');
  const input = Object.fromEntries(url.searchParams); input.thumbnail = input.thumbnail === '1';
  const { buffer, mime } = await readGalleryImage(state.application, input, { snapshot });
  res.statusCode = 200; res.setHeader('Content-Type', mime); res.setHeader('Content-Length', buffer.length); res.end(buffer); return true;
}
