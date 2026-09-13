import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { createRigDraft, forkRigDraft, loadRigDraft, saveRigDraft, buildRigCandidate } from '../src/rig/application.mjs';
import { extractRegion } from '../src/spine/index.mjs';
import { buildReskinSheet } from '../src/spine/reskin-template.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const raw = buffer => sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const rectangle = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const motion = { idle: true, walk: true, wave: true };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-rig-'));
  t.after(async () => { if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup path'); await fs.rm(root, { recursive: true, force: true }); });
  const project = new FwvProject(root); await project.init({ name: 'Rig fixture' });
  const definitions = [
    ['arm-left', 3, 16, 7, 14, 10, 17, 'torso', [80, 150, 220]],
    ['leg-left', 10, 30, 6, 14, 13, 30, 'torso', [60, 90, 180]],
    ['leg-right', 16, 30, 6, 14, 19, 30, 'torso', [90, 130, 210]],
    ['torso', 10, 16, 12, 14, 16, 28, null, [220, 100, 40]],
    ['head', 11, 4, 10, 12, 16, 16, 'torso', [240, 180, 70]],
    ['arm-right', 22, 16, 7, 14, 22, 17, 'torso', [110, 185, 240]],
  ];
  const pixels = Buffer.alloc(32 * 48 * 4);
  for (const [, x, y, width, height, , , , color] of definitions) for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) pixels.set([...color, row === y && col === x ? 128 : 255], (row * 32 + col) * 4);
  const buffer = await sharp(pixels, { raw: { width: 32, height: 48, channels: 4 } }).png().toBuffer();
  const source = await project.importImage({ name: 'Original humanoid', fileName: 'humanoid.png', buffer });
  const created = await createRigDraft(project, { sourceAssetId: source.id, sourceRevisionId: source.selectedRevisionId });
  const parts = definitions.map(([id, x, y, width, height, px, py, parentId]) => ({ id, name: id, role: id, parentId, polygon: rectangle(x, y, width, height), pivot: { x: px, y: py } }));
  return { root, project, source, buffer, created, parts, pixels };
}

test('editable rig draft persists the exact source and matching reference document metadata', async t => {
  const { project, source, buffer, created } = await fixture(t);
  assert.equal(created.asset.kind, 'rig');
  const loaded = await loadRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id });
  assert.equal(loaded.document.schemaVersion, 1);
  assert.equal(loaded.document.parts.length, 6);
  assert.equal(loaded.document.source.assetId, source.id);
  assert.equal(loaded.document.source.width, 32);
  assert.equal(loaded.document.source.height, 48);
  const json = await project.readArtifact({ assetId: created.asset.id, revisionId: created.revision.id, fileName: 'rig.json' });
  assert.deepEqual(JSON.parse(json.buffer), loaded.document);
  assert.deepEqual(loaded.revision.metadata.rig, loaded.document);
  const reference = await project.readArtifact({ assetId: created.asset.id, revisionId: created.revision.id, fileName: loaded.document.source.referenceFile });
  assert.deepEqual(reference.buffer, buffer);
  assert.equal(loaded.document.source.sha256, hash(buffer));
  assert.ok(loaded.document.warnings.some(warning => warning.code === 'RIG_MANUAL_SEGMENTATION'));
});

test('cutout atlas preserves polygon-selected RGBA and builds a new Spine asset usable by reskin/export', async t => {
  const { root, project, buffer, created, parts } = await fixture(t);
  const saved = await saveRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id, parts, motion });
  const built = await buildRigCandidate(project, { assetId: saved.asset.id, revisionId: saved.revision.id });
  assert.equal(built.asset.kind, 'spine');
  assert.notEqual(built.asset.id, saved.asset.id);
  const revision = built.revision;
  const files = new Map();
  for (const file of revision.files) files.set(file.name, (await project.readArtifact({ assetId: built.asset.id, revisionId: revision.id, fileName: file.name })).buffer);
  const atlas = files.get('character.atlas');
  const pages = new Map(revision.files.filter(file => file.role === 'texture').map(file => [file.name, files.get(file.name)]));
  for (const check of revision.metadata.rig.partChecks) {
    const actual = await extractRegion({ atlas, pages, regionName: check.regionName });
    const expected = await sharp(buffer).extract({ left: check.bounds.x, top: check.bounds.y, width: check.bounds.width, height: check.bounds.height }).png().toBuffer();
    assert.deepEqual((await raw(actual)).data, (await raw(expected)).data);
    assert.ok(check.visiblePixels > 0);
  }
  assert.deepEqual(files.get(revision.metadata.rig.source.referenceFile), buffer);
  assert.deepEqual(JSON.parse(files.get('rig.json')), revision.metadata.rig);
  assert.deepEqual(revision.metadata.rig.draft, { assetId: saved.asset.id, revisionId: saved.revision.id });
  assert.equal(revision.metadata.spine.supported, true);
  assert.deepEqual(revision.metadata.spine.animations, ['idle', 'walk', 'wave']);
  const guide = await buildReskinSheet(project, { assetId: built.asset.id, revisionId: revision.id });
  assert.equal(guide.layout.parts.length, 6);
  const exported = await project.exportAsset({ assetId: built.asset.id, revisionId: revision.id });
  assert.deepEqual(await fs.readFile(path.join(root, exported.path, 'references', revision.metadata.rig.source.referenceFile)), buffer);
  assert.equal((await project.snapshot()).assets.find(asset => asset.id === saved.asset.id).revisions.length, 2);
});

test('official runtime validates parent-local pivot conversion, independent draw order and actual generated motion', async t => {
  let runtime;
  try { runtime = await import('@esotericsoftware/spine-core'); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return t.skip('Optional official Spine runtime unavailable'); throw error; }
  const { project, created, parts } = await fixture(t);
  const reordered = structuredClone(parts).reverse();
  reordered.find(part => part.id === 'arm-left').parentId = 'head';
  const saved = await saveRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id, parts: reordered, motion });
  const built = await buildRigCandidate(project, { assetId: saved.asset.id, revisionId: saved.revision.id });
  const json = JSON.parse((await project.readArtifact({ assetId: built.asset.id, revisionId: built.revision.id, fileName: 'character.json' })).buffer);
  const atlasText = (await project.readArtifact({ assetId: built.asset.id, revisionId: built.revision.id, fileName: 'character.atlas' })).buffer.toString();
  assert.deepEqual(json.slots.map(slot => slot.name), reordered.map(part => `slot_${part.id}`));
  for (const bone of json.bones.slice(1)) assert.ok(json.bones.findIndex(item => item.name === bone.parent) < json.bones.indexOf(bone));
  const data = new runtime.SkeletonJson(new runtime.AtlasAttachmentLoader(new runtime.TextureAtlas(atlasText))).readSkeletonData(json);
  const skeleton = new runtime.Skeleton(data); skeleton.setToSetupPose(); skeleton.updateWorldTransform(runtime.Physics.update);
  for (const part of reordered) {
    const exportedBone = json.bones.find(item => item.name === `part_${part.id}`);
    const parent = reordered.find(item => item.id === part.parentId);
    assert.equal(exportedBone.x, part.pivot.x - (parent ? parent.pivot.x : 16));
    assert.equal(exportedBone.y, (parent ? parent.pivot.y : 48) - part.pivot.y);
    let chain = exportedBone, x = 0, y = 0, depth = 0;
    while (chain) { x += chain.x ?? 0; y += chain.y ?? 0; depth++; chain = json.bones.find(item => item.name === chain.parent); }
    // Exact exported geometry is checked independently of the runtime's trigonometry.
    assert.equal(x, part.pivot.x - 16);
    assert.equal(y, 48 - part.pivot.y);
    const attachment = json.skins[0].attachments[`slot_${part.id}`][`part_${part.id}`];
    const minX = Math.min(...part.polygon.map(point => point.x)) - 16;
    const maxY = 48 - Math.min(...part.polygon.map(point => point.y));
    assert.equal(x + attachment.x - attachment.width / 2, minX);
    assert.equal(y + attachment.y + attachment.height / 2, maxY);
    // Spine 4.2 uses PI=3.1415927, so a zero-rotation matrix has a small
    // cos(90deg) term. Bound its accumulation by image height and chain depth;
    // vertices additionally incur Float32 rounding at this coordinate magnitude.
    const trigError = Math.abs(Math.cos(90 * runtime.MathUtils.degRad));
    const worldTolerance = trigError * 48 * depth + Number.EPSILON * 48 * 16;
    const vertexTolerance = worldTolerance + 48 * 2 ** -24;
    const bone = skeleton.findBone(`part_${part.id}`);
    assert.ok(Math.abs(bone.worldX - x) <= worldTolerance, `${part.id} runtime worldX drift exceeds its numerical bound`);
    assert.ok(Math.abs(bone.worldY - y) <= worldTolerance, `${part.id} runtime worldY drift exceeds its numerical bound`);
    const slot = skeleton.findSlot(`slot_${part.id}`), vertices = new Float32Array(8);
    slot.attachment.computeWorldVertices(slot, vertices, 0, 2);
    const xs = [vertices[0], vertices[2], vertices[4], vertices[6]], ys = [vertices[1], vertices[3], vertices[5], vertices[7]];
    assert.ok(Math.abs(Math.min(...xs) - minX) <= vertexTolerance);
    assert.ok(Math.abs(Math.max(...ys) - maxY) <= vertexTolerance);
  }
  const state = new runtime.AnimationState(new runtime.AnimationStateData(data));
  state.setAnimation(0, 'idle', false); state.update(1); state.apply(skeleton);
  assert.ok(skeleton.findBone('root').y > 0);
  skeleton.setToSetupPose(); state.setAnimation(0, 'walk', false); state.update(.25); state.apply(skeleton);
  assert.ok(skeleton.findBone('part_leg-left').rotation > 17);
  assert.ok(skeleton.findBone('part_leg-right').rotation < -17);
  skeleton.setToSetupPose(); state.setAnimation(0, 'wave', false); state.update(.35); state.apply(skeleton);
  assert.ok(skeleton.findBone('part_arm-right').rotation > 59);
});

test('polygon center masking keeps original alpha and zeroes pixels outside a triangle', async t => {
  const { project, created, buffer } = await fixture(t);
  const parts = [{ id: 'triangle', name: 'Triangle', role: 'accessory', parentId: null, pivot: { x: 10, y: 16 }, polygon: [{ x: 10, y: 16 }, { x: 22, y: 16 }, { x: 10, y: 30 }] }];
  const saved = await saveRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id, parts, motion: { idle: false, walk: false, wave: false } });
  const built = await buildRigCandidate(project, { assetId: saved.asset.id, revisionId: saved.revision.id });
  const atlas = (await project.readArtifact({ assetId: built.asset.id, revisionId: built.revision.id, fileName: 'character.atlas' })).buffer;
  const pages = new Map(); for (const file of built.revision.files.filter(file => file.role === 'texture')) pages.set(file.name, (await project.readArtifact({ assetId: built.asset.id, revisionId: built.revision.id, fileName: file.name })).buffer);
  const data = (await raw(await extractRegion({ atlas, pages, regionName: 'part_triangle' }))).data;
  const original = (await raw(buffer)).data;
  assert.deepEqual(data.subarray(0, 4), original.subarray((16 * 32 + 10) * 4, (16 * 32 + 10) * 4 + 4));
  assert.equal(data[(13 * 12 + 11) * 4 + 3], 0);
  assert.deepEqual(built.revision.metadata.spine.animations, []);
});

test('malformed polygons, pivots, duplicate IDs and parent cycles cannot save revisions', async t => {
  const { project, created, parts } = await fixture(t);
  const failures = [
    value => { value[0].polygon = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]; },
    value => { value[0].polygon = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }]; },
    value => { value[0].polygon[0].x = -1; },
    value => { value[0].polygon[0].y = NaN; },
    value => { value[0].pivot.x = Infinity; },
    value => { value[0].pivot.y = 49; },
    value => { value[0].id = value[1].id; },
    value => { value[0].parentId = 'not-a-part'; },
    value => { value.find(part => part.id === 'torso').parentId = 'head'; },
    value => { value[0].polygon = Array.from({ length: 65 }, (_, i) => ({ x: i / 3, y: i % 2 })); },
  ];
  for (const mutate of failures) {
    const modified = structuredClone(parts); mutate(modified);
    await assert.rejects(saveRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id, parts: modified, motion }));
    assert.equal((await project.snapshot()).assets.find(asset => asset.id === created.asset.id).revisions.length, 1);
  }
});

test('empty masks remain editable draft warnings but cannot create invisible Spine candidates', async t => {
  const { project, created } = await fixture(t);
  const parts = [{ id: 'empty', name: 'Empty corner', role: 'accessory', parentId: null, pivot: { x: 0, y: 0 }, polygon: rectangle(0, 0, 2, 2) }];
  const saved = await saveRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id, parts, motion });
  assert.ok(saved.revision.metadata.rig.warnings.some(warning => warning.code === 'RIG_EMPTY_PART'));
  const count = (await project.snapshot()).assets.length;
  await assert.rejects(buildRigCandidate(project, { assetId: saved.asset.id, revisionId: saved.revision.id }), { code: 'RIG_EMPTY_PART' });
  assert.equal((await project.snapshot()).assets.length, count);
});

test('draft saves enforce CAS under concurrency and preserve prior source/document revisions', async t => {
  const { project, created, parts } = await fixture(t);
  const params = { assetId: created.asset.id, revisionId: created.revision.id, parts, motion };
  const results = await Promise.allSettled([saveRigDraft(project, params), saveRigDraft(project, params)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await assert.rejects(saveRigDraft(project, params), { status: 409 });
  assert.equal((await project.snapshot()).assets.find(asset => asset.id === created.asset.id).revisions.length, 2);
  const original = await loadRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id });
  assert.deepEqual(original.document, created.revision.metadata.rig);
});

test('historical rig fork preserves exact pixels and provenance while current saves keep CAS', async t => {
  const { project, created, parts, buffer } = await fixture(t);
  const edited = await saveRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id, parts, motion });
  const edits = structuredClone(created.revision.metadata.rig.parts); edits[0].name = 'Recovered historical edit';
  const before = await loadRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id });
  const [forked, latest] = await Promise.all([
    forkRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id, name: 'Historical fork', parts: edits }),
    saveRigDraft(project, { assetId: edited.asset.id, revisionId: edited.revision.id, parts, motion: { ...motion, wave: false } }),
  ]);
  const origin = { assetId: created.asset.id, revisionId: created.revision.id };
  assert.notEqual(forked.asset.id, created.asset.id);
  assert.equal(forked.asset.revisions.length, 1);
  assert.deepEqual(forked.revision.metadata.rig.forkedFrom, origin);
  assert.deepEqual(forked.revision.recipe.forkedFrom, origin);
  assert.deepEqual(forked.revision.metadata.rig.source, before.document.source);
  assert.deepEqual(forked.revision.metadata.rig.parts, edits);
  assert.deepEqual((await project.readArtifact({ assetId: forked.asset.id, revisionId: forked.revision.id, fileName: before.document.source.referenceFile })).buffer, buffer);
  assert.deepEqual((await loadRigDraft(project, origin)).document, before.document);
  const source = (await project.snapshot()).assets.find(item => item.id === created.asset.id);
  assert.equal(source.selectedRevisionId, latest.revision.id); assert.equal(source.revisions.length, 3);
  await assert.rejects(saveRigDraft(project, { ...origin, parts, motion }), { status: 409 });
  const forkParams = { assetId: forked.asset.id, revisionId: forked.revision.id, parts, motion };
  const results = await Promise.allSettled([saveRigDraft(project, forkParams), saveRigDraft(project, forkParams)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
});

test('rig document tampering and reference corruption fail before edits or builds', async t => {
  const { root, project, created, parts } = await fixture(t);
  const directory = path.join(root, 'assets', created.asset.id, created.revision.id);
  const sourceName = created.revision.metadata.rig.source.referenceFile;
  const sourcePath = path.join(directory, sourceName);
  const original = await fs.readFile(sourcePath);
  const altered = Buffer.from(original); altered[altered.length - 1] ^= 1; await fs.writeFile(sourcePath, altered);
  await assert.rejects(loadRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id }), /hash mismatch/);
  await assert.rejects(buildRigCandidate(project, { assetId: created.asset.id, revisionId: created.revision.id }), /hash mismatch/);
  await fs.writeFile(sourcePath, original);
  const manifestPath = path.join(root, 'fwv.project.json'), manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.assets.find(asset => asset.id === created.asset.id).revisions[0].metadata.rig.parts[0].name = 'Tampered metadata';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(saveRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id, parts, motion }), { code: 'RIG_DOCUMENT_MISMATCH' });
  assert.equal((await project.snapshot()).assets.length, 2);
});
