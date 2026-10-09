import fs from 'node:fs';
import path from 'node:path';
import { child, fail, readJson, outputsFingerprint } from './files.mjs';
import { validateRelativeAssetPath } from './external-assets.mjs';

const budgetKeys = ['totalBytes', 'maxFileBytes', 'startupBytes', 'decodedBytes'];
export function validateResourceBudgets(options, label = 'target') {
  const budgets = options.budgets;
  if (budgets !== undefined) {
    if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets) || Object.keys(budgets).some(key => !budgetKeys.includes(key))) fail('invalid-config', `${label}.budgets contains unknown limits.`);
    for (const [key, value] of Object.entries(budgets)) if (!Number.isSafeInteger(value) || value < 1) fail('invalid-config', `${label}.budgets.${key} must be a positive byte count.`);
  }
  if (options.startupFiles !== undefined) {
    if (!Array.isArray(options.startupFiles) || !options.startupFiles.length || options.startupFiles.length > 10000) fail('invalid-config', `${label}.startupFiles must contain relative output paths.`);
    const seen = new Set();
    for (const file of options.startupFiles) {
      validateRelativeAssetPath(file, `${label}.startupFiles`);
      if (seen.has(file)) fail('invalid-config', `${label}.startupFiles contains duplicates.`);
      seen.add(file);
    }
  }
}

function groups(entries, key) {
  const grouped = new Map();
  for (const entry of entries) {
    const name = key(entry.path);
    const current = grouped.get(name) ?? { name, files: 0, bytes: 0 };
    current.files++; current.bytes += entry.size; grouped.set(name, current);
  }
  return [...grouped.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

// Read only the unencrypted v2/v3 index; no payload extraction or trust in MD5.
// Unsupported pack formats remain a visible report limitation, not a new build gate.
export function inspectPack(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (offset, count) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || count < 0 || offset + count > size) throw new Error('PCK index exceeds file bounds.');
      const bytes = Buffer.alloc(count);
      if (fs.readSync(fd, bytes, 0, count, offset) !== count) throw new Error('PCK changed while reading its index.');
      return bytes;
    };
    const number64 = (buffer, offset) => {
      const value = buffer.readBigUInt64LE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PCK offset exceeds safe integer bounds.');
      return Number(value);
    };
    const header = read(0, Math.min(size, 104));
    if (header.length < 40 || header.toString('ascii', 0, 4) !== 'GDPC') throw new Error('Not a standalone PCK.');
    const version = header.readUInt32LE(4);
    if (![2, 3].includes(version) || header.readUInt32LE(8) !== 4 || (header.readUInt32LE(20) & ~2)) throw new Error('Only unencrypted Godot 4 PCK v2/v3 indexes are reported.');
    const fileBase = number64(header, 24);
    let cursor = version === 2 ? 96 : number64(header, 32);
    const start = cursor;
    const count = read(cursor, 4).readUInt32LE(); cursor += 4;
    if (count > 200000) throw new Error('PCK has too many entries.');
    const entries = [], names = new Set(), decoder = new TextDecoder('utf-8', { fatal: true });
    for (let i = 0; i < count; i++) {
      const length = read(cursor, 4).readUInt32LE(); cursor += 4;
      if (length < 1 || length > 4096 || cursor - start > 64 * 1024 * 1024) throw new Error('PCK index is too large.');
      const padded = read(cursor, length); cursor += length;
      const zero = padded.indexOf(0);
      if (zero !== -1 && padded.subarray(zero).some(byte => byte !== 0)) throw new Error('PCK path padding is invalid.');
      const name = decoder.decode(zero < 0 ? padded : padded.subarray(0, zero)).replace(/^res:\/\//, '');
      validateRelativeAssetPath(name, 'PCK resource');
      if (names.has(name)) throw new Error('PCK contains duplicate paths.'); names.add(name);
      const metadata = read(cursor, 36); cursor += 36;
      const offset = fileBase + number64(metadata, 0), bytes = number64(metadata, 8);
      if (metadata.readUInt32LE(32) !== 0 || !Number.isSafeInteger(offset + bytes) || offset < fileBase || offset + bytes > size) throw new Error('PCK entry flags or bounds are unsupported.');
      entries.push({ path: name, size: bytes, offset });
    }
    if (entries.some(entry => entry.size && entry.offset < cursor && entry.offset + entry.size > start)) throw new Error('PCK payload overlaps its index.');
    return { status: 'reported', version, files: count, payloadBytes: entries.reduce((n, entry) => n + entry.size, 0),
      byExtension: groups(entries, name => path.posix.extname(name).toLowerCase() || '(none)'),
      byDirectory: groups(entries, name => name.split('/').slice(0, 2).join('/')),
      largest: [...entries].sort((a, b) => b.size - a.size).slice(0, 30).map(({ path: name, size: bytes }) => ({ path: name, bytes })) };
  } catch (error) { return { status: 'unavailable', reason: error.message }; }
  finally { fs.closeSync(fd); }
}

export function resourceReport(artifact, { inspectPacks = true } = {}) {
  const entries = artifact.outputs.map(item => ({ ...item, path: item.path.replace(/^out\//, '') }));
  const totalBytes = entries.reduce((n, item) => n + item.size, 0);
  const startup = artifact.startupFiles ?? entries.map(item => item.path);
  const files = new Map(entries.map(item => [item.path, item]));
  for (const name of startup) if (!files.has(name)) fail('invalid-startup-files', `Startup resource is missing from the artifact: ${name}`);
  let decodedBytes = totalBytes;
  if (files.has('web-delivery.json')) {
    const manifest = readJson(child(artifact.directory, 'out/web-delivery.json'));
    for (const item of [...Object.values(manifest.files ?? {}), ...Object.values(manifest.packs ?? {})]) {
      if (!Number.isSafeInteger(item.bytes) || !Number.isSafeInteger(item.compressedBytes) || !files.has(item.url)) fail('invalid-resource-report', 'Invalid compressed delivery size declaration.');
      decodedBytes += item.bytes - item.compressedBytes;
    }
  }
  const duplicateGroups = new Map();
  for (const entry of entries) {
    const key = `${entry.size}:${entry.sha256}`;
    duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), entry]);
  }
  const report = { schemaVersion: 1, artifactId: artifact.id, outputsSha256: outputsFingerprint(artifact),
    metrics: { totalBytes, maxFileBytes: entries.reduce((n, item) => Math.max(n, item.size), 0), startupBytes: startup.reduce((n, name) => n + files.get(name).size, 0), decodedBytes },
    startup: { basis: artifact.startupFiles ? 'declared' : 'all-outputs-conservative', files: startup },
    byExtension: groups(entries, name => path.posix.extname(name).toLowerCase() || '(none)'),
    byDirectory: groups(entries, name => name.includes('/') ? name.split('/')[0] : '(root)'),
    largest: [...entries].sort((a, b) => b.size - a.size).slice(0, 30).map(({ path: name, size }) => ({ path: name, bytes: size })),
    duplicates: [...duplicateGroups.values()].filter(items => items.length > 1).map(items => ({ bytesEach: items[0].size, sha256: items[0].sha256, files: items.map(item => item.path) })),
    packs: inspectPacks ? entries.filter(item => item.path.endsWith('.pck')).map(item => ({ path: item.path, ...inspectPack(child(artifact.directory, `out/${item.path}`)) })) : [],
    limitations: ['Startup size follows the declared file list, or all outputs when omitted; it is not a measured network trace.', 'Decoded bytes describe delivery representations, not browser or GPU memory.', 'PCK indexing does not prove resources are referenced or safe to remove. Compressed PCK contents are not indexed.'] };
  return report;
}

export function resourceBudgetChecks(artifact, report) {
  validateResourceBudgets(artifact, 'artifact');
  return Object.entries(artifact.budgets ?? {}).map(([key, limit]) => ({ id: `resource-budget:${key}`, status: report.metrics[key] <= limit ? 'pass' : 'fail', message: `${report.metrics[key]} / ${limit} bytes (${key}).` }));
}
