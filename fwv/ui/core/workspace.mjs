import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { validateManifest } from './manifest.mjs';
import { ReviewStore, failure, plain } from './review.mjs';

const registrations = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isInside = (root, file) => { const relative = path.relative(root, file); return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
export class CaptureWorkspace {
  static async open(manifestPath) {
    const checked = await validateManifest(manifestPath);
    const workspace = new CaptureWorkspace();
    workspace.manifestPath = await realpath(checked.manifestPath);
    workspace.root = checked.sourceRoot;
    workspace.manifestId = checked.capture.generated.sourceManifestSha256;
    workspace.manifest = checked.manifest; workspace.summary = checked.capture.summary;
    workspace.shots = new Map(checked.manifest.screenshots.map((shot, index) => [shot.id,
      { ...shot, sha256: checked.capture.screenshots[index].sha256, bytes: checked.capture.screenshots[index].bytes }]));
    workspace.review = new ReviewStore({ sourceRoot: workspace.root, manifestId: workspace.manifestId, ids: workspace.shots.keys() });
    if (workspace.manifestPath === workspace.review.path || [...workspace.shots.values()].some(shot => path.resolve(workspace.root, shot.path) === workspace.review.path)) throw failure('review.json is reserved for annotations.');
    await workspace.review.read();
    return workspace;
  }
  async assertCurrent() {
    if (await realpath(this.manifestPath) !== this.manifestPath || hash(await readFile(this.manifestPath)) !== this.manifestId)
      throw failure('Capture manifest changed. Reopen the workbench for the new immutable batch.', 409, 'UI_CAPTURE_MANIFEST_CONFLICT');
  }
  token(review) { return `fwv-ui-review:${this.manifestId}:${review.revision}`; }
  async catalog() {
    await this.assertCurrent();
    const review = await this.review.read();
    const coverage = this.manifest.coverage.map(item => ({ ...item, reason: item.reason || '', captureCount: item.screenshotIds.length,
      category: item.category || this.shots.get(item.screenshotIds[0])?.category || item.surface || '未分类' }));
    return { name: 'catalog.json', type: 'json', exists: true, revision: this.token(review), data: {
      schemaVersion: 1, manifestId: this.manifestId, project: this.manifest.project, title: this.manifest.title,
      run: this.manifest.run, summary: this.summary,
      screenshots: [...this.shots.values()].sort((a, b) => a.number - b.number).map(shot => ({ ...shot,
        evidence: shot.evidence || this.manifest.run.evidence, notes: shot.notes || '', sourcePath: shot.path,
        current: shot.historical ? 'historical' : 'current', imageUrl: '/api/fwv/ui-capture/media?id=' + encodeURIComponent(shot.id),
        reviewStatus: review.annotations[shot.id]?.status || 'unreviewed', reviewNote: review.annotations[shot.id]?.note || '', reference: { id: shot.id } })),
      coverage,
      categories: [...new Set([...this.manifest.screenshots.map(shot => shot.category), ...coverage.map(item => item.category)])].sort().map(id => ({ id, name: id }))
    } };
  }
  async saveCatalog(payload) {
    if (!plain(payload) || Object.keys(payload).some(key => !['data', 'revision', 'createOnly'].includes(key)) || payload.createOnly === true) throw failure('Invalid catalog save.');
    await this.assertCurrent();
    const review = await this.review.read();
    if (payload.revision !== this.token(review)) throw failure('Review changed in another window. Reload before saving.', 409, 'UI_CAPTURE_REVIEW_CONFLICT');
    if (!plain(payload.data) || payload.data.manifestId !== this.manifestId || !Array.isArray(payload.data.screenshots)) throw failure('Invalid capture catalog identity.');
    const seen = new Set(), annotations = Object.create(null);
    for (const shot of payload.data.screenshots) {
      if (!plain(shot) || !this.shots.has(shot.id) || seen.has(shot.id)) throw failure('Cannot add, delete or repeat screenshot identities.');
      seen.add(shot.id); annotations[shot.id] = { status: shot.reviewStatus, note: shot.reviewNote };
    }
    if (seen.size !== this.shots.size) throw failure('Cannot remove capture records.');
    const saved = await this.review.write({ expectedRevision: review.revision, annotations });
    return { name: 'catalog.json', exists: true, revision: this.token(saved) };
  }
  async media(id) {
    await this.assertCurrent();
    if (typeof id !== 'string' || !this.shots.has(id)) throw failure('Unknown screenshot ID.', 404);
    const shot = this.shots.get(id), file = await realpath(path.resolve(this.root, shot.path.replaceAll('\\', '/')));
    if (!isInside(this.root, file)) throw failure('Screenshot resolved outside the capture directory.', 403);
    const info = await stat(file);
    if (!info.isFile() || info.size !== shot.bytes || info.size > 64 * 1024 * 1024) throw failure('Screenshot bytes changed after validation.', 409);
    const bytes = await readFile(file);
    if (hash(bytes) !== shot.sha256) throw failure('Screenshot hash changed after validation.', 409, 'UI_CAPTURE_MEDIA_CONFLICT');
    return { bytes, shot };
  }
}
export function registerWorkspace(workspace) {
  const key = randomUUID(); registrations.set(key, workspace);
  return { key, dispose: () => registrations.delete(key) };
}
export function getWorkspace(key) {
  const workspace = registrations.get(key);
  if (!workspace) throw failure('Capture session expired. Reopen the workbench.', 410);
  return workspace;
}
