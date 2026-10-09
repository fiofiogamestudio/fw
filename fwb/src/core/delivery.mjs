import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createDeflateRaw } from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { atomicJson, child, fail, fileDigest, outputsFingerprint, physicalPath, readJson, walk } from './files.mjs';
import { readArtifact, validateArtifact } from './build.mjs';
import { runProcess } from './process.mjs';
import { validateRelativeAssetPath } from './external-assets.mjs';
import { inputFiles } from './project.mjs';
import { zipPolicy, validateZipSize } from './zip-policy.mjs';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
const zipLimit = 0xffffffff;

/** ZIP32 with deflate and data descriptors; payloads never accumulate in memory. */
export async function streamZip(filename, root, records, { signal } = {}) {
  if (!Array.isArray(records)) fail('invalid-package', 'ZIP input must be recorded files.');
  const names = new Set();
  for (const record of records) {
    validateRelativeAssetPath(record.path, 'ZIP entry');
    if (names.has(record.path) || !Number.isSafeInteger(record.size) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) fail('invalid-package', 'ZIP entries must have unique paths, byte counts and SHA-256 identities.');
    names.add(record.path);
  }
  if (records.length > 60000 || records.some(item => item.size >= zipLimit) || records.reduce((n, item) => n + item.size, 0) >= zipLimit) fail('package-too-large', 'Streaming ZIP32 supports fewer than 60001 files and less than 4 GiB; use directory delivery for larger packages.');
  const handle = await fs.promises.open(physicalPath(filename), 'wx');
  const central = []; let offset = 0;
  const write = async buffer => {
    if (offset + buffer.length >= zipLimit) fail('package-too-large', 'ZIP32 archive exceeds 4 GiB; use directory delivery.');
    let position = 0;
    while (position < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, position, buffer.length - position, offset);
      if (!bytesWritten) throw new Error('Unable to write the delivery archive.');
      position += bytesWritten; offset += bytesWritten;
    }
  };
  try {
    for (const record of records) {
      signal?.throwIfAborted();
      const file = child(root, record.path), name = Buffer.from(record.path, 'utf8');
      if (name.length > 65535 || !fs.statSync(file).isFile() || fs.statSync(file).size !== record.size) fail('changed-output', `Archive input changed: ${record.path}`);
      const localOffset = offset, header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x808, 6); header.writeUInt16LE(8, 8);
      header.writeUInt16LE(33, 12); header.writeUInt16LE(name.length, 26);
      await write(header); await write(name);
      let crc = 0xffffffff, bytes = 0;
      const hash = createHash('sha256'), compressedStart = offset;
      const inspect = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length; hash.update(chunk);
        for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
        callback(null, chunk);
      } });
      const destination = new Writable({ write(chunk, _encoding, callback) { write(chunk).then(() => callback(), callback); } });
      await pipeline(fs.createReadStream(file), inspect, createDeflateRaw({ level: 9 }), destination, { signal });
      if (bytes !== record.size || hash.digest('hex') !== record.sha256) fail('changed-output', `Archive input changed while reading: ${record.path}`);
      const compressed = offset - compressedStart; crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(bytes, 12);
      await write(descriptor);
      const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x808, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14);
      entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed, 20); entry.writeUInt32LE(bytes, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(localOffset, 42);
      central.push(entry, name);
    }
    const centralOffset = offset;
    for (const part of central) await write(part);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10); end.writeUInt32LE(offset - centralOffset, 12); end.writeUInt32LE(centralOffset, 16);
    await write(end); await handle.sync();
  } finally { await handle.close(); }
  return { path: path.basename(filename), size: fs.statSync(filename).size, sha256: fileDigest(filename), format: 'zip32-deflate' };
}

/** Create an immutable local handoff; this does not upload, submit, or publish. */
export async function deliverArtifact(root, id, { destination, zip = false, latest = true, signal } = {}) {
  if (typeof destination !== 'string' || !destination) fail('missing-destination', 'Specify a delivery parent directory.');
  if (!(await validateArtifact(root, id)).ok) fail('invalid-package', 'Delivery requires an intact built artifact that meets its budgets.');
  const artifact = readArtifact(root, id);
  const parent = physicalPath(path.resolve(root, destination));
  if (parent === artifact.directory || parent.startsWith(artifact.directory + path.sep)) fail('unsafe-delivery', 'Delivery cannot be placed inside the source artifact.');
  fs.mkdirSync(parent, { recursive: true });
  const final = child(parent, id), lock = child(parent, `${id}.delivery.lock`);
  if (fs.existsSync(final)) fail('delivery-exists', `Existing delivery is preserved: ${final}`);
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, artifactId: id }), { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') fail('delivery-busy', 'A delivery lock exists; inspect that operation before retrying.'); throw error; }
  const temporary = child(parent, `.${id}.${randomUUID()}.partial`);
  const game = child(temporary, 'game'), evidence = child(temporary, 'evidence');
  try {
    if (fs.existsSync(final)) fail('delivery-exists', `Existing delivery is preserved: ${final}`);
    fs.mkdirSync(game, { recursive: true }); fs.mkdirSync(evidence);
    const files = [];
    for (const output of artifact.outputs) {
      signal?.throwIfAborted();
      if (!output.path.startsWith('out/')) fail('invalid-output', 'Delivery outputs must be in out/.');
      const relative = output.path.slice(4), source = child(artifact.directory, output.path), target = child(game, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (!fs.statSync(target).isFile() || fs.statSync(target).size !== output.size || fileDigest(target) !== output.sha256) fail('changed-output', `Delivery copy differs from the artifact: ${relative}`);
      files.push({ path: relative, size: output.size, sha256: output.sha256 });
    }
    let hostValidation = null;
    if (artifact.deliveryValidation) {
      const hook = artifact.deliveryValidation, stage = child(artifact.directory, 'project'), script = child(stage, hook.script);
      if (fileDigest(script) !== hook.sha256) fail('changed-validation-script', 'Frozen delivery validation script changed; rebuild before delivering.');
      if (hook.inputs) {
        const indexFile = child(artifact.directory, hook.inputs.path);
        if (fileDigest(indexFile) !== hook.inputs.sha256) fail('changed-validation-inputs', 'Frozen validation input index changed.');
        const index = readJson(indexFile);
        if (index.schemaVersion !== 1 || !Array.isArray(index.files) || !Array.isArray(index.exclude)) fail('invalid-validation-inputs', 'Invalid frozen validation input index.');
        const actual = new Set(inputFiles(stage, { exclude: index.exclude }));
        if (actual.size !== index.files.length || index.files.some(file => !actual.has(file.path) || fs.statSync(child(stage, file.path)).size !== file.size || fileDigest(child(stage, file.path)) !== file.sha256)) fail('changed-validation-inputs', 'Frozen validation dependencies changed; rebuild before delivering.');
      }
      const reportFile = child(evidence, 'host-validation.json');
      await runProcess(process.execPath, [script, '--project', stage, '--output', game, '--target', artifact.target, '--profile', artifact.profile, '--report', reportFile], {
        cwd: stage, logFile: child(evidence, 'host-validation.log'), timeoutSeconds: 900, signal,
        env: { ...process.env, FWB_SNAPSHOT_ROOT: stage, FWB_OUTPUT_ROOT: game },
      });
      const proof = readJson(reportFile);
      if (proof.schemaVersion !== 1 || proof.ok !== true || !Array.isArray(proof.checks) || !proof.checks.length || proof.checks.some(check => typeof check?.id !== 'string' || check.status !== 'pass')) fail('delivery-validation-failed', 'Host validation must return a nonempty structured report with every check passed.');
      const actual = walk(game);
      if (actual.length !== files.length || files.some(file => !actual.includes(file.path) || fs.statSync(child(game, file.path)).size !== file.size || fileDigest(child(game, file.path)) !== file.sha256)) fail('changed-output', 'Host validation changed the delivery file set or bytes.');
      hostValidation = { script: hook.script, scriptSha256: hook.sha256, inputsSha256: hook.inputs?.sha256 ?? null, path: 'evidence/host-validation.json', sha256: fileDigest(reportFile), result: 'passed' };
    }
    const proofs = new Map(['manifest.json', 'toolchain.json', 'build.log', 'resource-report.json'].map(name => [name, null]));
    if (artifact.resources?.path) proofs.set(artifact.resources.path, artifact.resources.sha256);
    if (artifact.deliveryValidation?.inputs) proofs.set(artifact.deliveryValidation.inputs.path, artifact.deliveryValidation.inputs.sha256);
    for (const item of artifact.evidence ?? []) proofs.set(item.path, item.sha256);
    const evidenceFiles = [];
    if (hostValidation) for (const name of ['host-validation.json', 'host-validation.log']) {
      const file = child(evidence, name);
      if (fs.existsSync(file)) evidenceFiles.push({ path: `evidence/${name}`, size: fs.statSync(file).size, sha256: fileDigest(file) });
    }
    for (const [relative, expected] of proofs) {
      const source = child(artifact.directory, relative);
      if (!fs.existsSync(source)) { if (expected) fail('missing-evidence', `Missing artifact evidence: ${relative}`); continue; }
      const target = child(evidence, relative), sha256 = fileDigest(source);
      if (expected && sha256 !== expected) fail('changed-evidence', `Artifact evidence changed: ${relative}`);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (fileDigest(target) !== sha256) fail('changed-evidence', `Evidence changed while copying: ${relative}`);
      evidenceFiles.push({ path: `evidence/${relative}`, size: fs.statSync(target).size, sha256 });
    }
    let archive = null;
    if (zip) {
      const policy = zipPolicy(artifact);
      const records = policy.rootDirectory ? files.map(file => ({ ...file, path: `${policy.rootDirectory}/${file.path}` })) : files;
      archive = await streamZip(child(temporary, `${artifact.target}.zip`), policy.rootDirectory ? temporary : game, records, { signal });
      validateZipSize(policy, archive.size);
      Object.assign(archive, policy, { deflateLevel: 9 });
    }
    const receipt = { schemaVersion: 1, artifactId: id, target: artifact.target, profile: artifact.profile,
      name: artifact.name, version: artifact.version, buildNumber: artifact.buildNumber, createdAt: new Date().toISOString(),
      outputsSha256: outputsFingerprint(artifact), gameDirectory: 'game', entry: `game/${(artifact.entry ?? 'out/index.html').replace(/^out\//, '')}`,
      files, evidenceFiles, archive, validation: artifact.validation, source: artifact.source ? { sha256: artifact.source.sha256, gitRevision: artifact.source.gitRevision } : null,
      resourceMetrics: artifact.resources?.metrics ?? null, hostValidation, published: false };
    atomicJson(child(temporary, 'delivery.json'), receipt);
    signal?.throwIfAborted();
    if (fs.existsSync(final)) fail('delivery-exists', `Existing delivery is preserved: ${final}`);
    fs.renameSync(temporary, final);
    if (latest) atomicJson(child(parent, 'latest.json'), { schemaVersion: 1, artifactId: id, directory: `${id}/game`, receipt: `${id}/delivery.json` });
    return { ok: true, artifactId: id, directory: final, receipt: path.join(final, 'delivery.json'), archive: archive ? path.join(final, archive.path) : null, published: false };
  } catch (error) {
    if (fs.existsSync(temporary)) {
      try { atomicJson(child(temporary, 'failure.json'), { artifactId: id, error: error.message, completedAt: new Date().toISOString() }); } catch { /* Preserve original failure. */ }
      error.partialDirectory = temporary;
    }
    throw error;
  } finally { fs.unlinkSync(lock); }
}
