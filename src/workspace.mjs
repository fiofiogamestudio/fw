import fs from 'node:fs';
import path from 'node:path';
import { fail, git } from './process.mjs';

export const ids = Object.freeze(['fwc', 'fwe', 'fwa', 'fws']);
export const presets = Object.freeze({
  godot: ['fwc'],
  'godot-agent': ['fwc', 'fwe', 'fwa'],
  'agent-ui': ['fwe', 'fwa'],
  agent: ['fwa'],
  editor: ['fwe'],
  workbench: [...ids],
});
export const manifestName = 'fw.workspace.json';

export function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { fail('invalid-json', `Cannot read ${filename}: ${error.message}`); }
}

function keys(value, allowed, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-manifest', `${context} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('invalid-manifest', `Unknown ${context} field: ${key}`);
}

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f:]/.test(value) || path.isAbsolute(value) || /^[\\/]/.test(value)) fail('unsafe-path', `Expected a project-relative path: ${value}`);
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part))) fail('unsafe-path', `Non-canonical or protected path: ${value}`);
  return parts.join('/');
}

export function safeChild(root, value) {
  const rel = relativePath(value);
  let cursor = fs.realpathSync.native(root);
  for (const part of rel.split('/')) {
    cursor = path.join(cursor, part);
    let info;
    try { info = fs.lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info?.isSymbolicLink()) fail('linked-path', `Component/config path cannot traverse a link: ${cursor}`);
  }
  return cursor;
}

export function assertPhysicalDirectory(root) {
  // Inspect links directly: native realpath also expands legitimate NTFS 8.3
  // aliases, so a textual spelling change is not evidence of a junction.
  let cursor = path.resolve(root);
  while (true) {
    let info;
    try { info = fs.lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info?.isSymbolicLink()) fail('linked-path', 'Project directory cannot be routed through a symlink/junction.');
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function pathIdentity(value) {
  const physical = fs.realpathSync.native(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? physical.toLowerCase() : physical;
}

export function validateManifest(value) {
  keys(value, ['schemaVersion', 'preset', 'components', 'editor'], 'workspace');
  if (value.schemaVersion !== 1) fail('invalid-manifest', 'Unsupported workspace schemaVersion; expected 1.');
  if (!Object.hasOwn(presets, value.preset)) fail('invalid-manifest', `Unknown preset: ${value.preset}`);
  if (!Array.isArray(value.components) || value.components.length === 0 || value.components.some(id => !ids.includes(id)) || new Set(value.components).size !== value.components.length) fail('invalid-manifest', 'components must contain unique known component IDs.');
  if (value.editor !== undefined) {
    keys(value.editor, ['kind', 'app'], 'editor');
    if (!['fwa', 'fwe'].includes(value.editor.kind)) fail('invalid-manifest', 'editor.kind must be fwa or fwe.');
    if (!value.components.includes('fwe') || (value.editor.kind === 'fwa' && !value.components.includes('fwa'))) fail('missing-component', 'The selected editor requires fwe, and the agent console also requires fwa.');
    if (value.editor.app !== undefined) relativePath(value.editor.app);
    if (value.editor.kind === 'fwa' && value.editor.app !== undefined) fail('invalid-manifest', 'The FWA console owns its app; editor.app only applies to FWE.');
  }
  return value;
}

export function makeManifest(preset, extras = [], app) {
  if (!Object.hasOwn(presets, preset)) fail('unknown-preset', `Choose a preset: ${Object.keys(presets).join(', ')}`);
  if (extras.some(id => !ids.includes(id))) fail('unknown-component', 'Unknown component in --with.');
  const components = ids.filter(id => presets[preset].includes(id) || extras.includes(id));
  const value = { schemaVersion: 1, preset, components };
  if (components.includes('fwe')) value.editor = components.includes('fwa') ? { kind: 'fwa' } : { kind: 'fwe', ...(app ? { app } : {}) };
  else if (app) fail('missing-component', '--editor-app requires fwe.');
  if (app && value.editor?.kind === 'fwa') fail('invalid-manifest', '--editor-app cannot replace the FWA console app.');
  return validateManifest(value);
}

export function findWorkspace(start) {
  let root = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(root, manifestName))) return root;
    if (fs.existsSync(path.join(root, '.git')) || path.dirname(root) === root) fail('workspace-not-found', `No ${manifestName} at this Git workspace. Run fw init explicitly.`);
    root = path.dirname(root);
  }
}

export function assertGitRoot(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']).stdout;
  if (pathIdentity(top) !== pathIdentity(root)) fail('not-git-root', `Expected a Git root, not a directory inside another repository: ${root}`);
}

function parseModules(raw) {
  const entries = new Map();
  for (const item of raw.split('\0').filter(Boolean)) {
    const newline = item.indexOf('\n');
    if (newline < 0) fail('invalid-gitmodules', 'Invalid git config output.');
    const [, name, key] = /^submodule\.(.+)\.(path|url)$/.exec(item.slice(0, newline)) ?? [];
    if (!name) continue;
    const entry = entries.get(name) ?? { name };
    if (entry[key] !== undefined) fail('invalid-gitmodules', `Duplicate ${key} for ${name}.`);
    entry[key] = item.slice(newline + 1);
    entries.set(name, entry);
  }
  return [...entries.values()];
}

export function moduleDefinitions(root, committed = false) {
  const source = committed ? ['--blob', 'HEAD:.gitmodules'] : ['-f', path.join(root, '.gitmodules')];
  if (!committed && !fs.existsSync(path.join(root, '.gitmodules'))) return [];
  const output = git(root, ['config', '-z', ...source, '--get-regexp', '^submodule\\..*\\.(path|url)$'], true);
  if (output.status === 1 && !output.stderr) return [];
  if (output.status !== 0) fail('invalid-gitmodules', `Cannot read ${committed ? 'committed ' : ''}.gitmodules: ${output.stderr}`);
  const definitions = parseModules(output.stdout);
  const seen = new Set();
  const paths = [];
  for (const entry of definitions) {
    if (!entry.path || !entry.url) fail('invalid-gitmodules', `Missing path/url for ${entry.name}.`);
    entry.path = relativePath(entry.path);
    const canonical = entry.path.toLowerCase();
    if (paths.some(other => canonical === other || canonical.startsWith(`${other}/`) || other.startsWith(`${canonical}/`))) fail('overlapping-components', 'Submodule paths overlap or repeat.');
    paths.push(canonical);
    const remoteId = /(?:[/:])fiofiogamestudio\/(fwc|fwe|fwa|fws)(?:\.git)?\/?$/i.exec(entry.url)?.[1]?.toLowerCase();
    entry.id = remoteId ?? (ids.includes(entry.name) ? entry.name : null);
    if (entry.id && seen.has(entry.id)) fail('duplicate-component', `Multiple registrations for ${entry.id}; use one direct component.`);
    if (entry.id) seen.add(entry.id);
  }
  return definitions;
}

export function gitlink(root, rel, source = 'HEAD') {
  const result = source === 'index' ? git(root, ['ls-files', '--stage', '--', rel], true) : git(root, ['ls-tree', source, '--', rel], true);
  const pattern = source === 'index' ? /^160000 ([a-f0-9]{40,64}) 0\t/ : /^160000 commit ([a-f0-9]{40,64})\t/;
  return pattern.exec(result.stdout)?.[1] ?? null;
}

export function releaseCatalog(root, selected) {
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg.name !== 'fw' || pkg.fwWorkspace !== true) fail('not-fw', 'The bootstrap source must be the top-level FW repository.');
  assertGitRoot(root);
  const defs = moduleDefinitions(root, true);
  return selected.map(id => {
    const definition = defs.find(item => item.id === id);
    if (!definition) fail('unpublished-component', `FW HEAD has no registered ${id}; commit a tested bundle first.`);
    const revision = gitlink(root, definition.path);
    if (!revision) fail('unpublished-component', `FW HEAD has no pinned ${id}; no floating fallback is allowed.`);
    return { id, url: definition.url, revision, path: id };
  });
}

export function bindings(root, manifest) {
  assertGitRoot(root);
  const defs = moduleDefinitions(root);
  const result = [];
  for (const id of manifest.components) {
    const definition = defs.find(item => item.id === id);
    if (!definition) fail('missing-component', `${id} is not registered in .gitmodules. Run fw deps install --apply.`);
    const location = safeChild(root, definition.path);
    if (!fs.existsSync(path.join(location, '.git'))) fail('missing-component', `${id} is not initialized: ${location}. Run fw deps sync --apply (or install before the first commit).`);
    assertGitRoot(location);
    const origin = git(location, ['remote', 'get-url', 'origin'], true);
    if (origin.status !== 0 || canonicalRepository(origin.stdout) !== canonicalRepository(definition.url)) fail('source-conflict', `${id} origin differs from its registered source.`);
    if (id === 'fwc') {
      if (!fs.existsSync(path.join(location, 'csharp/FwGen/FwGen.csproj'))) fail('identity-mismatch', 'FWC generator marker is missing.');
    } else if (readJson(path.join(location, 'package.json')).name !== id) fail('identity-mismatch', `Expected ${id} package at ${location}.`);
    // A component may have unrelated dependencies, but never another FW-family registration.
    if (moduleDefinitions(location).some(item => item.id)) fail('nested-component', `${id} nests an FW component. Keep FW components directly under the host.`);
    result.push({ ...definition, root: location, committed: gitlink(root, definition.path), index: gitlink(root, definition.path, 'index'), actual: git(location, ['rev-parse', 'HEAD']).stdout, dirty: Boolean(git(location, ['status', '--porcelain']).stdout) });
  }
  return result;
}

export function canonicalRepository(value) {
  const github = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)\/?$/i.exec(value);
  if (github) return `github.com/${github[1]}/${github[2].replace(/\.git$/i, '')}`.toLowerCase();
  if (fs.existsSync(value)) return pathIdentity(value);
  return value.replace(/\/$/, '');
}
