import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { importSpine, replaceSpinePart, previewSpinePart, extractSpinePart } from '../src/spine/application.mjs';
import { createSpineFixture } from '../examples/spine-fixture/create.mjs';
import { validateAuthoringData, AUTHORING_COLLECTIONS } from '../src/editor/authoring.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-spine-'));
  t.after(async () => { if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup path'); await fs.rm(root, { recursive: true, force: true }); });
  const project = new FwvProject(root);
  await project.init({ name: 'Spine workflow test' });
  return { root, project };
}

test('Spine application preserves revisions and replays exact saved replacement source', async t => {
  const { root, project } = await setup(t);
  const fixture = await createSpineFixture();
  const imported = await importSpine(project, { name: fixture.name, files: fixture.files });
  const originalRevision = imported.selectedRevisionId;
  assert.equal(imported.kind, 'spine');
  assert.equal(imported.revisions[0].metadata.spine.jsonFile, 'fixture.json');
  const replaced = await replaceSpinePart(project, { assetId: imported.id, regionName: 'body', buffer: fixture.replacement, transform: { rotation: 7, scale: 0.85 } });
  const replacementRevision = replaced.revisions.at(-1);
  assert.equal(replacementRevision.parentId, originalRevision);
  for (const fileName of ['fixture.json', 'fixture.atlas']) assert.deepEqual(
    (await project.readArtifact({ assetId: imported.id, revisionId: replacementRevision.id, fileName })).buffer,
    (await project.readArtifact({ assetId: imported.id, revisionId: originalRevision, fileName })).buffer,
  );
  const storedSource = await project.readArtifact({ assetId: imported.id, revisionId: replacementRevision.id, fileName: replacementRevision.recipe.sourceFile });
  assert.deepEqual(storedSource.buffer, fixture.replacement);
  const replayed = await replaceSpinePart(project, { assetId: imported.id, revisionId: originalRevision, regionName: replacementRevision.recipe.regionName, buffer: storedSource.buffer, transform: replacementRevision.recipe.transform });
  assert.equal(replayed.revisions.at(-1).files.find(file => file.role === 'texture').sha256, replacementRevision.files.find(file => file.role === 'texture').sha256);
  const part = await extractSpinePart(project, { assetId: imported.id, revisionId: originalRevision, regionName: 'body' });
  const metadata = await sharp(part).metadata();
  assert.equal(metadata.width, 80);
  assert.equal(metadata.height, 96);
  const exported = await project.exportAsset({ assetId: imported.id, revisionId: replacementRevision.id });
  assert.deepEqual(await fs.readFile(path.join(root, exported.path, 'resources', 'fixture.json')), fixture.json);
  assert.deepEqual(await fs.readFile(path.join(root, exported.path, 'resources', 'fixture.atlas')), fixture.atlas);
  assert.equal((await project.snapshot()).assets[0].revisions.length, 3);
});

test('unsupported Spine import creates no project asset or revision', async t => {
  const { project } = await setup(t);
  const fixture = await createSpineFixture();
  const modified = JSON.parse(fixture.json);
  modified.skeleton.spine = '4.1.24';
  const files = fixture.files.map(file => file.name.endsWith('.json') ? { ...file, buffer: Buffer.from(JSON.stringify(modified)) } : file);
  await assert.rejects(importSpine(project, { name: 'old', files }), { code: 'INVALID_SPINE_ASSET' });
  await assert.rejects(importSpine(project, { files: [{ name: 'test.skel', buffer: Buffer.from('binary') }] }), { code: 'UNSUPPORTED_SKEL' });
  assert.deepEqual((await project.snapshot()).assets, []);
});

test('temporary Spine calibration matches committed pixels without writing any project state', async t => {
  const { root, project } = await setup(t), fixture = await createSpineFixture();
  const asset = await importSpine(project, fixture);
  const before = await fs.readFile(path.join(root, 'fwv.project.json'));
  const request = { assetId: asset.id, revisionId: asset.selectedRevisionId, regionName: 'body', buffer: fixture.replacement,
    transform: { scale: .65, offsetX: 4, offsetY: -3, rotation: 17, flipX: true } };
  const preview = await previewSpinePart(project, request);
  assert.deepEqual(await fs.readFile(path.join(root, 'fwv.project.json')), before);
  assert.equal((await project.snapshot()).assets[0].revisions.length, 1);
  const committed = await replaceSpinePart(project, request);
  const page = await project.readArtifact({ assetId: asset.id, revisionId: committed.selectedRevisionId, fileName: preview.pageName });
  assert.deepEqual(Buffer.from(preview.pageBase64, 'base64'), page.buffer);
  const part = await extractSpinePart(project, { assetId:asset.id, revisionId:committed.selectedRevisionId, regionName:'body' });
  assert.deepEqual(Buffer.from(preview.partBase64, 'base64'), part);
  assert.deepEqual(preview.transform, committed.revisions.at(-1).recipe.transform);
});

test('Spine part drafts accept legacy inputs and validate exact revision-region identities', () => {
  const data = { schemaVersion:1, projectId:'project', ...Object.fromEntries(AUTHORING_COLLECTIONS.map(key=>[key,[]])) };
  const legacy = { assetId:'asset', revisionId:'v1', regionName:'head', transform:{scale:2} };
  data.spineDrafts.push({id:'asset',data:legacy});
  assert.deepEqual(validateAuthoringData(data,'project').spineDrafts[0].data,legacy);
  legacy.partDrafts = [{revisionId:'v1',regionName:'head',transform:{scale:2}},{revisionId:'v1',regionName:'leg',transform:{scale:.5}},{revisionId:'v2',regionName:'head',transform:{scale:1}}];
  assert.deepEqual(validateAuthoringData(data,'project'),data);
  legacy.partDrafts.push({...legacy.partDrafts[0]});
  assert.throws(()=>validateAuthoringData(data,'project'),/重复/);
  legacy.partDrafts.pop(); legacy.partDrafts[0].transform.scale='2';
  assert.throws(()=>validateAuthoringData(data,'project'),{code:'INVALID_AUTHORING_DRAFT'});
  legacy.partDrafts[0].transform.scale=2; delete legacy.partDrafts[0].revisionId;
  assert.throws(()=>validateAuthoringData(data,'project'),/确切版本/);
});

test('export separates JPEG replacement provenance from reloadable Spine runtime files', async t => {
  const { root, project } = await setup(t);
  const fixture = await createSpineFixture();
  const imported = await importSpine(project, fixture);
  const source = await sharp(fixture.replacement).jpeg().toBuffer();
  const updated = await replaceSpinePart(project, { assetId: imported.id, regionName: 'body', buffer: source });
  const exported = await project.exportAsset({ assetId: imported.id });
  const reference = exported.manifest.files.find(file => file.role === 'reference');
  assert.ok(reference.path.startsWith('references/'));
  assert.deepEqual(await fs.readFile(path.join(root, exported.path, reference.path)), source);
  const resources = path.join(root, exported.path, 'resources');
  const names = await fs.readdir(resources);
  assert.deepEqual(names.sort(), ['fixture.atlas', 'fixture.json', 'fixture.png']);
  const reimported = await importSpine(project, { name: 'Reimported delivery', files: await Promise.all(names.map(async name => ({ name, buffer: await fs.readFile(path.join(resources, name)) }))) });
  assert.equal(reimported.revisions[0].files.find(file => file.role === 'texture').sha256,
    updated.revisions.at(-1).files.find(file => file.role === 'texture').sha256);
});
