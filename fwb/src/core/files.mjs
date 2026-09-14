import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function physicalPath(value) {
  const full = path.resolve(value);
  let cursor = path.parse(full).root;
  for (const part of path.relative(cursor, full).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail('unsafe-path', `Symbolic links and junctions are not allowed: ${cursor}`);
  }
  return full;
}

export function child(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /[\x00-\x1f:]/.test(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) fail('unsafe-path', 'Use a project-relative path without traversal.');
  const full = path.resolve(root, relative);
  if (!full.startsWith(path.resolve(root) + path.sep)) fail('unsafe-path', 'Path escapes the selected project.');
  return physicalPath(full);
}

export function readJson(file) {
  if (fs.statSync(file).size > 4 * 1024 * 1024) fail('oversize-json', `JSON is too large: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export const digest = value => createHash('sha256').update(value).digest('hex');
export function outputsFingerprint(artifact) {
  return digest(JSON.stringify(artifact.outputs.map(({ path: name, size, sha256 }) => ({ path: name, size, sha256 })).sort((a, b) => a.path.localeCompare(b.path, 'en'))));
}
export function fileDigest(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

export function atomicJson(file, value) {
  physicalPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  try { fs.renameSync(temporary, file); }
  catch (error) { fs.unlinkSync(temporary); throw error; }
}

export function walk(root, { skip = () => false, limit = 200000 } = {}) {
  const result = [];
  function visit(directory, prefix) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (skip(relative, item)) continue;
      if (item.isSymbolicLink()) fail('unsafe-path', `Input contains a link: ${relative}`);
      if (item.isDirectory()) visit(path.join(directory, item.name), relative);
      else if (item.isFile()) result.push(relative);
      if (result.length > limit) fail('too-many-files', 'Project exceeds the build file limit.');
    }
  }
  visit(physicalPath(root), '');
  return result;
}

// Godot ConfigFile/TOML discovery only; FWC validates its full schema itself.
export function sectionValue(text, section, key) {
  let current = '';
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^\[([^\]]+)\]$/);
    if (match) { current = match[1]; continue; }
    if (current !== section) continue;
    const index = line.indexOf('=');
    if (index >= 0 && line.slice(0, index).trim() === key) {
      const raw = line.slice(index + 1).trim();
      if (raw.startsWith('"')) {
        const quoted = raw.match(/^"(?:\\.|[^"\\])*"/);
        if (quoted) return JSON.parse(quoted[0]);
      }
      return raw.replace(/\s+[;#].*$/, '');
    }
  }
  return undefined;
}
