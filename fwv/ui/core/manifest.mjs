#!/usr/bin/env node
import { readFile, realpath, stat, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const templatePath = fileURLToPath(new URL('./assets/gallery.html', import.meta.url));
function fail(message) { throw new Error(message); }
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object.`);
}
function text(value, field, { optional = false, allowEmpty = false, max = 4000 } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) fail(`${field} must be ${allowEmpty ? 'a string' : 'a non-empty string'} of at most ${max} characters.`);
}
function integer(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${field} must be a positive safe integer.`);
}
function identifier(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${field} must match ${ID}.`);
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function pngSize(bytes, field) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') fail(`${field} is not a PNG with a valid IHDR header.`);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  integer(width, `${field} PNG width`); integer(height, `${field} PNG height`);
  return { width, height };
}
function embeddedJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Validate metadata, path containment, real PNG dimensions, and coverage before any output is written. */
export async function validateManifest(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const sourceRoot = await realpath(path.dirname(absoluteManifest));
  if ((await stat(absoluteManifest)).size > 32 * 1024 * 1024) fail('Manifest exceeds the 32 MiB limit.');
  let manifest, manifestBytes;
  try { manifestBytes = await readFile(absoluteManifest); manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch (error) { fail(`Cannot read manifest JSON: ${error.message}`); }
  object(manifest, 'manifest');
  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1.');
  text(manifest.title, 'title', { max: 200 });
  text(manifest.project, 'project', { max: 200 });
  object(manifest.run, 'run');
  identifier(manifest.run.id, 'run.id');
  text(manifest.run.capturedAt, 'run.capturedAt', { max: 100 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.run.capturedAt) || !Number.isFinite(Date.parse(manifest.run.capturedAt))) fail('run.capturedAt must be an ISO 8601 timestamp with timezone.');
  text(manifest.run.sourceRevision, 'run.sourceRevision', { optional: true, max: 200 });
  text(manifest.run.evidence, 'run.evidence', { max: 1000 });
  if (!Array.isArray(manifest.screenshots)) fail('screenshots must be an array.');
  if (!Array.isArray(manifest.coverage) || manifest.coverage.length === 0) fail('coverage must contain at least one item.');
  const ids = new Set(), numbers = new Set(), screenshots = [], files = [];
  for (const [index, entry] of manifest.screenshots.entries()) {
    const label = `screenshots[${index}]`;
    object(entry, label);
    identifier(entry.id, `${label}.id`);
    integer(entry.number, `${label}.number`);
    if (ids.has(entry.id)) fail(`Duplicate screenshot id: ${entry.id}`);
    if (numbers.has(entry.number)) fail(`Duplicate screenshot number: ${entry.number}`);
    ids.add(entry.id); numbers.add(entry.number);
    text(entry.title, `${label}.title`, { max: 200 });
    text(entry.category, `${label}.category`, { max: 200 });
    text(entry.notes, `${label}.notes`, { optional: true, allowEmpty: true });
    if (entry.state !== undefined) object(entry.state, `${label}.state`);
    text(entry.evidence, `${label}.evidence`, { optional: true, max: 1000 });
    if (entry.historical !== undefined && typeof entry.historical !== 'boolean') fail(`${label}.historical must be a boolean.`);
    integer(entry.width, `${label}.width`); integer(entry.height, `${label}.height`);
    if (entry.viewport !== undefined) {
      object(entry.viewport, `${label}.viewport`);
      integer(entry.viewport.width, `${label}.viewport.width`); integer(entry.viewport.height, `${label}.viewport.height`);
    }
    text(entry.path, `${label}.path`, { max: 4000 });
    const normalized = entry.path.replaceAll('\\', '/');
    if (normalized.includes('\0') || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) fail(`${label}.path must be a relative path without traversal.`);
    const file = path.resolve(sourceRoot, normalized);
    if (!inside(sourceRoot, file)) fail(`${label}.path escapes the manifest directory.`);
    const resolved = await realpath(file);
    if (!inside(sourceRoot, resolved)) fail(`${label}.path symlink escapes the manifest directory.`);
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) fail(`${label}.path must identify a regular file.`);
    if (fileStat.size > 64 * 1024 * 1024) fail(`${label}.path exceeds the 64 MiB image limit.`);
    const bytes = await readFile(resolved), dimensions = pngSize(bytes, `${label}.path`);
    if (entry.width !== dimensions.width || entry.height !== dimensions.height) fail(`${label} dimensions do not match its PNG (${dimensions.width}x${dimensions.height}).`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (entry.sha256 !== undefined && entry.sha256 !== sha256) fail(`${label} declared SHA-256 does not match its PNG.`);
    if (entry.bytes !== undefined && entry.bytes !== bytes.length) fail(`${label} declared byte size does not match its PNG.`);
    const outputPath = `images/${String(entry.number).padStart(3, '0')}-${entry.id}.png`;
    screenshots.push({ ...entry, path: outputPath, sourcePath: entry.path, sha256, bytes: bytes.length });
    files.push({ path: outputPath, bytes });
  }
  const byId = new Map(screenshots.map(entry => [entry.id, entry])), coverageIds = new Set(), referenced = new Set();
  for (const [index, item] of manifest.coverage.entries()) {
    const label = `coverage[${index}]`;
    object(item, label); identifier(item.id, `${label}.id`); text(item.title, `${label}.title`, { max: 200 });
    if (coverageIds.has(item.id)) fail(`Duplicate coverage id: ${item.id}`);
    coverageIds.add(item.id);
    if (!['captured', 'blocked', 'excluded'].includes(item.status)) fail(`${label}.status must be captured, blocked, or excluded.`);
    if (!Array.isArray(item.screenshotIds)) fail(`${label}.screenshotIds must be an array.`);
    const unique = new Set();
    for (const id of item.screenshotIds) {
      identifier(id, `${label}.screenshotIds`);
      if (!byId.has(id)) fail(`${label} references unknown screenshot: ${id}`);
      if (unique.has(id)) fail(`${label} repeats screenshot: ${id}`);
      unique.add(id);
      referenced.add(id);
    }
    if (item.status === 'captured') {
      if (!item.screenshotIds.some(id => !byId.get(id).historical)) fail(`${label} captured requires at least one current screenshot.`);
      text(item.reason, `${label}.reason`, { optional: true });
    } else {
      text(item.reason, `${label}.reason`);
    }
  }
  for (const entry of screenshots) if (!entry.historical && !referenced.has(entry.id)) fail(`Current screenshot is not referenced by coverage: ${entry.id}`);
  const counts = { total: manifest.coverage.length, captured: 0, blocked: 0, excluded: 0 };
  for (const item of manifest.coverage) counts[item.status]++;
  const summary = { ...counts, percentCaptured: Math.round(counts.captured / counts.total * 1000) / 10, screenshots: screenshots.length, currentScreenshots: screenshots.filter(item => !item.historical).length, historicalScreenshots: screenshots.filter(item => item.historical).length };
  const generated = { generator: 'fw-ui-capture', generatedAt: new Date().toISOString(), sourceManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), evidenceScope: 'Evidence text is supplied by the capture operator. This builder validates files, dimensions, hashes and declared coverage; it does not verify GPU capture authenticity.' };
  const capture = { ...manifest, screenshots, generated, summary };
  const coverage = { schemaVersion: 1, project: manifest.project, run: manifest.run, summary, items: manifest.coverage, generated };
  return { capture, coverage, files, manifest, manifestPath: absoluteManifest, sourceRoot };
}

export async function renderGallery({ capture, coverage, files, review, inlineImages = false }) {
  const template = await readFile(templatePath, 'utf8');
  for (const token of ['__CAPTURE_DATA_JSON__', '__COVERAGE_DATA_JSON__']) if (template.split(token).length !== 2) fail(`Gallery template must contain exactly one ${token} token.`);
  const images = inlineImages ? new Map(files.map(file => [file.path, 'data:image/png;base64,' + file.bytes.toString('base64')])) : null;
  const data = { ...capture, ...(review ? { review } : {}), screenshots: capture.screenshots.map(shot => images ? { ...shot, path: images.get(shot.path) } : shot) };
  return template.replace(/__(CAPTURE|COVERAGE)_DATA_JSON__/g, (_token, kind) => embeddedJSON(kind === 'CAPTURE' ? data : coverage));
}

export async function buildGallery({ manifestPath, outDirectory, review }) {
  if (!manifestPath || !outDirectory) fail('Both manifestPath and outDirectory are required.');
  const out = path.resolve(outDirectory);
  if (await exists(out)) fail(`Output directory already exists; choose a new directory: ${out}`);
  const { capture, coverage, files } = await validateManifest(manifestPath);
  const captureBytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`);
  // The exported manifest has normalized paths and generator metadata, so its
  // annotations must bind to those exact new bytes when reopened by FWV.
  const exportedReview = review ? { ...review, manifestId: createHash('sha256').update(captureBytes).digest('hex') } : undefined;
  const html = await renderGallery({ capture, coverage, files, review: exportedReview });
  await mkdir(path.dirname(out), { recursive: true });
  // Exclusive creation protects existing outputs even if another process created one during validation.
  await mkdir(out);
  await mkdir(path.join(out, 'images'));
  for (const file of files) await writeFile(path.join(out, file.path), file.bytes, { flag: 'wx' });
  await writeFile(path.join(out, 'capture.json'), captureBytes, { flag: 'wx' });
  await writeFile(path.join(out, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`, { flag: 'wx' });
  await writeFile(path.join(out, 'index.html'), html, { flag: 'wx' });
  if (exportedReview) await writeFile(path.join(out, 'review.json'), `${JSON.stringify(exportedReview, null, 2)}\n`, { flag: 'wx' });
  return { outDirectory: out, summary: capture.summary };
}
