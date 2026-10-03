import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { validateSkeleton2dDocument } from '../src/skeleton2d/document.mjs';
import { sampleSkeleton2d } from '../src/skeleton2d/sample.mjs';
import { importSkeleton2d, inspectSkeleton2d, saveSkeleton2d, exportSkeleton2d, readSkeleton2dBundle } from '../src/skeleton2d/application.mjs';
import { executeCommand } from '../src/editor/api.mjs';
import { handleSkeleton2dApi } from '../src/editor/skeleton2d-api.mjs';
import { createSkeleton2dDemo } from '../tools/create-skeleton2d-demo.mjs';
import { run } from '../bin/fwv.mjs';

const source = JSON.parse(await fs.readFile(new URL('../examples/skeleton2d/windmill.json', import.meta.url), 'utf8'));
const document = () => structuredClone(source);
const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#f7d157' } }).png().toBuffer();
const textures = () => ['tower.png', 'rotor.png'].map(name => ({ name, buffer: png }));
async function project(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-skeleton2d-')); t.after(() => fs.rm(root, { recursive: true, force: true })); const p = new FwvProject(root); await p.init(); return p; }
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('independent windmill example validates and samples parent transforms, aliases, loops and events', () => {
  const d = validateSkeleton2dDocument(document());
  const sample = sampleSkeleton2d(d, { skin: 'summer', animation: 'operate', time: 2.5 });
  assert.equal(sample.animation, 'turn'); near(sample.time, 0.5);
  near(sample.bones[2].matrix[0], 0); near(sample.bones[2].matrix[1], 1); near(sample.bones[2].matrix[5], 64);
  assert.equal(sample.events.length, 0);
  assert.equal(sampleSkeleton2d(d, { animation: 'turn', time: 1.5 }).events[0].int, 1);
  assert.ok(sample.socketPoints['rotor-tip']);
  assert.equal(sample.slots[1].region, 'rotor');
  const setup = sampleSkeleton2d(d, { skin: 'summer', animation: '', time: 22, loop: true });
  assert.equal(setup.duration, 0); assert.equal(setup.time, 0); assert.equal(setup.loop, false);
  assert.equal(setup.bones[2].rotation, 0); assert.equal(setup.slots.length, 2);
});

test('sampling supports skin setup, TRS, stepped keys, draw order, attachment hiding and clipping', () => {
  const d = document();
  d.skinBones = { summer: structuredClone(d.bones) }; d.skinBones.summer[2].rotationLimit = 30;
  d.animations.turn.bones.tower = { translate: [{ time: 0.25, x: 4, curve: 'stepped' }, { time: 1, x: 10 }], scale: [{ time: 0, x: 2, y: 3 }] };
  d.animations.turn.drawOrder = [{ time: 0.4, offsets: [{ slot: 'tower', offset: 1 }] }];
  d.animations.turn.slots = { rotor: { attachment: [{ time: 0.75, name: null }] } };
  d.clipBounds = { turn: { x: -20, y: 0, width: 40, height: 100 } };
  d.lines = [{ name: 'cable', slot: 'rotor', attachment: 'blades', color: '#444444', width: 1, points: [{ bone: 'root', x: 0, y: 0 }, { bone: 'rotor', x: 0, y: 0 }] }];
  validateSkeleton2dDocument(d);
  const before = sampleSkeleton2d(d, { animation: 'turn', time: 0.2 }); near(before.bones[1].x, 0);
  const a = sampleSkeleton2d(d, { animation: 'turn', time: 0.5 });
  near(a.bones[1].x, 4); near(a.bones[1].scaleY, 3); near(a.bones[2].rotation, 30);
  assert.deepEqual(a.drawOrder, ['rotor', 'tower']); assert.equal(a.slots[0].name, 'rotor');
  assert.deepEqual(a.clipBounds, d.clipBounds.turn); assert.equal(a.lines.length, 1);
  const hidden = sampleSkeleton2d(d, { animation: 'turn', time: 0.8 }); assert.equal(hidden.slots.length, 1); assert.equal(hidden.lines.length, 0);
});

test('schema fails closed for unsupported tracks, invalid hierarchy, times, references and numeric payloads', () => {
  const invalid = [
    d => d.animations.turn.bones.rotor.shear = [],
    d => d.animations.turn.bones.rotor.rotate[0].curve = [0, 0, 1, 1],
    d => d.bones[0].parent = 'rotor',
    d => d.bones[1].name = 'root',
    d => d.slots[0].bone = 'missing',
    d => d.skins[0].attachments.rotor.blades.path = 'missing',
    d => d.skins[0].attachments.rotor.blades.type = 'mesh',
    d => d.textures.rotor = '../rotor.png',
    d => d.bones[1].x = NaN,
    d => d.bones[1].scaleX = Infinity,
    d => d.animationDurations.turn = 0,
    d => d.animations.turn.bones.rotor.rotate[1].time = 3,
    d => d.animations.turn.bones.rotor.rotate[1].time = 0,
    d => d.animations.turn.events[0].name = 'missing',
    d => d.animations.turn.drawOrder = [{ time: 0, offsets: [{ slot: 'tower', offset: 2 }] }],
    d => d.animations.turn.drawOrder = [{ time: 0, offsets: [{ slot: 'tower', offset: 1 }, { slot: 'rotor', offset: 0 }] }],
    d => d.skinBones = { summer: [d.bones[0]] },
    d => d.skinAnimations.summer.operate = 'missing',
    d => d.skinSockets.summer['rotor-tip'] = 'missing',
    d => d.clipBounds = { turn: { x: 0, y: 0, width: -1, height: 20 } },
    d => d.metadata.unknown = undefined,
    d => d.skins[0].attachments.rotor.blades.string = {},
  ];
  for (const mutate of invalid) { const d = document(); mutate(d); assert.throws(() => validateSkeleton2dDocument(d), /Skeleton2D/); }
});

test('import/read/save/export preserve exact textures and immutable old revisions', async t => {
  const p = await project(t), d = document();
  const asset = await importSkeleton2d(p, { name: 'Independent machine', document: d, textures: textures(), idempotencyKey: 'machine-v1' });
  const first = asset.selectedRevisionId;
  const inspection = await inspectSkeleton2d(p, { assetId: asset.id, revisionId: first });
  assert.equal(inspection.textureFiles.length, 2); assert.deepEqual(inspection.document, d);
  d.bones[1].y = 40;
  const updated = await saveSkeleton2d(p, { assetId: asset.id, revisionId: first, expectedRevisionId: first, document: d });
  assert.equal(updated.revisions.length, 2); assert.equal(updated.revisions[1].parentId, first);
  const original = await inspectSkeleton2d(p, { assetId: asset.id, revisionId: first }); assert.equal(original.document.bones[1].y, 32);
  const bundle = await readSkeleton2dBundle(p, { assetId: asset.id, revisionId: updated.selectedRevisionId });
  assert.deepEqual(bundle.document, d); for (const file of bundle.files.filter(file => file.role === 'texture')) assert.deepEqual(file.buffer, png);
  const pkg = await exportSkeleton2d(p, { assetId: asset.id, revisionId: updated.selectedRevisionId });
  assert.equal(pkg.manifest.validation.coverage, 'skeleton2d-and-files');
  assert.equal(pkg.manifest.validation.status, 'passed'); assert.equal(pkg.manifest.validation.humanAcceptance, 'not-reviewed');
  const exported = JSON.parse(await fs.readFile(path.join(p.root, pkg.path, 'resources', 'skeleton2d.json'), 'utf8')); assert.deepEqual(exported, d);
  const replay = await importSkeleton2d(p, { name: 'Independent machine', document: document(), textures: textures(), idempotencyKey: 'machine-v1' });
  assert.equal(replay.id, asset.id); assert.equal(replay.selectedRevisionId, updated.selectedRevisionId);
});

test('two writers of the same revision produce exactly one successful save', async t => {
  const p = await project(t), asset = await importSkeleton2d(p, { document: document(), textures: textures() });
  const args = { assetId: asset.id, revisionId: asset.selectedRevisionId, expectedRevisionId: asset.selectedRevisionId, document: document() };
  const results = await Promise.allSettled([saveSkeleton2d(p, args), saveSkeleton2d(new FwvProject(p.root), args)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal((await p.snapshot()).assets[0].revisions.length, 2);
  await assert.rejects(saveSkeleton2d(p, { ...args, expectedRevisionId: 'latest' }), /expectedRevisionId/);
});

test('texture references and actual PNG integrity reject incomplete or disguised imports', async t => {
  const p = await project(t);
  await assert.rejects(importSkeleton2d(p, { document: document(), textures: textures().slice(0, 1) }), /exactly/);
  await assert.rejects(importSkeleton2d(p, { document: document(), textures: [...textures(), { name: 'extra.png', buffer: png }] }), /exactly/);
  const jpeg = await sharp(png).jpeg().toBuffer();
  await assert.rejects(importSkeleton2d(p, { document: document(), textures: textures().map(file => ({ ...file, buffer: jpeg })) }), /actual PNG/);
  const d = document(); d.textures.rotor = 'different.png';
  await assert.rejects(importSkeleton2d(p, { document: d, textures: textures() }), /Missing/);
  assert.equal((await p.snapshot()).assets.length, 0);
});

test('generic validation/export cannot bypass domain validation with arbitrary importAsset', async t => {
  const p = await project(t), d = document(); d.animations.turn.bones.rotor.shear = [];
  const asset = await p.importAsset({ kind: 'skeleton2d', files: [{ name: 'skeleton2d.json', role: 'skeleton2d', mime: 'application/json', buffer: Buffer.from(JSON.stringify(d)) }, ...textures().map(file => ({ ...file, role: 'texture', mime: 'image/png' }))] });
  const args = { assetId: asset.id, revisionId: asset.selectedRevisionId };
  const validation = await p.validateRevision(args);
  assert.equal(validation.status, 'failed'); assert.equal(validation.checks.find(check => check.id === 'skeleton2d-structure').status, 'failed');
  await assert.rejects(p.exportAsset(args), /Export blocked/);
});

test('artifact tampering prevents read and generic export', async t => {
  const p = await project(t), asset = await importSkeleton2d(p, { document: document(), textures: textures() });
  await fs.writeFile(path.join(p.root, 'assets', asset.id, asset.selectedRevisionId, 'rotor.png'), Buffer.alloc(png.length));
  const args = { assetId: asset.id, revisionId: asset.selectedRevisionId };
  await assert.rejects(inspectSkeleton2d(p, args), /hash mismatch/); await assert.rejects(p.exportAsset(args), /Export blocked/);
});

test('application commands reject unknown fields and share import/save/export behavior', async t => {
  const p = await project(t);
  const asset = await executeCommand(p, { type: 'skeleton2d.import', payload: { document: document(), textures: textures().map(file => ({ name: file.name, base64: file.buffer.toString('base64') })) } });
  const d = document(); d.animations.turn.bones.rotor.rotate[1].value = 180;
  const updated = await executeCommand(p, { type: 'skeleton2d.save', payload: { assetId: asset.id, revisionId: asset.selectedRevisionId, expectedRevisionId: asset.selectedRevisionId, document: d } });
  const pkg = await executeCommand(p, { type: 'skeleton2d.export', payload: { assetId: asset.id, revisionId: updated.selectedRevisionId } }); assert.equal(pkg.manifest.kind, 'skeleton2d');
  await assert.rejects(executeCommand(p, { type: 'skeleton2d.save', payload: { assetId: asset.id, revisionId: updated.selectedRevisionId, expectedRevisionId: updated.selectedRevisionId, document: d, path: '../../' } }), /参数/);
});

test('protected runtime serves a fixed pure module and rejects arbitrary module paths', async () => {
  const headers = {}, result = {};
  const res = { writeHead: (status, value) => Object.assign(headers, { status, ...value }), end: data => result.body = data.toString() };
  assert.equal(await handleSkeleton2dApi({ req: { method: 'GET' }, res, url: new URL('http://localhost/api/fwv/skeleton2d-runtime') }), true);
  assert.equal(headers.status, 200); assert.match(result.body, /export function sampleSkeleton2d/); assert.doesNotMatch(result.body, /node:|miaocheng|cat0|rat0/);
  await assert.rejects(handleSkeleton2dApi({ req: { method: 'GET' }, res, url: new URL('http://localhost/api/fwv/skeleton2d-runtime?path=../../private') }), /参数/);
});

test('second reusable example and CLI round-trip do not require a game workspace', async t => {
  const p = await project(t), demo = await createSkeleton2dDemo(p.root);
  const inspection = await run(['skeleton2d-inspect', '--project', p.root, '--asset', demo.assetId, '--revision', demo.revisionId]);
  assert.equal(inspection.name, 'Windmill · reusable 2D example');
  assert.equal(inspection.textureData, undefined, 'CLI inspection does not emit binary payloads');
  const file = path.join(p.root, 'edited.json'), d = inspection.document; d.bones[1].y = 45; await fs.writeFile(file, JSON.stringify(d));
  const saved = await run(['skeleton2d-save', '--project', p.root, '--asset', demo.assetId, '--revision', demo.revisionId, '--file', file]);
  const pkg = await run(['skeleton2d-export', '--project', p.root, '--asset', demo.assetId, '--revision', saved.selectedRevisionId]); assert.equal(pkg.manifest.validation.status, 'passed');
});
