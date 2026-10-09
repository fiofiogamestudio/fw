import fs from 'node:fs';
import path from 'node:path';
import { child, fail, fileDigest, physicalPath, readJson } from './files.mjs';
import { getTarget } from '../platforms.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateRelativeAssetPath(value, label = 'Asset path') {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\:*?\x00-\x1f]/.test(value)
    || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    fail('invalid-config', `${label} must be a relative file path without traversal or wildcards.`);
  }
}

function validateList(value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 10000) fail('invalid-config', `${label} must be an array of at most 10000 files.`);
  for (const item of value) {
    if (!plain(item) || Object.keys(item).some(key => !['source', 'destination'].includes(key))) fail('invalid-config', `${label} entries require source and destination.`);
    validateRelativeAssetPath(item.source, `${label}.source`);
    validateRelativeAssetPath(item.destination, `${label}.destination`);
  }
}

export function resolveExternalAssets(config, target) {
  if (getTarget(target)?.family !== 'web') return [];
  const selected = config.targets?.[target]?.externalAssets;
  if (selected === false) return [];
  const result = [...(config.externalAssets ?? []), ...(selected ?? [])];
  uniqueDestinations(result);
  return result;
}

function uniqueDestinations(result) {
  const destinations = new Set();
  for (const item of result) {
    const key = item.destination.toLowerCase();
    if (destinations.has(key)) fail('invalid-config', `Duplicate external asset destination: ${item.destination}`);
    destinations.add(key);
  }
}

export function validateExternalAssets(config) {
  validateList(config.externalAssets, 'externalAssets');
  for (const [target, options] of Object.entries(config.targets ?? {})) {
    if (options.externalAssets !== false) validateList(options.externalAssets, `${target}.externalAssets`);
    if (options.externalAssetsManifest !== undefined) {
      validateRelativeAssetPath(options.externalAssetsManifest, `${target}.externalAssetsManifest`);
      if (!options.externalAssetsManifest.endsWith('.json') || options.externalAssetsManifest.includes(',') || getTarget(target)?.family !== 'web') fail('invalid-config', 'externalAssetsManifest requires a browser Web/H5 target and a project-relative JSON file without commas.');
    }
    if (options.externalAssets && getTarget(target)?.family !== 'web') fail('invalid-config', 'externalAssets are only supported for browser Web/H5 output, not native or mini-game packages.');
    resolveExternalAssets(config, target);
  }
}

export function copyExternalAssets(project, stage, out, target) {
  const assets = resolveExternalAssets(project.config, target);
  const manifest = project.config.targets?.[target]?.externalAssetsManifest;
  if (manifest) {
    const value = readJson(child(stage, manifest));
    if (value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'files'].includes(key))) fail('invalid-external-manifest', 'External asset manifest requires schemaVersion 1 and files.');
    validateList(value.files, 'externalAssetsManifest.files');
    if (!Array.isArray(value.files)) fail('invalid-external-manifest', 'External asset manifest requires files.');
    assets.push(...value.files); uniqueDestinations(assets);
  }
  if (!assets.length) return [];
  const snapshot = physicalPath(stage), output = physicalPath(out);
  if (snapshot === physicalPath(project.root) || output === physicalPath(project.root) || snapshot === output || path.dirname(snapshot) !== path.dirname(output)) {
    fail('unsafe-stage', 'External assets require separate snapshot and output directories in the same artifact.');
  }
  const copies = assets.map(item => {
    const source = child(snapshot, item.source), destination = child(output, item.destination);
    if (!fs.statSync(source).isFile() || fs.statSync(source).size === 0) fail('external-asset-missing', `Missing or empty external asset: ${item.source}`);
    if (fs.existsSync(destination)) fail('external-asset-collision', `External asset would overwrite an output: ${item.destination}`);
    return { ...item, sourceFile: source, destinationFile: destination, size: fs.statSync(source).size, sha256: fileDigest(source) };
  });
  for (const item of copies) {
    fs.mkdirSync(path.dirname(item.destinationFile), { recursive: true });
    fs.copyFileSync(item.sourceFile, item.destinationFile, fs.constants.COPYFILE_EXCL);
    if (fs.statSync(item.destinationFile).size !== item.size || fileDigest(item.destinationFile) !== item.sha256 || fileDigest(item.sourceFile) !== item.sha256) {
      fail('external-asset-changed', `External asset changed while copying: ${item.source}`);
    }
  }
  return copies.map(({ source, destination, size, sha256 }) => ({ source, destination, size, sha256 }));
}
