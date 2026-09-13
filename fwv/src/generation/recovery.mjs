import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const base = ['.fwv', 'generation'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jobId = value => {
  if (typeof value !== 'string' || !/^gen_[a-f0-9]{32}$/.test(value)) throw new Error('Invalid generation recovery job ID.');
  return value;
};
const fileName = value => {
  if (!/^(generated|reference)\.(png|jpg|webp)$/.test(value)) throw new Error('Invalid generation recovery file name.');
  return value;
};

/** Project-local journal. All paths and writes use the project's storage boundary and writer lock. */
export class GenerationRecovery {
  constructor(project) { this.project = project; }

  async _json(parts) {
    const target = await this.project._path(parts);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Generation recovery record exceeds 1 MiB or is not a file.');
    return JSON.parse(await fs.readFile(target, 'utf8'));
  }

  async _atomic(parts, buffer) {
    const target = await this.project._path(parts);
    const temp = await this.project._path([...parts.slice(0, -1), `.generation-${randomUUID()}.tmp`]);
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(buffer); await handle.sync(); } finally { await handle.close(); }
      const deadline = Date.now() + 1500;
      while (true) {
        try { await fs.rename(temp, target); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
          await delay(25);
        }
      }
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async records() {
    let names;
    try { names = await fs.readdir(await this.project._path(base)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names.filter(name => /^gen_[a-f0-9]{32}$/.test(name))) {
      try {
        const value = await this._json([...base, name, 'job.json']);
        if (value.schemaVersion !== 1 || value.job?.id !== name) throw new Error('Invalid generation recovery record.');
        records.push(value.job);
      } catch (error) {
        // A crash before the reservation was committed cannot have dispatched a request.
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return records;
  }

  async _write(job) {
    await this.project._path([...base, jobId(job.id)], { mkdir: true });
    try {
      const existing = await this._json([...base, job.id, 'job.json']);
      if (existing.schemaVersion !== 1 || existing.job?.fingerprint !== job.fingerprint) throw new Error('Generation journal identity mismatch.');
      // A stale service cannot downgrade a committed result while holding the same project lock.
      if (existing.job.status === 'succeeded') return existing.job;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const serialized = JSON.stringify({ schemaVersion: 1, job });
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Generation recovery record exceeds 1 MiB.');
    await this._atomic([...base, job.id, 'job.json'], serialized + '\n');
    return job;
  }

  async reserve(job) {
    return this.project._withLock(async () => {
      const records = await this.records();
      const existing = records.find(entry => entry.requestId === job.requestId);
      if (existing) {
        if (existing.fingerprint !== job.fingerprint) throw Object.assign(new Error('相同请求编号对应了不同内容，请查询原任务。'), { status: 400 });
        return { job: existing, created: false };
      }
      await this._write(job);
      return { job, created: true };
    });
  }

  async write(job) { return this.project._withLock(() => this._write(job)); }

  async stage(id, bundle) {
    jobId(id);
    return this.project._withLock(async () => {
      await this.project._path([...base, id], { mkdir: true });
      const files = [];
      for (const file of bundle.files) {
        fileName(file.name);
        if (!Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > 32 * 1024 * 1024) throw new Error('Invalid generated recovery image.');
        await this._atomic([...base, id, file.name], file.buffer);
        files.push({ name: file.name, role: file.role, mime: file.mime, bytes: file.buffer.length, sha256: hash(file.buffer) });
      }
      const record = { schemaVersion: 1, jobId: id, ...bundle, files };
      const serialized = JSON.stringify(record);
      if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Generation result provenance exceeds 1 MiB.');
      // The manifest is the commit marker, written only after all exact bytes were synced.
      await this._atomic([...base, id, 'result.json'], serialized + '\n');
      return base.concat(id, 'result.json').join('/');
    });
  }

  async read(id, fingerprint) {
    jobId(id);
    let result;
    try { result = await this._json([...base, id, 'result.json']); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (result.schemaVersion !== 1 || result.jobId !== id || result.fingerprint !== fingerprint
      || !Array.isArray(result.files) || !result.files.length || result.files.length > 2) throw new Error('Generation recovery identity does not match its request.');
    const files = [];
    for (const file of result.files) {
      fileName(file.name);
      if (!Number.isInteger(file.bytes) || file.bytes < 1 || file.bytes > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid generation recovery file descriptor.');
      const target = await this.project._path([...base, id, file.name]);
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size !== file.bytes) throw new Error('Generation recovery file size mismatch.');
      const buffer = await fs.readFile(target);
      if (hash(buffer) !== file.sha256) throw new Error('Generation recovery file hash mismatch.');
      files.push({ name: file.name, role: file.role, mime: file.mime, buffer });
    }
    const { schemaVersion, jobId: ignored, ...bundle } = result;
    return { ...bundle, files };
  }

  async clearOutput(id, files = ['generated.png', 'generated.jpg', 'generated.webp', 'reference.png', 'reference.jpg', 'reference.webp'].map(name => ({ name }))) {
    return this.project._withLock(async () => {
      // Delete only known artifact basenames, never a recursively computed directory.
      for (const name of ['result.json', ...files.map(file => fileName(file.name))]) {
        await fs.unlink(await this.project._path([...base, jobId(id), name])).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    });
  }
}
