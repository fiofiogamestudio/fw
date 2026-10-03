import { normalizeFiles } from '../core/project.mjs';
import { inspectImage } from '../image/processor.mjs';
import { validateSkeleton2dDocument, summarizeSkeleton2d } from './document.mjs';

export const DOCUMENT_FILE = 'skeleton2d.json';
const fail = message => Object.assign(new Error(message), { status: 400, code: 'SKELETON2D_INVALID' });
const documentFile = document => ({ name: DOCUMENT_FILE, role: 'skeleton2d', mime: 'application/json', buffer: Buffer.from(`${JSON.stringify(document, null, 2)}\n`) });

/** Shared technical validation used both by the application and generic project export. */
export async function inspectSkeleton2dFiles(files) {
  const normalized = normalizeFiles(files), documents = normalized.filter(file => file.role === 'skeleton2d');
  if (documents.length !== 1 || documents[0].name !== DOCUMENT_FILE || documents[0].mime !== 'application/json') throw fail('Skeleton2D revision requires one skeleton2d.json document.');
  const document = validateSkeleton2dDocument(JSON.parse(documents[0].buffer.toString('utf8')));
  const wanted = new Set(Object.values(document.textures)), byName = new Map(normalized.map(file => [file.name, file]));
  if (normalized.length !== wanted.size + 1) throw fail('Skeleton2D revision must contain exactly its document and referenced PNG textures.');
  const textures = [];
  for (const name of wanted) {
    const file = byName.get(name);
    if (!file || file.role !== 'texture' || file.mime !== 'image/png') throw fail(`Missing registered PNG texture ${name}.`);
    const image = await inspectImage(file.buffer);
    if (image.format !== 'png') throw fail(`Texture ${name} must contain actual PNG bytes.`);
    textures.push({ name, width: image.width, height: image.height, hasAlpha: image.hasAlpha });
  }
  return { document, summary: summarizeSkeleton2d(document), textures };
}

export async function importSkeleton2d(project, { name, document, textures, idempotencyKey, metadata = {} }) {
  const clean = validateSkeleton2dDocument(document);
  if (!Array.isArray(textures)) throw fail('Texture file buffers are required.');
  const files = normalizeFiles([documentFile(clean), ...textures.map(file => ({ name: file.name, buffer: file.buffer, role: 'texture', mime: 'image/png' }))]);
  const inspection = await inspectSkeleton2dFiles(files);
  return project.importAsset({ name, kind: 'skeleton2d', files, idempotencyKey,
    metadata: { ...metadata, skeleton2d: inspection.summary }, recipe: { operation: 'skeleton2d.import', version: 1 } });
}

/** One manifest load per revision, avoiding one large-index reload for every region. */
export async function readSkeleton2dBundle(project, { assetId, revisionId }, { snapshot } = {}) {
  if (typeof revisionId !== 'string') throw fail('An exact Skeleton2D revisionId is required.');
  // The editor may reuse the index it just loaded and identity-checked for this
  // request. Never cache it across requests or accept it from HTTP parameters.
  const current = snapshot ?? await project._load(), asset = project._asset(current, assetId);
  if (asset.kind !== 'skeleton2d') throw fail('This operation requires a skeleton2d asset.');
  const revision = project._revision(asset, revisionId), files = [];
  for (const file of revision.files) files.push({ ...file, buffer: await project._readFile(asset.id, revision.id, file) });
  const inspection = await inspectSkeleton2dFiles(files);
  return { asset: structuredClone(asset), revision: structuredClone(revision), files, ...inspection };
}

export async function inspectSkeleton2d(project, args, { includeTextures = false, snapshot } = {}) {
  const bundle = await readSkeleton2dBundle(project, args, { snapshot }), byName = new Map(bundle.revision.files.map(file => [file.name, file]));
  return { assetId: bundle.asset.id, revisionId: bundle.revision.id, selectedRevisionId: bundle.asset.selectedRevisionId, name: bundle.asset.name,
    document: bundle.document, summary: bundle.summary,
    textureFiles: Object.entries(bundle.document.textures).map(([region, fileName]) => ({ region, fileName, ...byName.get(fileName) })),
    // Reuse exact, hash-verified PNG buffers, with one copy for each registered
    // file even when several regions share it. CLI inspection stays compact.
    ...(includeTextures ? { textureData: Object.fromEntries(bundle.files.filter(file => file.role === 'texture').map(file => [file.name, { mime: 'image/png', base64: file.buffer.toString('base64') }])) } : {}) };
}

/** Every save is immutable. Stale editors must reload instead of overwriting another selected revision. */
export async function saveSkeleton2d(project, { assetId, revisionId, expectedRevisionId, document }) {
  if (typeof expectedRevisionId !== 'string' || expectedRevisionId !== revisionId) throw fail('Saving requires expectedRevisionId equal to the exact edited revisionId.');
  const clean = validateSkeleton2dDocument(document), bundle = await readSkeleton2dBundle(project, { assetId, revisionId });
  if (bundle.asset.selectedRevisionId !== expectedRevisionId) throw Object.assign(new Error('Skeleton2D asset changed. Reload the selected revision before saving.'), { status: 409, code: 'SKELETON2D_REVISION_CONFLICT' });
  const files = [documentFile(clean), ...bundle.files.filter(file => file.role === 'texture')];
  const inspection = await inspectSkeleton2dFiles(files);
  return project.addRevision({ assetId, parentRevisionId: revisionId, expectedSelectedRevisionId: expectedRevisionId, files,
    metadata: { ...bundle.revision.metadata, skeleton2d: inspection.summary }, recipe: { operation: 'skeleton2d.edit', version: 1, sourceRevisionId: revisionId } });
}

export async function exportSkeleton2d(project, args) {
  // Generic export repeats the same professional validation inside its writer lock.
  await readSkeleton2dBundle(project, args);
  return project.exportAsset(args);
}
