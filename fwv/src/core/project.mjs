import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { imageMime, inspectImage, processImageBuffer } from '../image/processor.mjs';

export const PROJECT_FILE = 'fwv.project.json';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_REVISION_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const createId = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function safeFileName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120 || value === '.' || value === '..' ||
      /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error('File name must be a safe basename of 1 to 120 characters.');
  }
  return value;
}

function safeId(value, prefix) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value)) throw new Error(`Invalid ${prefix} ID.`);
  return value;
}

function displayName(value, fallback) {
  const result = value ?? fallback;
  if (typeof result !== 'string' || !result.trim() || result.length > 160 || /[\x00-\x1f]/.test(result)) throw new Error('Name must contain 1 to 160 readable characters.');
  return result.trim();
}

function jsonValue(value, fallback = {}) {
  const serialized = JSON.stringify(value ?? fallback);
  if (!serialized || Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Metadata or recipe exceeds the 1 MiB limit.');
  const parsed = JSON.parse(serialized);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Metadata and recipe must be JSON objects.');
  return parsed;
}

export function normalizeFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 64) throw new Error('A revision must contain between 1 and 64 files.');
  let bytes = 0;
  const names = new Set();
  return files.map((file) => {
    const name = safeFileName(file.name);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate file name: ${name}.`);
    names.add(key);
    if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0 || file.buffer.length > MAX_FILE_BYTES) throw new Error('Each file must be a nonempty Buffer of at most 32 MiB.');
    bytes += file.buffer.length;
    if (bytes > MAX_REVISION_BYTES) throw new Error('Revision files exceed the 128 MiB limit.');
    if (typeof file.role !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(file.role)) throw new Error('File role must be a lowercase identifier.');
    if (typeof file.mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.mime)) throw new Error('Invalid file MIME type.');
    // Snapshot caller-owned bytes before any await to protect recorded hashes.
    return { name, role: file.role, mime: file.mime, buffer: Buffer.from(file.buffer) };
  });
}

export class FwvProject {
  constructor(projectRoot) {
    if (typeof projectRoot !== 'string' || !projectRoot.trim()) throw new Error('A project directory is required.');
    this.root = path.resolve(projectRoot);
  }

  async _assertRoot({ create = false } = {}) {
    if (create) {
      let ancestor = path.parse(this.root).root;
      for (const part of path.relative(ancestor, this.root).split(path.sep).filter(Boolean)) {
        ancestor = path.join(ancestor, part);
        try {
          if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('Project root must not traverse a symbolic link or junction.');
        } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      }
      await fs.mkdir(this.root, { recursive: true });
    }
    const stat = await fs.lstat(this.root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Project root must be a real directory, not a symbolic link.');
    // Reject aliases through symlink/junction ancestors as well as direct links.
    const resolved = await fs.realpath(this.root);
    const same = process.platform === 'win32' ? resolved.toLowerCase() === this.root.toLowerCase() : resolved === this.root;
    if (!same) throw new Error('Project root must not traverse a symbolic link or junction.');
  }

  async _path(parts, { mkdir = false } = {}) {
    await this._assertRoot();
    let target = this.root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = safeFileName(parts[i]);
      target = path.join(target, part);
      let stat;
      try { stat = await fs.lstat(target); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (mkdir) {
          try { await fs.mkdir(target); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
          stat = await fs.lstat(target);
        }
      }
      if (stat?.isSymbolicLink()) throw new Error('Symbolic links and junctions are not allowed in project storage.');
      if (stat && (mkdir || i < parts.length - 1) && !stat.isDirectory()) throw new Error('Expected a directory in project storage.');
    }
    return target;
  }

  async _withLock(work, { create = false } = {}) {
    await this._assertRoot({ create });
    const lockPath = await this._path(['.fwv.lock']);
    const deadline = Date.now() + 10000;
    while (true) {
      try { await fs.mkdir(lockPath); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this._path(['.fwv.lock']);
        if (Date.now() >= deadline) throw new Error('Project is locked by another writer. If a process crashed, remove .fwv.lock only after confirming no FWV writer is running.');
        await delay(40);
      }
    }
    try { return await work(); } finally { await fs.rmdir(lockPath); }
  }

  async _load() {
    const file = await this._path([PROJECT_FILE]);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('Project manifest is not a file or exceeds 16 MiB.');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data.assets) || !Array.isArray(data.exports)) throw new Error('Unsupported or invalid FWV project manifest.');
    safeId(data.id, 'project');
    return data;
  }

  async _save(data) {
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) throw new Error('Project manifest exceeds the 16 MiB limit.');
    const target = await this._path([PROJECT_FILE]);
    const temp = await this._path([`.fwv-${randomUUID()}.tmp`]);
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      // Windows readers and antivirus scanners can briefly deny replacing an
      // existing file. Retry the same atomic rename while retaining the writer
      // lock; never unlink the live manifest to work around a sharing violation.
      const deadline = Date.now() + 1500;
      let retry = 0;
      while (true) {
        try { await fs.rename(temp, target); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw error;
          await delay(Math.min(25 * (2 ** retry++), 200, remaining));
        }
      }
    } finally {
      await fs.unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  _asset(data, assetId) {
    safeId(assetId, 'asset');
    const asset = data.assets.find((entry) => entry.id === assetId);
    if (!asset) throw new Error(`Asset does not exist: ${assetId}.`);
    return asset;
  }

  _revision(asset, revisionId) {
    const selected = revisionId ?? asset.selectedRevisionId;
    safeId(selected, 'rev');
    const revision = asset.revisions.find((entry) => entry.id === selected);
    if (!revision) throw new Error(`Revision does not exist: ${selected}.`);
    return revision;
  }

  async _writeRevision(assetId, { parentId = null, files, metadata = {}, recipe = {} }) {
    const id = createId('rev');
    const revision = { id, parentId, createdAt: now(), recipe: jsonValue(recipe), metadata: jsonValue(metadata), files: [], validation: null };
    await this._path(['assets', safeId(assetId, 'asset'), id], { mkdir: true });
    for (const file of files) {
      const target = await this._path(['assets', assetId, id, file.name]);
      await fs.writeFile(target, file.buffer, { flag: 'wx' });
      revision.files.push({ name: file.name, role: file.role, mime: file.mime, sha256: sha256(file.buffer), bytes: file.buffer.length });
    }
    return revision;
  }

  async _readFile(assetId, revisionId, file) {
    const target = await this._path(['assets', safeId(assetId, 'asset'), safeId(revisionId, 'rev'), safeFileName(file.name)]);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size !== file.bytes) throw new Error(`Artifact size mismatch: ${file.name}.`);
    const buffer = await fs.readFile(target);
    if (sha256(buffer) !== file.sha256) throw new Error(`Artifact hash mismatch: ${file.name}.`);
    return buffer;
  }

  async init({ name } = {}) {
    return this._withLock(async () => {
      const target = await this._path([PROJECT_FILE]);
      try { await fs.access(target); throw new Error('FWV project already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const data = { schemaVersion: 1, id: createId('project'), name: displayName(name, path.basename(this.root)), assets: [], exports: [] };
      await this._save(data);
      return clone(data);
    }, { create: true });
  }

  async snapshot() { return clone(await this._load()); }

  async importAsset({ name, kind, files, metadata = {}, recipe = {}, idempotencyKey }) {
    const normalizedFiles = normalizeFiles(files);
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(kind)) throw new Error('Asset kind must be a lowercase identifier.');
    const normalizedName = displayName(name, normalizedFiles[0].name);
    const normalizedMetadata = jsonValue(metadata);
    const normalizedRecipe = jsonValue(recipe);
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 160 || /[\x00-\x1f]/.test(idempotencyKey))) throw new Error('Import idempotency key must contain 1 to 160 readable characters.');
    const fingerprint = idempotencyKey === undefined ? null : sha256(Buffer.from(JSON.stringify(canonical({ name: normalizedName, kind, metadata: normalizedMetadata, recipe: normalizedRecipe,
      files: normalizedFiles.map(file => ({ name: file.name, role: file.role, mime: file.mime, bytes: file.buffer.length, sha256: sha256(file.buffer) })).sort((a, b) => a.name.localeCompare(b.name)) }))));
    return this._withLock(async () => {
      const data = await this._load();
      const existing = idempotencyKey === undefined ? null : data.assets.find(asset => asset.importReceipt?.key === idempotencyKey);
      if (existing) {
        if (existing.importReceipt.fingerprint !== fingerprint) throw Object.assign(new Error('Import key already belongs to different content.'), { status: 409, code: 'IMPORT_KEY_CONFLICT' });
        const imported = this._revision(existing, existing.importReceipt.revisionId);
        for (const file of imported.files) await this._readFile(existing.id, imported.id, file);
        return clone(existing);
      }
      const id = createId('asset');
      const revision = await this._writeRevision(id, { files: normalizedFiles, metadata: normalizedMetadata, recipe: normalizedRecipe });
      const asset = { id, name: normalizedName, kind, selectedRevisionId: revision.id, revisions: [revision] };
      if (idempotencyKey !== undefined) asset.importReceipt = { key: idempotencyKey, fingerprint, revisionId: revision.id };
      data.assets.push(asset);
      await this._save(data);
      return clone(asset);
    });
  }

  async importImage({ name, fileName, buffer }) {
    safeFileName(fileName);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_FILE_BYTES) throw new Error('Image must be a nonempty Buffer of at most 32 MiB.');
    const original = Buffer.isBuffer(buffer) ? Buffer.from(buffer) : buffer;
    const image = await inspectImage(original);
    return this.importAsset({ name, kind: 'image', files: [{ name: fileName, role: 'source', mime: imageMime(image.format), buffer: original }], metadata: { image }, recipe: { operation: 'import' } });
  }

  async addRevision({ assetId, parentRevisionId, expectedSelectedRevisionId, files, metadata = {}, recipe = {} }) {
    const normalizedFiles = normalizeFiles(files);
    const normalizedMetadata = jsonValue(metadata);
    const normalizedRecipe = jsonValue(recipe);
    return this._withLock(async () => {
      const data = await this._load();
      const asset = this._asset(data, assetId);
      if (expectedSelectedRevisionId !== undefined && asset.selectedRevisionId !== expectedSelectedRevisionId) throw Object.assign(new Error('Asset changed while saving. Reload the latest revision before retrying.'), { status: 409 });
      const parent = this._revision(asset, parentRevisionId);
      const revision = await this._writeRevision(asset.id, { parentId: parent.id, files: normalizedFiles, metadata: normalizedMetadata, recipe: normalizedRecipe });
      asset.revisions.push(revision);
      asset.selectedRevisionId = revision.id;
      await this._save(data);
      return clone(asset);
    });
  }

  async processImage({ assetId, revisionId, recipe, mode = 'append' }) {
    if (!['append', 'revise'].includes(mode)) throw new Error('Image processing mode must be append or revise.');
    return this._withLock(async () => {
      const data = await this._load();
      const asset = this._asset(data, assetId);
      if (asset.kind !== 'image') throw new Error('Image processing requires an image asset.');
      const parent = this._revision(asset, revisionId);
      const revisable = parent.parentId && parent.recipe?.version === 1 && !parent.recipe.operation;
      if (mode === 'revise' && !revisable) throw new Error('This revision has no image processing recipe to revise.');
      // parentId is the edit history. The recipe input stays fixed while its
      // parameters are revised, including legacy revisions created before this metadata.
      const source = mode === 'revise' ? this._revision(asset, parent.metadata?.processing?.inputRevisionId || parent.parentId) : parent;
      const file = source.files.find((entry) => entry.role === 'image') ?? source.files.find((entry) => entry.role === 'source');
      if (!file) throw new Error('Revision has no source image.');
      const input = await this._readFile(asset.id, source.id, file);
      const processed = await processImageBuffer(input, recipe);
      const metadata = { ...processed.metadata, processing: { inputRevisionId: source.id, mode } };
      if (source.metadata.generation) {
        metadata.generation = { ...clone(source.metadata.generation), originRevisionId: source.metadata.generation.originRevisionId ?? source.id };
      }
      const references = [];
      for (const reference of source.files.filter((entry) => entry.role === 'reference')) {
        references.push({ name: reference.name, role: reference.role, mime: reference.mime,
          buffer: await this._readFile(asset.id, source.id, reference) });
      }
      const revision = await this._writeRevision(asset.id, {
        parentId: parent.id, metadata, recipe: processed.recipe,
        files: normalizeFiles([{ name: 'image.png', role: 'image', mime: 'image/png', buffer: processed.buffer }, ...references]),
      });
      asset.revisions.push(revision);
      asset.selectedRevisionId = revision.id;
      await this._save(data);
      return clone(asset);
    });
  }

  async selectRevision({ assetId, revisionId }) {
    return this._withLock(async () => {
      const data = await this._load();
      const asset = this._asset(data, assetId);
      const revision = this._revision(asset, revisionId);
      asset.selectedRevisionId = revision.id;
      await this._save(data);
      return clone(asset);
    });
  }

  async _validate(asset, revision) {
    const checks = [];
    let coverage;
    const buffers = new Map();
    for (const file of revision.files) {
      try {
        buffers.set(file.name, await this._readFile(asset.id, revision.id, file));
        checks.push({ id: `artifact:${file.name}`, status: 'passed', message: 'Recorded byte size and SHA-256 match.' });
      } catch (error) { checks.push({ id: `artifact:${file.name}`, status: 'failed', message: error.message }); }
    }
    if (!revision.files.length) checks.push({ id: 'artifacts', status: 'failed', message: 'Revision has no artifacts.' });
    if (asset.kind === 'image') {
      const file = revision.files.find((entry) => entry.role === 'image') ?? revision.files.find((entry) => entry.role === 'source');
      if (!file || !buffers.has(file.name)) checks.push({ id: 'image-decode', status: 'failed', message: 'Source image is missing or corrupt.' });
      else {
        try {
          const image = await inspectImage(buffers.get(file.name));
          checks.push({ id: 'image-decode', status: 'passed', message: `Decoded ${image.format}: ${image.width} x ${image.height}.` });
          const expected = revision.metadata.image;
          const metadataMatches = expected && expected.width === image.width && expected.height === image.height && expected.format === image.format && expected.hasAlpha === image.hasAlpha;
          checks.push({ id: 'image-metadata', status: metadataMatches ? 'passed' : 'failed', message: metadataMatches ? 'Image dimensions, format and alpha match the recorded metadata.' : 'Recorded image metadata differs from the artifact.' });
          const bounds = image.alpha.bounds;
          checks.push({ id: 'visible-content', status: bounds ? 'passed' : 'failed', message: bounds ? 'Image has visible pixels.' : 'Image is fully transparent.' });
          if (revision.recipe.version === 1 && (revision.recipe.width !== undefined || revision.recipe.height !== undefined)) {
            const recipe = revision.recipe;
            const matches = image.width === recipe.width && image.height === recipe.height;
            checks.push({ id: 'output-dimensions', status: matches ? 'passed' : 'failed', message: matches ? 'Output dimensions match the recipe.' : 'Output dimensions differ from the recipe.' });
            if (recipe.background === 'transparent') {
              const padding = recipe.padding;
              const fits = image.hasAlpha && (!bounds || (bounds.x >= padding && bounds.y >= padding && bounds.x + bounds.width <= image.width - padding && bounds.y + bounds.height <= image.height - padding));
              checks.push({ id: 'alpha-padding', status: fits ? 'passed' : 'failed', message: fits ? 'Alpha channel and transparent padding satisfy the recipe.' : 'Alpha channel or transparent padding differs from the recipe.' });
            }
          }
        } catch (error) { checks.push({ id: 'image-decode', status: 'failed', message: error.message }); }
      }
    }
    if (asset.kind === 'model3d') {
      coverage = 'glb-and-files';
      const modelFiles = revision.files.filter(file => file.role === 'model');
      try {
        if (modelFiles.length !== 1 || !buffers.has(modelFiles[0].name)) throw new Error('A model revision requires exactly one intact GLB artifact.');
        const { inspectGlb } = await import('../model/glb.mjs');
        const model = await inspectGlb(buffers.get(modelFiles[0].name));
        checks.push({ id: 'glb-structure', status: model.validation.status, repairable: Boolean(model.validation.repairable),
          message: model.validation.status === 'passed' ? 'GLB structure, embedded images and skin weights passed technical checks.'
            : 'GLB has repairable weight errors: ' + model.validation.issues.filter(issue => issue.severity === 0).map(issue => issue.message).join(' ') });
      } catch (error) { checks.push({ id: 'glb-structure', status: 'failed', repairable: false, message: error.message }); }
    }
    return {
      status: checks.some((check) => check.status === 'failed') ? 'failed' : 'passed',
      scope: 'technical', humanAcceptance: 'not-reviewed', validatedAt: now(), checks, ...(coverage ? { coverage } : {}),
    };
  }

  async validateRevision({ assetId, revisionId }) {
    return this._withLock(async () => {
      const data = await this._load();
      const asset = this._asset(data, assetId);
      const revision = this._revision(asset, revisionId);
      revision.validation = await this._validate(asset, revision);
      await this._save(data);
      return clone(revision.validation);
    });
  }

  async exportAsset({ assetId, revisionId }) {
    return this._withLock(async () => {
      const data = await this._load();
      const asset = this._asset(data, assetId);
      const revision = this._revision(asset, revisionId);
      revision.validation = await this._validate(asset, revision);
      if (revision.validation.status !== 'passed') {
        await this._save(data);
        throw new Error('Export blocked: technical validation failed. Inspect validateRevision for details.');
      }
      const id = createId('pkg');
      const createdAt = now();
      const manifest = {
        schemaVersion: 1, id, assetId: asset.id, revisionId: revision.id, name: asset.name, kind: asset.kind, createdAt,
        metadata: clone(revision.metadata), recipe: clone(revision.recipe), validation: clone(revision.validation),
        files: revision.files.map((file) => ({ ...file, path: `${file.role === 'reference' ? 'references' : 'resources'}/${file.name}` })),
      };
      await this._path(['exports', id, 'resources'], { mkdir: true });
      for (const file of revision.files) {
        const buffer = await this._readFile(asset.id, revision.id, file);
        const directory = file.role === 'reference' ? 'references' : 'resources';
        if (directory === 'references') await this._path(['exports', id, directory], { mkdir: true });
        const target = await this._path(['exports', id, directory, file.name]);
        await fs.writeFile(target, buffer, { flag: 'wx' });
      }
      const manifestPath = await this._path(['exports', id, 'manifest.json']);
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
      const result = { id, assetId: asset.id, revisionId: revision.id, createdAt, path: `exports/${id}`, manifest };
      data.exports.push(result);
      await this._save(data);
      return clone(result);
    });
  }

  async readArtifact({ assetId, revisionId, fileName }) {
    safeFileName(fileName);
    const data = await this._load();
    const asset = this._asset(data, assetId);
    const revision = this._revision(asset, revisionId);
    const file = revision.files.find((entry) => entry.name === fileName);
    if (!file) throw new Error('Artifact does not exist in the selected revision.');
    return { buffer: await this._readFile(asset.id, revision.id, file), mime: file.mime, name: file.name };
  }
}
