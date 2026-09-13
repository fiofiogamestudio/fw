import { inspectSpine, extractRegion, replaceRegion, spineError } from './index.mjs';
import { fileName } from './atlas.mjs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

function identifyFiles(files) {
  if (!Array.isArray(files) || !files.length) throw spineError('MISSING_FILES', 'Import requires a JSON skeleton, atlas text and PNG pages.');
  const names = new Set();
  for (const file of files) {
    fileName(file.name);
    if (names.has(file.name.toLowerCase())) throw spineError('DUPLICATE_FILE', `Duplicate input filename: ${file.name}`);
    names.add(file.name.toLowerCase());
    if (/\.skel$/i.test(file.name)) throw spineError('UNSUPPORTED_SKEL', 'Binary SKEL input is not supported; export Spine 4.2 JSON.');
  }
  const jsonFiles = files.filter(file => /\.json$/i.test(file.name));
  const atlasFiles = files.filter(file => /\.atlas$/i.test(file.name));
  if (jsonFiles.length !== 1 || atlasFiles.length !== 1) throw spineError('INVALID_FILE_SET', 'Exactly one JSON skeleton and one .atlas file are required.');
  const unsupported = files.filter(file => !/\.(json|atlas|png)$/i.test(file.name));
  if (unsupported.length) throw spineError('UNSUPPORTED_FILE', `Unsupported Spine input: ${unsupported[0].name}`);
  return { jsonFile: jsonFiles[0], atlasFile: atlasFiles[0], pages: new Map(files.filter(file => /\.png$/i.test(file.name)).map(file => [file.name, file.buffer])) };
}

function artifactFiles(files) {
  return files.map(file => ({ name: file.name, buffer: file.buffer, role: /\.json$/i.test(file.name) ? 'skeleton' : /\.atlas$/i.test(file.name) ? 'atlas' : 'texture', mime: /\.json$/i.test(file.name) ? 'application/json' : /\.atlas$/i.test(file.name) ? 'text/plain' : 'image/png' }));
}

async function inspectFiles(files) {
  const { jsonFile, atlasFile, pages } = identifyFiles(files);
  const report = await inspectSpine({ json: jsonFile.buffer, atlas: atlasFile.buffer, pages });
  return { jsonFile, atlasFile, pages, report: { ...report, jsonFile: jsonFile.name, atlasFile: atlasFile.name } };
}

function requireSupported(report) {
  if (!report.supported) throw spineError('INVALID_SPINE_ASSET', report.issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join(' '), report.issues);
}

export async function importSpine(project, { name, files }) {
  const { report } = await inspectFiles(files);
  requireSupported(report);
  return project.importAsset({ name, kind: 'spine', files: artifactFiles(files), metadata: { spine: report }, recipe: { operation: 'spine.import', version: 1, format: 'spine-4.2-json-atlas', sourceFiles: files.map(file => file.name) } });
}

async function loadRevision(project, { assetId, revisionId }) {
  const snapshot = await project.snapshot();
  const asset = snapshot.assets.find(asset => asset.id === assetId);
  if (!asset || asset.kind !== 'spine') throw spineError('ASSET_NOT_FOUND', 'A Spine asset is required.');
  const revision = asset.revisions.find(revision => revision.id === (revisionId ?? asset.selectedRevisionId));
  if (!revision) throw spineError('REVISION_NOT_FOUND', 'Spine revision was not found.');
  const files = [];
  for (const file of revision.files) {
    if (!['skeleton', 'atlas', 'texture'].includes(file.role)) continue;
    const artifact = await project.readArtifact({ assetId, revisionId: revision.id, fileName: file.name });
    files.push({ name: file.name, buffer: artifact.buffer });
  }
  const inspected = await inspectFiles(files);
  requireSupported(inspected.report);
  return { asset, revision, files, ...inspected };
}

export async function replaceSpinePart(project, { assetId, revisionId, regionName, buffer, transform = {} }) {
  const source = await loadRevision(project, { assetId, revisionId });
  const result = await replaceRegion({ atlas: source.atlasFile.buffer, pages: source.pages, regionName, buffer, transform });
  const files = source.files.map(file => ({ ...file, buffer: result.pages.get(file.name) ?? file.buffer }));
  const { report } = await inspectFiles(files);
  requireSupported(report);
  report.issues.push(...result.warnings);
  const sourceHash = createHash('sha256').update(buffer).digest('hex');
  const sourceFormat = (await sharp(buffer).metadata()).format;
  let sourceFile = `fwv-source-${sourceHash.slice(0, 16)}.${sourceFormat === 'jpeg' ? 'jpg' : sourceFormat}`;
  while (files.some(file => file.name.toLowerCase() === sourceFile.toLowerCase())) sourceFile = `_${sourceFile}`;
  const revisionFiles = [...artifactFiles(files), { name: sourceFile, role: 'reference', mime: sourceFormat === 'jpeg' ? 'image/jpeg' : `image/${sourceFormat}`, buffer }];
  // Keep original skeleton JSON and atlas bytes. Only the existing texture region changes.
  return project.addRevision({ assetId, parentRevisionId: source.revision.id, files: revisionFiles, metadata: { ...source.revision.metadata, spine: report }, recipe: { operation: 'spine.replace-region', version: 1, regionName, transform: result.transform, sourceFile, sourceSha256: sourceHash, preserved: ['skeleton', 'atlas', 'weights', 'animations'] } });
}

/** Read-only calibration output. Uses the exact atlas replacement pipeline committed by replaceSpinePart. */
export async function previewSpinePart(project, { assetId, revisionId, regionName, buffer, transform = {} }) {
  const source = await loadRevision(project, { assetId, revisionId });
  const result = await replaceRegion({ atlas: source.atlasFile.buffer, pages: source.pages, regionName, buffer, transform });
  const part = await extractRegion({ atlas: source.atlasFile.buffer, pages: result.pages, regionName });
  return { assetId, revisionId: source.revision.id, regionName, pageName: result.pageName,
    pageBase64: result.buffer.toString('base64'), partBase64: part.toString('base64'),
    transform: result.transform, warnings: result.warnings };
}

export async function extractSpinePart(project, { assetId, revisionId, regionName }) {
  const source = await loadRevision(project, { assetId, revisionId });
  return extractRegion({ atlas: source.atlasFile.buffer, pages: source.pages, regionName });
}
