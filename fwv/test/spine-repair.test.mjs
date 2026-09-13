import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FwvProject } from '../src/core/project.mjs';
import { importSpine } from '../src/spine/application.mjs';
import { ArtChanges, executeChangeCommand } from '../src/workflows/changes.mjs';
import { createSpineFixture } from '../examples/spine-fixture/create.mjs';
import { prepareSpineRepair } from '../src/spine/repair.mjs';
import { run } from '../bin/fwv.mjs';

async function fixture(t, { weighted = false, linked = false } = {}) {
  const prefix = path.join(os.tmpdir(), 'fwv-spine-repair-'), root = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(root.startsWith(prefix) && path.dirname(root) === path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const project = new FwvProject(root); await project.init({ name: 'Spine 修复测试' });
  const original = await createSpineFixture(), skeleton = JSON.parse(original.json);
  skeleton.bones = [{ name: 'root' }, { name: 'pelvis', parent: 'root', x: 10 }, { name: 'body', parent: 'root', y: 48 }, { name: 'tip', parent: 'body', y: 30 }, { name: 'later', parent: 'root' }];
  if (weighted) {
    skeleton.skins[0].attachments['body-slot'].body = { type: 'mesh', path: 'body', uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 2, 3, 0], hull: 4,
      vertices: [-40, -48, 40, -48, 40, 48, -40, 48].flatMap((value, index, coordinates) => index % 2 ? [] : [2, 1, value, coordinates[index + 1], .5, 2, value, coordinates[index + 1], .5]) };
    if (linked) skeleton.skins[0].attachments['body-slot'].copy = { type: 'linkedmesh', path: 'body', parent: 'body' };
  }
  const bytes = Buffer.from(JSON.stringify(skeleton, null, 2) + '\n');
  const source = await importSpine(project, { name: '已有角色', files: original.files.map(file => file.name.endsWith('.json') ? { ...file, buffer: bytes } : file) });
  const changes = new ArtChanges({ project });
  const change = await changes.create({ sourceAssetId: source.id, sourceRevisionId: source.selectedRevisionId, title: '身体绑定修复', request: '身体应跟随髋部，检查动作中局部变换。', preserve: '保持其他骨骼局部数据、贴图和动画时间线。',
    anchors: { objects: ['bone:body'], animation: { name: 'idle', time: .6 }, view: { pose: 'setup' } } });
  return { root, project, original, source, changes, change, skeleton, bytes };
}
async function readSkeleton(project, ref) { return JSON.parse((await project.readArtifact({ assetId: ref.assetId, revisionId: ref.revisionId, fileName: 'fixture.json' })).buffer); }
async function runtime(t) {
  try { return await import('@esotericsoftware/spine-core'); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') { t.skip('Optional official Spine runtime unavailable'); return null; } throw error; }
}
function player(s, skeleton, atlas) {
  const data = new s.SkeletonJson(new s.AtlasAttachmentLoader(new s.TextureAtlas(atlas.toString('utf8')))).readSkeletonData(skeleton);
  const result = new s.Skeleton(data); result.setToSetupPose(); result.updateWorldTransform(s.Physics.update);
  return { data, skeleton: result };
}

test('inspection before a request exposes real bone parents, setup transforms, animation anchors and mesh weights', async t => {
  const f = await fixture(t, { weighted: true });
  const inspected = await executeChangeCommand(f.changes, { type: 'change.spine.inspect', payload: { assetId: f.source.id, revisionId: f.source.selectedRevisionId } });
  const body = inspected.bones.find(bone => bone.name === 'body');
  assert.equal(body.parent, 'root'); assert.equal(body.local.y, 48); assert.deepEqual(body.allowedParents, ['root', 'pelvis']);
  assert.deepEqual(body.children, ['tip']); assert.equal(body.timelines[0].animation, 'idle');
  assert.deepEqual(inspected.animations, [{ name: 'idle', duration: 1.2 }, { name: 'wave', duration: .6 }]);
  assert.equal(inspected.meshes[0].weighted, true); assert.equal(inspected.meshes[0].vertexCount, 4); assert.equal(inspected.meshes[0].influenceCount, 8);
  const detail = await f.changes.inspectSpine({ changeId: f.change.id, mesh: { skin: 'default', slot: 'body-slot', attachment: 'body' }, vertexIndex: 0 });
  assert.deepEqual(detail.vertex.influences.map(item => [item.boneName, item.weight]), [['pelvis', .5], ['body', .5]]);
  assert.deepEqual(detail.anchors.animation, { name: 'idle', time: .6 });
  assert.equal(inspected.capabilities.animationEditing, false);
});

test('parent and local transform repair create a playable pending candidate while preserving unrelated bone and animation data', async t => {
  const f = await fixture(t), s = await runtime(t); if (!s) return;
  const repaired = await f.changes.repairSpine({ changeId: f.change.id, requestId: 'body-reparent', boneEdits: [{ boneName: 'body', parent: 'pelvis', local: { x: 8, y: 53, scaleX: 1.25 } }] });
  const candidate = repaired.candidates[0], json = await readSkeleton(f.project, candidate);
  assert.equal(candidate.review.decision, 'pending'); assert.equal(candidate.validation.status, 'passed');
  assert.deepEqual(json.animations, f.skeleton.animations); assert.deepEqual(json.slots, f.skeleton.slots); assert.deepEqual(json.skins, f.skeleton.skins);
  assert.deepEqual(json.bones.filter(bone => bone.name !== 'body'), f.skeleton.bones.filter(bone => bone.name !== 'body'));
  for (const fileName of ['fixture.atlas', 'fixture.png']) assert.deepEqual((await f.project.readArtifact({ ...candidate, fileName })).buffer, f.original.files.find(file => file.name === fileName).buffer);
  assert.deepEqual((await f.project.readArtifact({ assetId: f.source.id, revisionId: f.source.selectedRevisionId, fileName: 'fixture.json' })).buffer, f.bytes);
  const before = player(s, f.skeleton, f.original.atlas), after = player(s, json, f.original.atlas);
  // The official runtime's PI=3.1415927 leaves a small cos(90deg) term.
  // Bound the accumulated three-bone transform error using this fixture's extent.
  const tolerance = Math.abs(Math.cos(90 * s.MathUtils.degRad)) * 128 * 3 + Number.EPSILON * 128 * 16;
  assert.ok(Math.abs(before.skeleton.findBone('body').worldX) <= tolerance);
  assert.ok(Math.abs(after.skeleton.findBone('body').worldX - 18) <= tolerance);
  assert.ok(Math.abs(after.skeleton.findBone('body').worldY - 53) <= tolerance);
  const state = new s.AnimationState(new s.AnimationStateData(after.data));
  for (const animation of ['idle', 'wave']) for (const time of [0, .3, .6]) {
    after.skeleton.setToSetupPose(); state.setAnimation(0, animation, false).trackTime = time; state.apply(after.skeleton); after.skeleton.updateWorldTransform(s.Physics.update);
    for (const bone of after.skeleton.bones) for (const property of ['worldX', 'worldY', 'a', 'b', 'c', 'd']) assert.ok(Number.isFinite(bone[property]), `${animation} ${time} ${bone.data.name}.${property}`);
  }
  assert.equal((await f.project.snapshot()).assets.find(asset => asset.id === f.source.id).selectedRevisionId, f.source.selectedRevisionId);
  await f.changes.review({ changeId: f.change.id, candidateId: candidate.id, decision: 'accepted', comment: 'idle 0.6 秒对照通过。' });
  const adopted = await f.changes.adopt({ changeId: f.change.id, candidateId: candidate.id });
  assert.deepEqual(await readSkeleton(f.project, adopted.adoption), json);
  const again = await f.changes.repairSpine({ changeId: f.change.id, requestId: 'body-reparent', boneEdits: [{ boneName: 'body', parent: 'pelvis', local: { x: 8, y: 53, scaleX: 1.25 } }] });
  assert.equal(again.candidates.length, 1);
});

test('bone repair rejects unknown bones, cycles, later parents, invalid numbers and no-op patches before registering a candidate', async t => {
  const f = await fixture(t), before = await f.project.snapshot();
  const edits = [
    [{ boneName: 'missing', local: { x: 1 } }], [{ boneName: 'body', parent: 'missing' }], [{ boneName: 'body', parent: 'tip' }],
    [{ boneName: 'body', parent: 'later' }], [{ boneName: 'root', parent: 'pelvis' }], [{ boneName: 'body', local: { scaleX: Infinity } }],
    [{ boneName: 'body', local: { length: -1 } }], [{ boneName: 'body', local: { y: 48 } }], [{ boneName: 'body', local: { name: 'replacement' } }],
  ];
  for (const [index, boneEdits] of edits.entries()) await assert.rejects(f.changes.repairSpine({ changeId: f.change.id, requestId: 'invalid-' + index, boneEdits }));
  assert.deepEqual(await f.project.snapshot(), before);
});

test('single weighted mesh influence redistributes only its vertex and keeps official runtime geometry finite', async t => {
  const f = await fixture(t, { weighted: true }), s = await runtime(t); if (!s) return;
  const edit = { skin: 'default', slot: 'body-slot', attachment: 'body', vertexIndex: 0, boneName: 'body', weight: .75 };
  const changed = await f.changes.repairSpine({ changeId: f.change.id, requestId: 'weight-0', weightEdits: [edit] });
  const candidate = changed.candidates[0], json = await readSkeleton(f.project, candidate);
  const originalVertices = f.skeleton.skins[0].attachments['body-slot'].body.vertices, vertices = json.skins[0].attachments['body-slot'].body.vertices;
  assert.equal(vertices[4], .25); assert.equal(vertices[8], .75);
  for (let index = 0; index < vertices.length; index++) if (![4, 8].includes(index)) assert.equal(vertices[index], originalVertices[index]);
  assert.deepEqual(json.bones, f.skeleton.bones); assert.deepEqual(json.animations, f.skeleton.animations);
  const result = player(s, json, f.original.atlas), slot = result.skeleton.findSlot('body-slot'), attachment = slot.getAttachment();
  const world = new Float32Array(attachment.worldVerticesLength);
  attachment.computeWorldVertices(slot, 0, world.length, world, 0, 2); assert.equal(world.length, 8);
  assert.ok([...world].every(Number.isFinite));
  const detail = candidate.metadata.spineRepair.edits[0]; assert.equal(detail.normalization, 'other-existing-influences-proportional');
  assert.equal(detail.after.reduce((sum, item) => sum + item.weight, 0), 1);
  await assert.rejects(f.changes.repairSpine({ changeId: f.change.id, requestId: 'weight-unknown', weightEdits: [{ ...edit, boneName: 'root' }] }), /不新增绑定/);
  await assert.rejects(f.changes.repairSpine({ changeId: f.change.id, requestId: 'weight-outside', weightEdits: [{ ...edit, weight: 1.1 }] }), /0 到 1/);
});

test('linked and malformed meshes are never advertised as editable generic weights', async t => {
  const f = await fixture(t, { weighted: true, linked: true });
  const report = await f.changes.inspectSpine({ changeId: f.change.id });
  assert.equal(report.meshes[0].editable, false); assert.equal(report.meshes[1].editable, false);
  await assert.rejects(f.changes.repairSpine({ changeId: f.change.id, requestId: 'linked', weightEdits: [{ skin: 'default', slot: 'body-slot', attachment: 'body', vertexIndex: 0, boneName: 'body', weight: .75 }] }), /关联网格/);
  const malformed = structuredClone(f.skeleton); malformed.skins[0].attachments['body-slot'].body.vertices.pop();
  const bad = await importSpine(f.project, { name: '格式缺损', files: f.original.files.map(file => file.name.endsWith('.json') ? { ...file, buffer: Buffer.from(JSON.stringify(malformed)) } : file) });
  await assert.rejects(prepareSpineRepair(f.project, { asset: bad, revision: bad.revisions[0] }, { boneEdits: [{ boneName: 'body', local: { x: 1 } }] }), /influence/);
});

test('the CLI executes the same existing-Spine repair command and keeps human review pending', async t => {
  const f = await fixture(t), file = path.join(f.root, 'repair.json');
  await fs.writeFile(file, JSON.stringify({ type: 'change.candidate.spine-repair', payload: { changeId: f.change.id, requestId: 'cli-repair', boneEdits: [{ boneName: 'body', local: { x: 4 } }] } }));
  const result = await run(['change', '--project', f.root, '--file', file], { env: {} });
  assert.equal(result.candidates[0].review.decision, 'pending'); assert.equal(result.candidates[0].metadata.spineRepair.edits[0].after.local.x, 4);
});
