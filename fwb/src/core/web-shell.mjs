import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { child, fail, fileDigest, physicalPath } from './files.mjs';

const runtime = fileURLToPath(new URL('../../runtime/web/', import.meta.url));
const targets = new Set(['web', 'poki', 'taptap-h5']);
const defaults = Object.freeze({ enabled: false, maxWidth: 0, maxDevicePixelRatio: 3, safeArea: true, background: '#080b0b', label: 'Game', locale: 'en', startupTimeoutSeconds: 120 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validate(value, label) {
  if (value === undefined) return;
  if (!plain(value)) fail('invalid-config', `${label} must be an object.`);
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) fail('invalid-config', `Unknown ${label} setting: ${key}`);
  for (const key of ['enabled', 'safeArea']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('invalid-config', `${label}.${key} must be boolean.`);
  for (const [key, min, max] of [['maxWidth', 0, 8192], ['maxDevicePixelRatio', 1, 4], ['startupTimeoutSeconds', 10, 600]]) {
    if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < min || value[key] > max)) fail('invalid-config', `${label}.${key} must be ${min}..${max}.`);
  }
  if (value.background !== undefined && !/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(value.background)) fail('invalid-config', `${label}.background must be a hexadecimal CSS color.`);
  if (value.label !== undefined && (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 240 || /[\x00-\x1f]/.test(value.label))) fail('invalid-config', `${label}.label must be nonempty text of at most 240 characters.`);
  if (value.locale !== undefined && !['en', 'zh-CN'].includes(value.locale)) fail('invalid-config', `${label}.locale must be en or zh-CN.`);
}

export function validateWebShell(config) {
  validate(config.webShell, 'webShell');
  for (const [target, value] of Object.entries(config.targets ?? {})) {
    validate(value.webShell, `targets.${target}.webShell`);
    if (!targets.has(target) && value.webShell?.enabled) fail('invalid-config', `FWB Web shell is not supported for ${target}.`);
  }
}

export function resolveWebShell(config, target) {
  validateWebShell(config);
  if (!targets.has(target)) return null;
  const options = { ...defaults, ...config.webShell, ...config.targets?.[target]?.webShell };
  return options.enabled ? options : null;
}

export function prepareWebShell({ project, stage, target }) {
  const options = resolveWebShell(project.config, target);
  if (!options) return null;
  if (physicalPath(stage) === physicalPath(project.root)) fail('unsafe-stage', 'FWB Web shell must be prepared in an isolated snapshot.');
  const relative = 'addons/fwb_web/fwb-shell.html';
  const filename = child(stage, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  // JSON is data within a script element; escape HTML delimiters as well as JS separators.
  const json = JSON.stringify(options).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const html = fs.readFileSync(path.join(runtime, 'fwb-shell.html'), 'utf8').replace('$FWB_SHELL_CONFIG', () => json);
  fs.writeFileSync(filename, html);
  const files = [{ path: relative, sha256: fileDigest(filename) }];
  for (const name of ['fwb-shell.js', 'fwb-media.js']) {
    const destination = child(stage, `addons/fwb_web/${name}`);
    fs.copyFileSync(path.join(runtime, name), destination);
    files.push({ path: `addons/fwb_web/${name}`, sha256: fileDigest(destination) });
  }
  return { customShell: `res://${relative}`, canvasResizePolicy: 0, options, files };
}

export function copyWebShellOutput({ project, stage, out, target }) {
  if (!resolveWebShell(project.config, target)) return null;
  if (physicalPath(out) === physicalPath(project.root)) fail('unsafe-stage', 'FWB Web shell assets must be copied into an isolated output.');
  fs.mkdirSync(out, { recursive: true });
  return ['fwb-shell.js', 'fwb-media.js'].map(relative => {
    const filename = child(out, relative);
    fs.copyFileSync(stage ? child(stage, `addons/fwb_web/${relative}`) : path.join(runtime, relative), filename);
    return { path: relative, sha256: fileDigest(filename) };
  });
}
