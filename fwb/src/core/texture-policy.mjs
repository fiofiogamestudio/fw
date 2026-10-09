import fs from 'node:fs';
import { child, digest, fail, fileDigest, sectionValue, walk } from './files.mjs';
import { getTarget } from '../platforms.mjs';

const modes = { lossless: 0, lossy: 1, vram: 2 };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPrefix = value => typeof value === 'string' && value.length < 2048 && !/[\\:*?\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const parameters = ['mode', 'quality', 'maxSize'];

function validateSelection(value, label, rule = false) {
  const fields = ['include', 'exclude', ...parameters, ...(rule ? [] : ['rules'])];
  if (!plain(value) || Object.keys(value).some(key => !fields.includes(key))) fail('invalid-config', `${label} has invalid fields.`);
  for (const field of ['include', 'exclude']) {
    const values = value[field] ?? (field === 'exclude' ? [] : null);
    if (!Array.isArray(values) || (field === 'include' && !values.length) || values.length > 1000 || values.some(item => !validPrefix(item))) fail('invalid-config', `${label}.${field} must contain relative file or directory prefixes (no globs).`);
  }
  if ((!rule || value.mode !== undefined) && (typeof value.mode !== 'string' || !Object.hasOwn(modes, value.mode))) fail('invalid-config', `${label}.mode must be lossless, lossy or vram.`);
  if (value.quality !== undefined && (!Number.isFinite(value.quality) || value.quality < 0 || value.quality > 1)) fail('invalid-config', `${label}.quality must be between 0 and 1.`);
  if (value.maxSize !== undefined && (!Number.isSafeInteger(value.maxSize) || value.maxSize < 0 || value.maxSize > 16384)) fail('invalid-config', `${label}.maxSize must be 0 (unchanged) or at most 16384.`);
  if (rule && !parameters.some(key => value[key] !== undefined)) fail('invalid-config', `${label} must override mode, quality or maxSize.`);
}

export function validateTexturePolicy(value, label = 'texturePolicy') {
  if (value === undefined || value === false) return;
  validateSelection(value, label);
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules) || !value.rules.length || value.rules.length > 1000) fail('invalid-config', `${label}.rules must contain 1..1000 rules.`);
    for (const [index, rule] of value.rules.entries()) validateSelection(rule, `${label}.rules[${index}]`, true);
  }
}

export function resolveTexturePolicy(config, target) {
  const selected = config.targets?.[target]?.texturePolicy;
  const value = selected ?? (getTarget(target)?.family === 'web' ? config.texturePolicy : undefined);
  validateTexturePolicy(value);
  return value || null;
}

function setParam(source, key, value) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(line => line.trim() === '[params]');
  if (start < 0) fail('invalid-texture-import', 'Texture import has no params section.');
  let end = lines.findIndex((line, index) => index > start && /^\[/.test(line.trim()));
  if (end < 0) end = lines.length;
  const found = lines.findIndex((line, index) => index > start && index < end && line.split('=')[0].trim() === key);
  if (found >= 0) lines[found] = `${key}=${value}`;
  else lines.splice(end, 0, `${key}=${value}`);
  return lines.join('\n');
}

function effectivePolicyFor(asset, policy) {
  const matches = prefixes => prefixes.some(prefix => asset === prefix || asset.startsWith(`${prefix}/`));
  const selectedBy = selection => matches(selection.include) && !matches(selection.exclude ?? []);
  let selected = selectedBy(policy);
  const effective = Object.fromEntries(parameters.filter(key => policy[key] !== undefined).map(key => [key, policy[key]]));
  for (const rule of policy.rules ?? []) {
    if (!selectedBy(rule)) continue;
    selected = true;
    for (const key of parameters) if (rule[key] !== undefined) effective[key] = rule[key];
  }
  return selected ? effective : null;
}

/** Only the frozen snapshot is passed here, before the engine's import step. */
export function applyTexturePolicy(stage, policy) {
  if (!policy) return null;
  validateTexturePolicy(policy);
  const files = [];
  for (const relative of walk(stage, { skip: name => name.split('/').some(part => ['.godot', '.git', '.local', 'node_modules'].includes(part)) })) {
    if (!relative.endsWith('.import')) continue;
    const asset = relative.slice(0, -7);
    const effectivePolicy = effectivePolicyFor(asset, policy);
    if (!effectivePolicy) continue;
    const file = child(stage, relative);
    const before = fs.readFileSync(file, 'utf8');
    if (sectionValue(before, 'remap', 'importer') !== 'texture') continue;
    const source = child(stage, asset);
    if (!fs.statSync(source).isFile()) fail('invalid-texture-import', `Texture source is not a file: ${asset}`);
    let after = setParam(before, 'compress/mode', modes[effectivePolicy.mode]);
    if (effectivePolicy.quality !== undefined) after = setParam(after, 'compress/lossy_quality', effectivePolicy.quality);
    if (effectivePolicy.maxSize > 0) after = setParam(after, 'process/size_limit', effectivePolicy.maxSize);
    // Prevent 3D autodetection from silently replacing an explicitly chosen mode.
    after = setParam(after, 'detect_3d/compress_to', 0);
    fs.writeFileSync(file, after);
    files.push({ path: asset, effectivePolicy, sourceSha256: fileDigest(source), importBeforeSha256: digest(before), importSha256: digest(after) });
  }
  if (!files.length) fail('empty-texture-policy', 'Texture policy did not match any texture imports; check include prefixes and commit the .import settings.');
  return { policy, count: files.length, files, engine: 'Godot texture importer', sourceImagesModified: false };
}
