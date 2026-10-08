import { open, readFile, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_REVIEW_BYTES = 4 * 1024 * 1024;
export const REVIEW_STATUSES = Object.freeze(['unreviewed', 'issue', 'accepted', 'rejected']);
export const failure = (message, status = 400, code = 'UI_CAPTURE_INVALID') => Object.assign(new Error(message), { status, code });
export const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure(`${label} contains invalid fields.`);
}
export function validateAnnotations(value, ids) {
  if (!plain(value)) throw failure('annotations must be an object.');
  const result = Object.create(null);
  for (const [id, entry] of Object.entries(value)) {
    if (!ids.has(id)) throw failure(`Unknown screenshot: ${id}`);
    exact(entry, ['status', 'note'], 'annotation');
    if (!REVIEW_STATUSES.includes(entry.status) || typeof entry.note !== 'string' || entry.note.length > 12000) throw failure(`Invalid annotation for ${id}.`);
    result[id] = { status: entry.status, note: entry.note };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_REVIEW_BYTES / 2) throw failure('Annotations exceed their size limit.', 413);
  return result;
}

/** Sidecar writes are independent of capture metadata and protected across processes. */
export class ReviewStore {
  constructor({ sourceRoot, manifestId, ids }) {
    this.root = sourceRoot; this.manifestId = manifestId; this.ids = new Set(ids);
    this.path = path.join(sourceRoot, 'review.json');
  }
  async assertRoot() {
    if (await realpath(this.root) !== this.root) throw failure('Capture directory changed; reopen the workbench.', 409);
  }
  async read() {
    await this.assertRoot();
    let info;
    try { info = await lstat(this.path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { schemaVersion: 1, manifestId: this.manifestId, revision: 0, annotations: {} };
    }
    if (!info.isFile() || info.isSymbolicLink()) throw failure('review.json must be a regular unlinked file.');
    if (info.size > MAX_REVIEW_BYTES) throw failure('review.json exceeds its size limit.', 413);
    const bytes = await readFile(this.path);
    if (bytes.length > MAX_REVIEW_BYTES) throw failure('review.json exceeds its size limit.', 413);
    let document; try { document = JSON.parse(bytes.toString('utf8')); } catch { throw failure('review.json is not valid JSON.'); }
    exact(document, ['schemaVersion', 'manifestId', 'revision', 'updatedAt', 'annotations'], 'review.json');
    if (document.schemaVersion !== 1 || document.manifestId !== this.manifestId) throw failure('review.json belongs to another capture manifest.', 409, 'UI_CAPTURE_MANIFEST_CONFLICT');
    if (!Number.isSafeInteger(document.revision) || document.revision < 0) throw failure('Invalid review revision.');
    document.annotations = validateAnnotations(document.annotations, this.ids);
    return document;
  }
  async write({ expectedRevision, annotations }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw failure('expectedRevision must be a non-negative integer.');
    const validated = validateAnnotations(annotations, this.ids);
    await this.assertRoot();
    const lockPath = this.path + '.lock';
    let lock;
    try { lock = await open(lockPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw failure('Another review save holds the lock. Retry after it finishes.', 423, 'UI_CAPTURE_REVIEW_LOCKED'); throw error; }
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const current = await this.read();
      if (current.revision !== expectedRevision) throw failure('Review changed in another window. Reload before saving.', 409, 'UI_CAPTURE_REVIEW_CONFLICT');
      const next = { schemaVersion: 1, manifestId: this.manifestId, revision: current.revision + 1,
        updatedAt: new Date().toISOString(), annotations: validated };
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(JSON.stringify(next, null, 2) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await this.assertRoot();
      await rename(temporary, this.path);
      return next;
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await lock.close(); await unlink(lockPath);
    }
  }
}
