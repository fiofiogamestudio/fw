import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { inspectImage, imageMime, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_DIMENSION } from '../image/processor.mjs';

export const GENERATION_LIMITS = Object.freeze({
  imageBytes: MAX_IMAGE_BYTES, responseBytes: 46 * 1024 * 1024,
  errorBytes: 64 * 1024, modelsBytes: 1024 * 1024,
  promptCharacters: 32000, generationTimeoutMs: 180000, checkTimeoutMs: 15000,
});
const DEFAULTS = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', protocol: 'gpt-image' };
const fault = (code, message, extra = {}) => Object.assign(new Error(message), { code, uncertain: false, ...extra });
const hostname = url => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
const loopback = url => ['localhost', '127.0.0.1', '::1'].includes(hostname(url));

function baseUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw fault('INVALID_PROVIDER_URL', 'Provider URL must be a nonempty URL of at most 2048 characters.');
  let url;
  try { url = new URL(value.trim()); } catch { throw fault('INVALID_PROVIDER_URL', 'Provider URL is invalid.'); }
  if (url.username || url.password || url.search || url.hash) throw fault('INVALID_PROVIDER_URL', 'Provider URL cannot contain credentials, query parameters or fragments.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) throw fault('INVALID_PROVIDER_URL', 'Provider URL requires HTTPS; HTTP is allowed only for an explicitly selected loopback service.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function modelName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\x00-\x1f\x7f]/.test(value)) throw fault('INVALID_MODEL', 'Model must be a readable identifier of at most 160 characters.');
  return value.trim();
}

function redact(value, key) {
  let text = String(value ?? '');
  if (key) {
    for (const variant of new Set([key, encodeURIComponent(key)])) text = text.split(variant).join('[REDACTED]');
  }
  return text.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]');
}

function cleanText(value, key, max = 1000) {
  return typeof value === 'string' ? redact(value, key).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max) : null;
}

function cleanUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return null;
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 32)) {
    if (!/^[a-z_]{1,50}$/.test(key)) continue;
    if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) result[key] = entry;
    else if (entry && typeof entry === 'object') { const nested = cleanUsage(entry, depth + 1); if (nested) result[key] = nested; }
  }
  return result;
}

function requestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, timedOut: () => timedOut, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

async function readBounded(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => {});
    throw fault('RESPONSE_TOO_LARGE', 'Provider response exceeds the allowed byte limit.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw fault('RESPONSE_TOO_LARGE', 'Provider response exceeds the allowed byte limit.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function parseJson(buffer) {
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw fault('INVALID_RESPONSE', 'Provider did not return a valid JSON response.'); }
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
}

async function downloadUrl(value, providerUrl, lookupImpl) {
  let url;
  try { url = new URL(value); } catch { throw fault('UNSAFE_IMAGE_URL', 'Provider returned an invalid image URL.'); }
  if (url.username || url.password || url.hash || value.length > 8192) throw fault('UNSAFE_IMAGE_URL', 'Image URL cannot contain embedded credentials or fragments.');
  const provider = new URL(providerUrl);
  if (loopback(provider) && url.origin === provider.origin) return { url, address: null };
  if (url.protocol !== 'https:' || loopback(url) || /(?:^|\.)(localhost|local|internal)$/i.test(hostname(url))) throw fault('UNSAFE_IMAGE_URL', 'Image downloads require a public HTTPS URL or the explicitly selected loopback provider origin.');
  const addresses = isIP(hostname(url)) ? [{ address: hostname(url) }] : await lookupImpl(hostname(url), { all: true });
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw fault('UNSAFE_IMAGE_URL', 'Image download resolved to a private or reserved address.');
  return { url, address: { address: addresses[0].address, family: isIP(addresses[0].address) } };
}

function downloadPinned({ url, address }, signal, requestImpl) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const host = hostname(url);
    const request = requestImpl(url, {
      method: 'GET', signal, agent: false, rejectUnauthorized: true,
      ...(isIP(host) ? {} : { servername: host }),
      family: address.family, autoSelectFamily: false, maxHeaderSize: 16 * 1024,
      headers: { Accept: 'image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity' },
      // Resolve exactly once. A fresh socket uses only the address checked above,
      // while the original URL hostname still controls Host, SNI and certificate
      // verification. No shared agent or subsequent DNS lookup can bypass it.
      lookup(requestedHost, options, callback) {
        if (requestedHost.replace(/^\[|\]$/g, '').toLowerCase() !== host) return callback(fault('UNSAFE_IMAGE_URL', 'Image download hostname changed during connection.'));
        if (options?.all) callback(null, [{ ...address }]);
        else callback(null, address.address, address.family);
      },
    }, response => {
      void (async () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          throw fault('IMAGE_DOWNLOAD_FAILED', `Generated image download returned HTTP ${response.statusCode}. Redirects are not followed.`);
        }
        const length = Number(response.headers['content-length']);
        if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) {
          response.destroy(); throw fault('RESPONSE_TOO_LARGE', 'Generated image exceeds the 32 MiB limit.');
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) { response.destroy(); throw fault('RESPONSE_TOO_LARGE', 'Generated image exceeds the 32 MiB limit.'); }
          chunks.push(chunk);
        }
        resolve(Buffer.concat(chunks, size));
      })().catch(reject);
    });
    request.once('error', reject);
    request.end();
  });
}

// Without a protocol, validate the shared input shape. The provider repeats this
// with its captured protocol immediately before dispatching the HTTP request.
export function validateGeneration({ prompt, size, quality, background, protocol }) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > GENERATION_LIMITS.promptCharacters || prompt.includes('\0')) throw fault('INVALID_PROMPT', 'Prompt must contain 1 to 32000 characters.');
  if (size !== 'auto') {
    const match = typeof size === 'string' && /^([1-9]\d{0,3})x([1-9]\d{0,3})$/.exec(size);
    if (!match || Number(match[1]) > MAX_IMAGE_DIMENSION || Number(match[2]) > MAX_IMAGE_DIMENSION || Number(match[1]) * Number(match[2]) > MAX_IMAGE_PIXELS) throw fault('INVALID_SIZE', 'Size must be auto or WIDTHxHEIGHT within the image size limits.');
  }
  const qualities = protocol === 'gpt-image' ? ['auto', 'low', 'medium', 'high'] : ['auto', 'standard', 'hd', 'low', 'medium', 'high'];
  if (!qualities.includes(quality)) throw fault('INVALID_QUALITY', 'Quality is not supported by the selected protocol.');
  if (!['auto', 'opaque', 'transparent'].includes(background)) throw fault('INVALID_BACKGROUND', 'Background must be auto, opaque or transparent.');
  if (protocol === 'openai-compatible' && background !== 'auto') throw fault('UNSUPPORTED_BACKGROUND', 'Explicit background control requires the GPT Image protocol; compatible mode sends only basic image parameters.');
}

/** Memory-only credentials and native HTTP for OpenAI Images and compatible providers. */
export class ImagesProvider {
  #fetch;
  #lookup;
  #httpsRequest;
  #config = { ...DEFAULTS };
  #key = '';
  #keySource = 'none';

  constructor({ fetchImpl = fetch, env = process.env, lookupImpl = lookup, httpsRequestImpl = httpsRequest } = {}) {
    if ([fetchImpl, lookupImpl, httpsRequestImpl].some(value => typeof value !== 'function')) throw fault('INVALID_FETCH', 'Fetch, lookup and HTTPS request implementations must be functions.');
    this.#fetch = fetchImpl;
    this.#lookup = lookupImpl;
    this.#httpsRequest = httpsRequestImpl;
    this.configure({
      baseUrl: env.FWV_IMAGE_BASE_URL || DEFAULTS.baseUrl,
      model: env.FWV_IMAGE_MODEL || DEFAULTS.model,
      ...(env.FWV_IMAGE_API_KEY ? { apiKey: env.FWV_IMAGE_API_KEY } : {}),
    });
    if (this.#key) this.#keySource = 'environment';
  }

  publicConfig() {
    return { ...this.#config, keyConfigured: Boolean(this.#key), keySource: this.#keySource,
      canGenerate: Boolean(this.#key) || loopback(new URL(this.#config.baseUrl)) };
  }

  configure(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['baseUrl', 'model', 'protocol', 'apiKey', 'clearKey'].includes(key))) throw fault('INVALID_CONFIG', 'Provider configuration fields are invalid.');
    const config = { baseUrl: baseUrl(options.baseUrl ?? this.#config.baseUrl), model: modelName(options.model ?? this.#config.model), protocol: options.protocol ?? this.#config.protocol };
    if (!['gpt-image', 'openai-compatible'].includes(config.protocol)) throw fault('INVALID_PROTOCOL', 'Protocol must be gpt-image or openai-compatible.');
    if (options.clearKey !== undefined && typeof options.clearKey !== 'boolean') throw fault('INVALID_CONFIG', 'clearKey must be boolean.');
    if (options.apiKey !== undefined && (typeof options.apiKey !== 'string' || options.apiKey.length > 4096 || /[\x00-\x1f\x7f]/.test(options.apiKey))) throw fault('INVALID_KEY', 'API key must be a single line of at most 4096 characters.');
    const key = options.apiKey?.trim();
    if (options.clearKey && key) throw fault('INVALID_CONFIG', 'Choose either a new API key or clearKey, not both.');
    if (config.baseUrl !== this.#config.baseUrl || options.clearKey) { this.#key = ''; this.#keySource = 'none'; }
    if (key) { this.#key = key; this.#keySource = 'session'; }
    this.#config = config;
    return this.publicConfig();
  }

  #capture() {
    if (!this.#key && !loopback(new URL(this.#config.baseUrl))) throw fault('MISSING_API_KEY', 'Configure an image provider API key first.');
    return { ...this.#config, key: this.#key };
  }

  async #responseJson(response, config, limit) {
    if (!response.ok) {
      let message = `Image provider returned HTTP ${response.status}.`;
      try {
        const body = parseJson(await readBounded(response, GENERATION_LIMITS.errorBytes));
        const detail = cleanText(body?.error?.message ?? body?.message, config.key);
        if (detail) message += ` ${detail}`;
      } catch { /* Keep status without leaking raw HTML, headers or credentials. */ }
      throw fault('PROVIDER_HTTP_ERROR', message, { status: response.status, requestId: cleanText(response.headers.get('x-request-id'), config.key, 200) });
    }
    return parseJson(await readBounded(response, limit));
  }

  async checkConnection() {
    const config = this.#capture();
    const lifetime = requestSignal(undefined, GENERATION_LIMITS.checkTimeoutMs);
    try {
      const response = await this.#fetch(`${config.baseUrl}/models`, { method: 'GET', headers: config.key ? { Authorization: `Bearer ${config.key}` } : {}, signal: lifetime.signal, redirect: 'error' });
      const body = await this.#responseJson(response, config, GENERATION_LIMITS.modelsBytes);
      if (!Array.isArray(body?.data)) throw fault('INVALID_RESPONSE', 'Provider models response has no data list.');
      const models = body.data.slice(0, 1000).map(item => cleanText(item?.id, config.key, 160)).filter(Boolean);
      return { ok: true, scope: 'authentication', models, modelListed: models.includes(config.model), requestId: cleanText(response.headers.get('x-request-id'), config.key, 200) };
    } catch (error) {
      if (error.code && error.uncertain !== undefined) throw error;
      throw fault(lifetime.timedOut() ? 'PROVIDER_TIMEOUT' : 'PROVIDER_CONNECTION_FAILED', lifetime.timedOut() ? 'Provider authentication check timed out.' : `Provider authentication check failed. ${cleanText(error.message, config.key, 400)}`);
    } finally { lifetime.dispose(); }
  }

  async generate({ prompt, size = '1024x1024', quality = 'auto', background = 'auto', reference, signal } = {}) {
    const config = this.#capture();
    validateGeneration({ prompt, size, quality, background, protocol: config.protocol });
    if (signal?.aborted) throw fault('GENERATION_CANCELLED', 'Image generation was cancelled before sending.');
    let input;
    if (reference !== undefined) {
      if (!reference || !Buffer.isBuffer(reference.buffer) || !reference.buffer.length || reference.buffer.length > MAX_IMAGE_BYTES) throw fault('INVALID_REFERENCE', 'Reference must contain an image Buffer of at most 32 MiB.');
      const buffer = Buffer.from(reference.buffer);
      let metadata;
      try { metadata = await inspectImage(buffer); } catch { throw fault('INVALID_REFERENCE', 'Reference must be a valid PNG, JPEG or WebP image within the image limits.'); }
      const name = reference.name ?? `reference.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`;
      if (typeof name !== 'string' || !name || name.length > 120 || /[\\/"\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') throw fault('INVALID_REFERENCE', 'Reference filename must be a safe basename.');
      input = { buffer, mime: imageMime(metadata.format), name };
    }
    const request = { baseUrl: config.baseUrl, model: config.model, protocol: config.protocol, prompt: redact(prompt.trim(), config.key), size, quality, background };
    const parameters = { model: config.model, prompt: prompt.trim(), n: 1, size };
    if (config.protocol === 'gpt-image') {
      parameters.quality = quality;
      parameters.output_format = 'png';
      if (background !== 'auto') parameters.background = background;
    } else {
      parameters.response_format = 'b64_json';
      if (quality !== 'auto') parameters.quality = quality;
    }
    let body;
    const headers = config.key ? { Authorization: `Bearer ${config.key}` } : {};
    if (input) {
      body = new FormData();
      for (const [name, value] of Object.entries(parameters)) body.append(name, String(value));
      body.append('image', new Blob([input.buffer], { type: input.mime }), input.name);
    } else { body = JSON.stringify(parameters); headers['Content-Type'] = 'application/json'; }
    const lifetime = requestSignal(signal, GENERATION_LIMITS.generationTimeoutMs);
    let sent = false;
    let requestId = null;
    try {
      if (lifetime.signal.aborted) throw fault('GENERATION_CANCELLED', 'Image generation was cancelled before sending.');
      sent = true;
      const response = await this.#fetch(`${config.baseUrl}/images/${input ? 'edits' : 'generations'}`, { method: 'POST', headers, body, signal: lifetime.signal, redirect: 'error' });
      requestId = cleanText(response.headers.get('x-request-id'), config.key, 200);
      const result = await this.#responseJson(response, config, GENERATION_LIMITS.responseBytes);
      if (!Array.isArray(result?.data) || result.data.length !== 1) throw fault('INVALID_RESPONSE', 'Provider must return exactly one generated image.');
      const output = result.data[0];
      let buffer;
      if (typeof output?.b64_json === 'string') {
        const encoded = output.b64_json;
        if (!encoded.length || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw fault('INVALID_IMAGE_OUTPUT', 'Generated image is malformed or exceeds the 32 MiB limit.');
        buffer = Buffer.from(encoded, 'base64');
        if (buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== encoded) throw fault('INVALID_IMAGE_OUTPUT', 'Generated image encoding is invalid.');
      } else if (typeof output?.url === 'string') {
        const destination = await downloadUrl(output.url, config.baseUrl, this.#lookup);
        // Never forward the provider's authorization to a returned image URL.
        if (destination.address) buffer = await downloadPinned(destination, lifetime.signal, this.#httpsRequest);
        else {
          const image = await this.#fetch(destination.url, { method: 'GET', signal: lifetime.signal, redirect: 'error' });
          if (!image.ok) { await image.body?.cancel().catch(() => {}); throw fault('IMAGE_DOWNLOAD_FAILED', `Generated image download returned HTTP ${image.status}.`); }
          buffer = await readBounded(image, MAX_IMAGE_BYTES);
        }
      } else throw fault('INVALID_RESPONSE', 'Provider returned no image bytes or image URL.');
      let metadata;
      try { metadata = await inspectImage(buffer); } catch { throw fault('INVALID_IMAGE_OUTPUT', 'Provider output is not a valid PNG, JPEG or WebP image within the image limits.'); }
      if (lifetime.signal.aborted) throw fault('GENERATION_CANCELLED', 'Image generation was cancelled before the result was accepted.');
      return { buffer, mime: imageMime(metadata.format), name: `generated.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`,
        usage: cleanUsage(result.usage), requestId, revisedPrompt: cleanText(output.revised_prompt, config.key, GENERATION_LIMITS.promptCharacters), request };
    } catch (error) {
      if (error.code === 'PROVIDER_HTTP_ERROR') {
        // A gateway timeout or upstream failure may follow model execution.
        // Authentication/validation failures remain definitive.
        if (error.status === 408 || error.status >= 500) {
          error.uncertain = sent;
          error.message += ' The provider may have executed the request; check its usage before trying again. No automatic retry was sent.';
        }
        throw error;
      }
      const cancelled = lifetime.signal.aborted;
      const code = cancelled ? (lifetime.timedOut() ? 'GENERATION_TIMEOUT' : 'GENERATION_CANCELLED') : (error.code ?? 'GENERATION_FAILED');
      const message = cancelled ? (lifetime.timedOut() ? 'Image generation timed out.' : 'Image generation was cancelled.') : cleanText(error.message, config.key, 1000);
      throw fault(code, `${message}${sent ? ' The request may have reached the provider; check its usage before trying again. No automatic retry was sent.' : ''}`, { uncertain: sent, requestId });
    } finally { lifetime.dispose(); }
  }
}
