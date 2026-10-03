import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { readAuthoring } from '../src/editor/authoring.mjs';
import { imageRowId, projectCatalog, readCatalog, readProjectedAuthoring, writeProjectedAuthoring } from '../src/editor/catalog.mjs';
import { createSkeleton2dDemo } from '../tools/create-skeleton2d-demo.mjs';

const fwePath = process.env.FWV_TEST_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-native-catalog-')), project = new FwvProject(root);
  const snapshot = await project.init({ name: 'Native collection source' });
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('fwv-native-catalog-')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, options: { projectRoot: root, expectedProjectId: snapshot.id } };
}
async function images(project) {
  const png = await sharp({ create: { width: 600, height: 300, channels: 4, background: '#76a788' } }).png().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer(), webp = await sharp(png).webp().toBuffer();
  const asset = await project.importAsset({ name: 'Custom actor group', kind: 'custom', files: [
    { name: 'part + one.png', mime: 'IMAGE/PNG', role: 'component', buffer: png },
    { name: 'note.json', mime: 'application/json', role: 'metadata', buffer: Buffer.from('{}') }] });
  const revised = await project.addRevision({ assetId: asset.id, parentRevisionId: asset.selectedRevisionId, files: [
    { name: 'portrait.jpg', mime: 'image/JPEG', role: 'reference', buffer: jpeg },
    { name: 'part.webp', mime: 'IMAGE/WEBP', role: 'preview', buffer: webp }] });
  return { asset: revised, png, jpeg, webp };
}

test('native catalogue projects registered historical originals as lightweight stable rows', async t => {
  const { root, project, options } = await fixture(t), { asset } = await images(project), before = await fs.readFile(path.join(root, 'fwv.project.json'));
  const resource = await readCatalog(options), data = resource.data;
  assert.equal(resource.name, 'catalog.json'); assert.equal(data.images.length, 3);
  assert.deepEqual(data.images.map(row => [row.version, row.current, row.mime]), [['v1', 'historical', 'image/png'], ['v2', 'current', 'image/jpeg'], ['v2', 'current', 'image/webp']]);
  const row = data.images[0]; assert.equal(row.id, imageRowId(asset.id, asset.revisions[0].id, 'part + one.png'));
  assert.equal(new URL(row.thumbnailUrl, 'http://localhost').searchParams.get('file'), 'part + one.png');
  assert.deepEqual(row.reference, { assetId: asset.id, revisionId: asset.revisions[0].id, file: 'part + one.png' });
  assert.equal(row.variantCount, 0); assert.equal(row.variantSummary, '原图'); assert.deepEqual(row.variants.map(variant => variant.state), ['base']);
  assert.deepEqual(data.assetOptions, [{ id: asset.id, name: asset.name }]); assert.deepEqual(data.kindOptions, [{ id: 'custom', name: 'custom' }]);
  assert.deepEqual(data.versionOptions, [{ id: 'v1', name: 'v1' }, { id: 'v2', name: 'v2' }]);
  assert.ok(!JSON.stringify(data).includes('base64')); assert.deepEqual(await fs.readFile(path.join(root, 'fwv.project.json')), before);
});

test('catalogue groups known state textures with their original and preserves every exact image identity', () => {
  const states = ['flash', 'stone', 'frozen', 'poor', 'unavailable', 'visited'];
  const files = [...states].reverse().map((state, index) => ({ name: `actor + head__${state}.png`, mime: 'IMAGE/PNG', bytes: 200 + index, role: 'texture' }));
  files.splice(2, 0, { name: 'actor + head.png', mime: 'image/png', bytes: 400, role: 'source' });
  const snapshot = { id: 'project', assets: [{ id: 'actor', name: 'Actor', kind: 'skeleton2d', selectedRevisionId: 'r1', revisions: [{ id: 'r1', files }] }] };
  const before = structuredClone(snapshot), data = projectCatalog(snapshot);
  assert.equal(data.images.length, 1); const row = data.images[0];
  assert.equal(row.id, imageRowId('actor', 'r1', 'actor + head.png')); assert.equal(row.bytes, 400);
  assert.equal(row.variantCount, 6); assert.equal(row.variantSummary, '原图 + 6 种状态');
  assert.deepEqual(row.variants.map(variant => variant.state), ['base', ...states]);
  assert.equal(row.variantNames, ['actor + head.png', ...states.map(state => `actor + head__${state}.png`)].join(' '));
  for (const variant of row.variants) {
    const original = files.find(file => file.name === variant.file);
    assert.equal(variant.name, original.name); assert.equal(variant.bytes, original.bytes); assert.equal(variant.mime, 'image/png');
    assert.deepEqual(variant.reference, { assetId: 'actor', revisionId: 'r1', file: original.name });
    const url = new URL(variant.thumbnailUrl, 'http://localhost');
    assert.equal(url.searchParams.get('file'), original.name); assert.equal(url.searchParams.get('revisionId'), 'r1');
  }
  assert.deepEqual(snapshot, before, 'grouping never rewrites immutable revision files');
});

test('catalogue keeps independent artwork, orphan states and unknown suffixes visible', () => {
  const file = (name, role) => ({ name, role, mime: 'image/png', bytes: 10 });
  const snapshot = { id: 'project', assets: [{ id: 'art', name: 'Art', kind: 'custom', selectedRevisionId: 'r1', revisions: [{ id: 'r1', files: [
    file('head.png', 'source'), file('head__flash.png', 'source'), file('head__stone.png', 'preview'), file('head__frozen.png', 'reference'),
    file('head__poor.png', 'texture'), file('head__summer.png', 'texture'), file('orphan__flash.png', 'texture'),
    file('legacy.png'), file('legacy__visited.png'), file('other.jpg', 'source'), file('other__stone.png', 'texture'),
    file('head__poor__stone.png', 'texture')
  ] }] }] };
  const rows = projectCatalog(snapshot).images;
  assert.deepEqual(rows.map(row => row.file), ['head.png', 'head__flash.png', 'head__stone.png', 'head__frozen.png', 'head__summer.png', 'orphan__flash.png', 'legacy.png', 'other.jpg', 'other__stone.png', 'head__poor__stone.png']);
  assert.deepEqual(rows[0].variants.map(variant => variant.file), ['head.png', 'head__poor.png']);
  assert.deepEqual(rows.find(row => row.file === 'legacy.png').variants.map(variant => variant.state), ['base', 'visited']);
  assert.equal(rows.flatMap(row => row.variants).length, snapshot.assets[0].revisions[0].files.length, 'no registered image disappears');
});

test('catalogue never groups images across assets or historical revisions', () => {
  const file = name => ({ name, mime: 'image/png', bytes: 10, role: 'texture' });
  const snapshot = { id: 'project', assets: [
    { id: 'one', name: 'One', kind: 'image', selectedRevisionId: 'new', revisions: [
      { id: 'old', files: [file('head.png'), file('head__flash.png')] }, { id: 'new', files: [file('head__flash.png')] }
    ] },
    { id: 'two', name: 'Two', kind: 'image', selectedRevisionId: 'new', revisions: [{ id: 'new', files: [file('head.png')] }] }
  ] };
  const rows = projectCatalog(snapshot).images;
  assert.deepEqual(rows.map(row => [row.assetId, row.revisionId, row.current, row.variantCount]), [
    ['one', 'old', 'historical', 1], ['one', 'new', 'current', 0], ['two', 'new', 'current', 0]
  ]);
  assert.deepEqual(rows[0].variants.map(variant => variant.reference.revisionId), ['old', 'old']);
});

test('grouped HTTP catalogue retains read-only revisions and serves selected variant bytes', async t => {
  const { root, project } = await fixture(t);
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#d08b37' } }).png().toBuffer();
  const stone = await sharp(png).grayscale().png().toBuffer();
  const asset = await project.importAsset({ name: 'Grouped actor', kind: 'custom', files: [
    { name: 'head.png', mime: 'image/png', role: 'source', buffer: png },
    { name: 'head__stone.png', mime: 'image/png', role: 'texture', buffer: stone }
  ] });
  const before = await fs.readFile(path.join(root, 'fwv.project.json'));
  const editor = await startEditor({ projectRoot: root, fwePath, port: 0 }); t.after(() => editor.close());
  const response = await fetch(`${editor.url}/api/domains/fwv-catalog/files/catalog.json`); assert.equal(response.status, 200);
  const resource = await response.json(); assert.equal(resource.data.images.length, 1);
  const row = resource.data.images[0]; assert.equal(row.id, imageRowId(asset.id, asset.selectedRevisionId, 'head.png'));
  const variant = row.variants.find(item => item.state === 'stone'), url = new URL(variant.thumbnailUrl, editor.url); url.searchParams.delete('thumbnail');
  const image = await fetch(url); assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), stone);
  assert.deepEqual(await fs.readFile(path.join(root, 'fwv.project.json')), before);
});

test('skeleton Source includes unsaved actors, persists only edits and strips derived display metadata', async t => {
  const { root, project, options } = await fixture(t), demo = await createSkeleton2dDemo(root);
  const actor = (await project.snapshot()).assets[0], files = [];
  for (const file of actor.revisions[0].files) files.push({ ...file, buffer: await project._readFile(actor.id, actor.selectedRevisionId, file) });
  const second = await project.importAsset({ name: 'Another reusable windmill', kind: 'skeleton2d', files });
  const before = await fs.readFile(path.join(root, 'fwv.project.json')), initial = await readProjectedAuthoring(options);
  assert.equal(initial.exists, false); assert.equal(initial.data.skeleton2dDrafts.length, 2);
  assert.deepEqual(initial.data.skeleton2dDrafts.map(row => row.data), [{ assetId: demo.assetId, revisionId: demo.revisionId }, { assetId: second.id, revisionId: second.selectedRevisionId }]);
  assert.equal(initial.data.skeleton2dDrafts[0].textureCount, 2);
  const previewUrl = new URL(initial.data.skeleton2dDrafts[0].thumbnailUrl, 'http://localhost');
  assert.equal(previewUrl.pathname, '/api/fwv/skeleton2d-thumbnail');
  assert.deepEqual(Object.fromEntries(previewUrl.searchParams), { assetId: demo.assetId, revisionId: demo.revisionId });
  const first = await writeProjectedAuthoring({ ...options, payload: { createOnly: true, data: initial.data } });
  assert.deepEqual((await readAuthoring(options)).data.skeleton2dDrafts, [], 'browsing placeholders never become saved drafts');
  const storedPath = path.join(root, '.fwv', 'editor-drafts.json'), stored = JSON.parse(await fs.readFile(storedPath, 'utf8')); stored.rigDrafts = [{ old: 'opaque' }]; await fs.writeFile(storedPath, JSON.stringify(stored));
  const edited = await readProjectedAuthoring(options); edited.data.skeleton2dDrafts[0].data.time = 0.25;
  Object.assign(edited.data.skeleton2dDrafts[0], { name: 'client forged label', thumbnailUrl: 'https://invalid.example', textureCount: 999 });
  await writeProjectedAuthoring({ ...options, payload: { revision: edited.revision, data: edited.data } });
  const disk = JSON.parse(await fs.readFile(storedPath, 'utf8')); assert.deepEqual(disk.rigDrafts, [{ old: 'opaque' }]);
  assert.deepEqual(disk.skeleton2dDrafts, [{ id: demo.assetId, data: { assetId: demo.assetId, revisionId: demo.revisionId, time: 0.25 } }]);
  const reopened = await readProjectedAuthoring(options); assert.equal(reopened.data.skeleton2dDrafts[0].name, actor.name); assert.equal(reopened.data.skeleton2dDrafts[0].textureCount, 2);
  await assert.rejects(writeProjectedAuthoring({ ...options, payload: { revision: first.revision, data: initial.data } }), error => error.status === 409);
  for (const mutate of [row => row.id = second.id, row => row.data.revisionId = second.selectedRevisionId, row => row.extra = 'forged']) {
    const invalid = structuredClone(reopened.data); mutate(invalid.skeleton2dDrafts[0]); await assert.rejects(writeProjectedAuthoring({ ...options, payload: { revision: reopened.revision, data: invalid } }));
  }
  assert.deepEqual(await fs.readFile(path.join(root, 'fwv.project.json')), before);
});

test('skeleton thumbnails compose the exact revision without changing the library and reject invalid or changed sources', async t => {
  const { root, project } = await fixture(t), demo = await createSkeleton2dDemo(root);
  const editor = await startEditor({ projectRoot: root, fwePath, port: 0 }); t.after(() => editor.close());
  const source = await (await fetch(`${editor.url}/api/domains/fwv-authoring/files/authoring.json`)).json();
  const row = source.data.skeleton2dDrafts[0], url = new URL(row.thumbnailUrl, editor.url);
  const before = await fs.readFile(path.join(root, 'fwv.project.json'));
  const response = await fetch(url); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  const buffer = Buffer.from(await response.arrayBuffer()), metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 256); assert.equal(metadata.height, 256); assert.equal(metadata.hasAlpha, true);
  const { data } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let tower = 0, rotor = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 221 && data[i+1] === 191 && data[i+2] === 135 && data[i+3] === 255) tower++;
    if (data[i] === 70 && data[i+1] === 93 && data[i+2] === 128 && data[i+3] === 255) rotor++;
  }
  assert.ok(tower > 100 && rotor > 100, 'native thumbnail includes both tower and rotor rather than the first texture');
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), buffer, 'cached rendering stays deterministic');
  for (const suffix of ['&revisionId=other', '&file=tower.png', '&path=../../secret']) assert.equal((await fetch(`${url}${suffix}`)).status, 400);
  const wrong = new URL(url); wrong.searchParams.set('revisionId', 'missing'); assert.equal((await fetch(wrong)).status, 400);
  assert.deepEqual(await fs.readFile(path.join(root, 'fwv.project.json')), before);
  assert.equal(await fs.access(path.join(root, '.fwv/editor-drafts.json')).then(() => true, () => false), false);
  const asset = (await project.snapshot()).assets[0], texture = asset.revisions[0].files.find(file => file.role === 'texture');
  await fs.writeFile(path.join(root, 'assets', demo.assetId, demo.revisionId, texture.name), Buffer.alloc(texture.bytes));
  assert.equal((await fetch(url)).status, 400, 'cached assembled thumbnail cannot conceal corrupt source textures');
});

test('native HTTP Source is read-only and image URLs preserve exact bytes, decode types and project identity', async t => {
  const { root, project } = await fixture(t), { asset, png, jpeg } = await images(project);
  const editor = await startEditor({ projectRoot: root, fwePath, port: 0 }); t.after(() => editor.close());
  const route = `${editor.url}/api/domains/fwv-catalog/files/catalog.json`, response = await fetch(route); assert.equal(response.status, 200);
  const resource = await response.json(); assert.equal(resource.data.images.length, 3);
  const before = await fs.readFile(path.join(root, 'fwv.project.json'));
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(route, { method, headers: { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWE-Session': 'catalog-test' }, body: JSON.stringify(resource) })).status, 405);
  const source = resource.data.images[0], fullUrl = new URL(source.thumbnailUrl, editor.url); fullUrl.searchParams.delete('thumbnail');
  const full = await fetch(fullUrl); assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await full.arrayBuffer()), png);
  const thumb = await fetch(new URL(source.thumbnailUrl, editor.url)); assert.equal(thumb.status, 200); assert.equal(thumb.headers.get('content-type'), 'image/png');
  const metadata = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata(); assert.equal(metadata.width, 256); assert.equal(metadata.height, 128);
  const jpegUrl = new URL(resource.data.images[1].thumbnailUrl, editor.url); jpegUrl.searchParams.delete('thumbnail');
  const rawJpeg = await fetch(jpegUrl); assert.equal(rawJpeg.headers.get('content-type'), 'image/jpeg'); assert.deepEqual(Buffer.from(await rawJpeg.arrayBuffer()), jpeg);
  for (const suffix of ['&thumbnail=2', '&file=part.webp', '&path=../../secret']) assert.equal((await fetch(`${fullUrl}${suffix}`)).status, 400);
  const unknown = new URL(fullUrl); unknown.searchParams.set('file', '../../secret'); assert.equal((await fetch(unknown)).status, 400);
  assert.equal((await fetch(fullUrl, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.deepEqual(await fs.readFile(path.join(root, 'fwv.project.json')), before);
  await fs.writeFile(path.join(root, 'assets', asset.id, asset.revisions[0].id, source.file), Buffer.alloc(png.length));
  assert.equal((await fetch(new URL(source.thumbnailUrl, editor.url))).status, 400, 'cached thumbnail cannot hide changed source bytes');
  const current = await project.snapshot(); current.id = `project_${'0'.repeat(32)}`; await fs.writeFile(path.join(root, 'fwv.project.json'), JSON.stringify(current));
  assert.equal((await fetch(jpegUrl)).status, 409); assert.equal((await fetch(route)).status, 409);
});

test('simultaneous native thumbnails share only an in-flight manifest load and reject forged MIME', async t => {
  const { root, project } = await fixture(t), { asset, png } = await images(project);
  const editor = await startEditor({ projectRoot: root, fwePath, port: 0 }); t.after(() => editor.close());
  const query = new URLSearchParams({ assetId: asset.id, revisionId: asset.revisions[0].id, file: 'part + one.png', thumbnail: '1' });
  const original = FwvProject.prototype._load; let loads = 0;
  const spy = t.mock.method(FwvProject.prototype, '_load', async function (...args) { loads++; await new Promise(resolve => setTimeout(resolve, 40)); return original.apply(this, args); });
  const responses = await Promise.all(Array.from({ length: 24 }, () => fetch(`${editor.url}/api/fwv/image?${query}`).then(async response => { await response.arrayBuffer(); return response.status; })));
  assert.ok(responses.every(status => status === 200)); assert.equal(loads, 1);
  await fetch(`${editor.url}/api/fwv/image?${query}`).then(response => response.arrayBuffer()); assert.equal(loads, 2, 'completed metadata is not reused'); spy.mock.restore();
  const forged = await project.importAsset({ kind: 'custom', files: [{ name: 'not-jpeg.jpg', role: 'image', mime: 'image/jpeg', buffer: png }] });
  const invalid = new URLSearchParams({ assetId: forged.id, revisionId: forged.selectedRevisionId, file: 'not-jpeg.jpg' });
  assert.equal((await fetch(`${editor.url}/api/fwv/image?${invalid}`)).status, 400);
});
