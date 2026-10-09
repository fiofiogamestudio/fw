import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, child, digest, fail, fileDigest, physicalPath, readJson, sectionValue, walk } from './files.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed, label) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('invalid-config', `Invalid ${label} settings.`);
};

export function validateRuntimeConfig(config) {
  if (config === undefined) return;
  keys(config, ['sdk', 'taptap', 'requestTimeoutMs', 'saveFlow', 'ads'], 'runtime');
  if (config.requestTimeoutMs !== undefined && (!Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 120000)) fail('invalid-config', 'runtime.requestTimeoutMs must be 1000..120000.');
  if (config.sdk !== undefined) {
    keys(config.sdk, ['mock'], 'runtime.sdk');
    if (config.sdk.mock !== undefined && typeof config.sdk.mock !== 'boolean') fail('invalid-config', 'runtime.sdk.mock must be boolean.');
  }
  if (config.taptap !== undefined) {
    keys(config.taptap, ['enabled', 'cloudSave', 'rewardedAdUnitId', 'interstitialAdUnitId'], 'runtime.taptap');
    for (const key of ['enabled', 'cloudSave']) if (config.taptap[key] !== undefined && typeof config.taptap[key] !== 'boolean') fail('invalid-config', `runtime.taptap.${key} must be boolean.`);
    for (const key of ['rewardedAdUnitId', 'interstitialAdUnitId']) if (config.taptap[key] !== undefined && (typeof config.taptap[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(config.taptap[key]))) fail('invalid-config', `runtime.taptap.${key} must be a public ad unit identifier.`);
  }
  if (config.saveFlow !== undefined) {
    keys(config.saveFlow, ['enabled', 'platforms', 'autoUpload', 'debounceSeconds'], 'runtime.saveFlow');
    for (const key of ['enabled', 'autoUpload']) if (config.saveFlow[key] !== undefined && typeof config.saveFlow[key] !== 'boolean') fail('invalid-config', `runtime.saveFlow.${key} must be boolean.`);
    if (config.saveFlow.platforms !== undefined && (!Array.isArray(config.saveFlow.platforms) || config.saveFlow.platforms.length > 32 || config.saveFlow.platforms.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(value)) || new Set(config.saveFlow.platforms).size !== config.saveFlow.platforms.length)) fail('invalid-config', 'runtime.saveFlow.platforms must contain distinct platform identifiers.');
    if (config.saveFlow.debounceSeconds !== undefined && (!Number.isFinite(config.saveFlow.debounceSeconds) || config.saveFlow.debounceSeconds < 1 || config.saveFlow.debounceSeconds > 300)) fail('invalid-config', 'runtime.saveFlow.debounceSeconds must be 1..300.');
  }
  if (config.ads !== undefined) {
    keys(config.ads, ['enabled', 'placements', 'interstitialCooldownSeconds'], 'runtime.ads');
    if (config.ads.enabled !== undefined && typeof config.ads.enabled !== 'boolean') fail('invalid-config', 'runtime.ads.enabled must be boolean.');
    if (config.ads.placements !== undefined && (!object(config.ads.placements) || Object.keys(config.ads.placements).length > 128 || Object.entries(config.ads.placements).some(([key, value]) => !/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || !['rewarded', 'interstitial'].includes(value)))) fail('invalid-config', 'runtime.ads.placements must map business identifiers to rewarded or interstitial.');
    if (config.ads.interstitialCooldownSeconds !== undefined && (!Number.isFinite(config.ads.interstitialCooldownSeconds) || config.ads.interstitialCooldownSeconds < 120 || config.ads.interstitialCooldownSeconds > 86400)) fail('invalid-config', 'runtime.ads.interstitialCooldownSeconds must be 120..86400.');
  }
}

export function runtimeWebFiles(platform) {
  const files = ['fwb-web.js'];
  if (platform === 'poki') files.push('fwb-poki.js');
  if (platform === 'taptap-h5') files.push('fwb-taptap.js');
  return files.map(destination => ({ source: path.join(packageRoot, 'runtime/web', destination), destination }));
}

export function runtimeHeadScripts(platform) {
  const scripts = ['fwb-web.js'];
  if (platform === 'poki') scripts.push('https://game-cdn.poki.com/scripts/v2/poki-sdk.js', 'fwb-poki.js');
  if (platform === 'taptap-h5') scripts.push('fwb-taptap.js');
  return scripts;
}

function registerAutoload(source) {
  const current = sectionValue(source, 'autoload', 'FwbPlatform');
  if (current && current !== '*res://addons/fwb/platform.gd') fail('runtime-autoload-conflict', 'FwbPlatform is already registered to a different script.');
  if (current) return source;
  const line = 'FwbPlatform="*res://addons/fwb/platform.gd"';
  if (/^\[autoload\]\s*$/m.test(source)) return source.replace(/^(\[autoload\])\s*$/m, `$1\n${line}`);
  return `${source.trimEnd()}\n\n[autoload]\n${line}\n`;
}

/** Build staging by default; development refuses to overwrite unowned or edited files. */
export function installRuntimeAddon(stage, { platform = 'web', config = {}, development = false } = {}) {
  validateRuntimeConfig(config);
  if (typeof platform !== 'string' || !/^[a-z][a-z0-9-]*$/.test(platform)) fail('invalid-runtime-platform', 'Invalid runtime platform.');
  const root = physicalPath(stage);
  const projectFile = child(root, 'project.godot');
  const projectText = registerAutoload(fs.readFileSync(projectFile, 'utf8'));
  const source = path.join(packageRoot, 'runtime/addons/fwb');
  const installFile = child(root, '.fwb-runtime-install.json');
  const previous = development && fs.existsSync(installFile) ? readJson(installFile) : null;
  const inputs = walk(source).map(relative => ({ path: `addons/fwb/${relative}`, data: fs.readFileSync(path.join(source, relative)) }));
  inputs.push({ path: 'fwb.runtime.json', data: Buffer.from(JSON.stringify({ ...config, platform }, null, 2) + '\n') });
  // Verify the entire set before writing any file. A local editor customization is never silently discarded.
  for (const input of inputs) {
    const destination = child(root, input.path);
    if (!development || !fs.existsSync(destination)) continue;
    const current = fileDigest(destination);
    if (current === digest(input.data)) continue;
    if (!previous?.files?.some(file => file.path === input.path && file.sha256 === current)) fail('runtime-file-conflict', `Runtime file has unowned changes: ${input.path}`);
  }
  const files = inputs.map(input => {
    const destination = child(root, input.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, input.data);
    return { path: input.path, sha256: digest(input.data) };
  });
  fs.writeFileSync(projectFile, projectText);
  const result = { sha256: digest(JSON.stringify(files)), files };
  if (development) atomicJson(installFile, { schemaVersion: 1, platform, ...result });
  return result;
}
