import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { child, digest, readJson } from './files.mjs';

const wasmHeader = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
function validEngineHeader(logical, header, bytes) {
  if (logical === 'index.wasm') return bytes >= 8 && header.subarray(0, 8).equals(wasmHeader);
  // Godot 4 PCK v2 places the directory after its 96-byte header; v3/v4
  // store the directory offset at byte 32. Validate only this fixed prefix.
  // https://github.com/godotengine/godot/blob/master/core/io/file_access_pack.cpp
  if (bytes < 40 || header.length < 40 || header.toString('ascii', 0, 4) !== 'GDPC') return false;
  const version = header.readUInt32LE(4);
  if (![2, 3, 4].includes(version) || header.readUInt32LE(8) !== 4 || header.readBigUInt64LE(24) > BigInt(bytes)) return false;
  const directory = version === 2 ? 96n : header.readBigUInt64LE(32);
  return directory >= (version === 2 ? 96n : 40n) && directory + 4n <= BigInt(bytes);
}

function readHeader(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Expected a regular exported file.');
    const header = Buffer.alloc(Math.min(stat.size, 100));
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) throw new Error('Exported file changed while reading its header.');
    return { header, bytes: stat.size };
  } finally { fs.closeSync(fd); }
}

// Optional gzip delivery is an explicit artifact contract, not a way to omit
// required engine files. Hash both representations and bound every decode.
export function validateWebDelivery(artifact, names) {
  const checks = [];
  const add = (id, passed, message) => checks.push({id, status: passed ? 'pass' : 'fail', message});
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const root = child(artifact.directory, 'out');
  for (const name of ['index.html', 'index.js']) {
    try { add(`web:${name}`, names.has(`out/${name}`) && readHeader(child(root, name)).bytes > 0, `Required nonempty Web output: ${name}`); }
    catch (error) { add(`web:${name}`, false, error.message); }
  }
  if (!names.has('out/web-delivery.json')) {
    for (const name of ['index.wasm', 'index.pck']) {
      try {
        const { header, bytes } = readHeader(child(root, name));
        add(`web:${name}`, names.has(`out/${name}`), `Required Web output: ${name}`);
        add(name === 'index.wasm' ? 'wasm-header' : 'pck-header', validEngineHeader(name, header, bytes), `Valid ${name} header and minimum structure.`);
      } catch (error) { add(`web:${name}`, false, error.message); }
    }
    return checks;
  }
  try {
    const manifestFile = child(root, 'web-delivery.json');
    expect(fs.statSync(manifestFile).size <= 4 * 1024 * 1024, 'Delivery manifest is too large.');
    const manifest = readJson(manifestFile);
    expect(manifest.schemaVersion === 1 && manifest.encoding === 'gzip', 'Unsupported Web delivery manifest.');
    expect(manifest.files && Object.keys(manifest.files).sort().join(',') === 'index.pck,index.wasm', 'Delivery must identify the engine and main PCK.');
    expect(manifest.packs === undefined || (manifest.packs && typeof manifest.packs === 'object' && !Array.isArray(manifest.packs)), 'Invalid deferred pack map.');
    const urls = new Set();
    const records = [...Object.entries(manifest.files), ...Object.entries(manifest.packs ?? {}).map(([id, value]) => [`pack:${id}`, value])];
    expect(records.length <= 4096, 'Too many delivery files.');
    let totalDecoded = 0;
    for (const [logical, item] of records) {
      expect(item && typeof item.url === 'string' && /^[a-zA-Z0-9_./-]+\.gz$/.test(item.url) && !item.url.startsWith('/') && item.url.split('/').every(part => part && part !== '.' && part !== '..'), `Invalid gzip path: ${logical}`);
      expect(!urls.has(item.url) && names.has(`out/${item.url}`), `Missing or duplicate gzip output: ${logical}`); urls.add(item.url);
      expect(Number.isSafeInteger(item.bytes) && item.bytes >= 4 && item.bytes <= 256 * 1024 * 1024 && Number.isSafeInteger(item.compressedBytes) && item.compressedBytes > 0, `Invalid byte limits: ${logical}`);
      totalDecoded += item.bytes;
      expect(totalDecoded <= 1024 * 1024 * 1024, 'Decoded delivery exceeds 1 GiB.');
      expect(/^[a-f0-9]{64}$/.test(item.sha256) && /^[a-f0-9]{64}$/.test(item.gzipSha256), `Invalid hashes: ${logical}`);
      const filename = child(root, item.url);
      expect(fs.statSync(filename).size === item.compressedBytes, `Gzip size mismatch: ${logical}`);
      const encoded = fs.readFileSync(filename);
      expect(digest(encoded) === item.gzipSha256, `Gzip hash mismatch: ${logical}`);
      const decoded = gunzipSync(encoded, {maxOutputLength: item.bytes});
      expect(decoded.length === item.bytes && digest(decoded) === item.sha256, `Decoded identity mismatch: ${logical}`);
      expect(validEngineHeader(logical, decoded, decoded.length), `Invalid decoded header or minimum structure: ${logical}`);
      if (!logical.startsWith('pack:')) expect(!names.has(`out/${logical}`), `Duplicate raw/gzip engine output: ${logical}`);
      add(`web-gzip:${logical}`, true, `${item.compressedBytes} compressed / ${item.bytes} decoded bytes, verified.`);
    }
    add('web-delivery', true, 'Explicit gzip engine/core and deferred packs are intact.');
  } catch (error) { add('web-delivery', false, error.message); }
  return checks;
}
