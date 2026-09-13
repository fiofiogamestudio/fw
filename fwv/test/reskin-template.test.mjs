import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { importSpine } from '../src/spine/application.mjs';
import { extractRegion, parseAtlas } from '../src/spine/index.mjs';
import { inspectReskinTemplate, buildReskinSheet, assembleReskinSheet } from '../src/spine/reskin-template.mjs';

const raw = async buffer => sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-reskin-template-'));
  t.after(async () => {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe fixture cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = new FwvProject(root);
  await project.init({ name: 'Multipart reskin fixture' });
  const json = Buffer.from(JSON.stringify({
    skeleton: { spine: '4.2.120' },
    bones: [{ name: 'root' }, { name: 'body', parent: 'root' }, { name: 'hand', parent: 'body' }, { name: 'weapon', parent: 'hand' }],
    slots: [{ name: 'body-slot', bone: 'body', attachment: 'body' }, { name: 'hand-slot', bone: 'hand', attachment: 'hand' }, { name: 'weapon-slot', bone: 'weapon', attachment: 'weapon' }],
    skins: [{ name: 'default', attachments: {
      'body-slot': { body: { width: 10, height: 12 } },
      'hand-slot': { hand: { width: 3, height: 5 } },
      'weapon-slot': { weapon: { width: 10, height: 3 } },
    } }], animations: { idle: {} },
  }, null, 2) + '\n');
  const atlas = Buffer.from('page.png\nsize:32,32\npma:false\nbody\nbounds:2,2,8,10\noffsets:1,1,10,12\nhand\nbounds:16,2,3,5\nrotate:90\nweapon\nbounds:2,18,10,3\n');
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([13, 17, 23, 255], offset);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 8; x++) {
    const radius = ((x - 3.5) / 3.5) ** 2 + ((y - 4.5) / 4.5) ** 2;
    pixels.set([210, 100, 30, radius < 0.7 ? 255 : radius <= 1 ? 128 : 0], ((y + 2) * 32 + x + 2) * 4);
  }
  const hand = Buffer.alloc(3 * 5 * 4);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) hand.set([40 + x * 40, 100 + y * 10, 180, x === 0 && y === 0 ? 0 : 255], (y * 3 + x) * 4);
  const packedHand = await sharp(hand, { raw: { width: 3, height: 5, channels: 4 } }).rotate(270).raw().toBuffer();
  for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) packedHand.copy(pixels, ((y + 2) * 32 + x + 16) * 4, (y * 5 + x) * 4, (y * 5 + x + 1) * 4);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 10; x++) pixels.set([70, 180, 90, y === 1 ? 255 : 0], ((y + 18) * 32 + x + 2) * 4);
  const page = await sharp(pixels, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
  const asset = await importSpine(project, { name: 'Original three-part actor', files: [{ name: 'actor.json', buffer: json }, { name: 'actor.atlas', buffer: atlas }, { name: 'page.png', buffer: page }] });
  return { root, project, asset, json, atlas, page, options: { assetId: asset.id, revisionId: asset.selectedRevisionId } };
}

async function generatedSheet(layout, alpha = 255) {
  const pixels = Buffer.alloc(1024 * 1024 * 4, 255);
  const colors = [[180, 60, 210, alpha], [25, 190, 230, alpha], [250, 170, 35, alpha]];
  for (const [index, part] of layout.parts.entries()) {
    const content = part.content;
    for (let y = content.y; y < content.y + content.height; y++) for (let x = content.x; x < content.x + content.width; x++) pixels.set(colors[index % colors.length], (y * 1024 + x) * 4);
  }
  return sharp(pixels, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer();
}

test('template inspection maps real multipart slots, bones, draw order and deterministic label-free cells', async t => {
  const { project, options } = await fixture(t);
  const report = await inspectReskinTemplate(project, options);
  assert.equal(report.parts.length, 3);
  assert.deepEqual(report.parts.map(part => part.id), ['part_0001', 'part_0002', 'part_0003']);
  assert.deepEqual(report.parts[1], { id: 'part_0002', regionName: 'hand', width: 3, height: 5, slotNames: ['hand-slot'], boneNames: ['hand'], attachmentTypes: ['region'], drawOrder: [1] });
  const first = await buildReskinSheet(project, options);
  const second = await buildReskinSheet(project, { ...options, regionNames: ['weapon', 'body', 'hand'] });
  assert.deepEqual(first.layout, second.layout);
  assert.deepEqual(first.buffer, second.buffer);
  assert.deepEqual(first.layout.source, options);
  assert.equal(first.layout.columns, 2);
  assert.equal(first.layout.rows, 2);
  const decoded = await raw(first.buffer);
  assert.equal(decoded.info.width, 1024);
  assert.equal(decoded.info.height, 1024);
  assert.equal(decoded.data[3], 0);
  for (const part of first.layout.parts) {
    assert.ok(part.content.x >= part.cell.x + 24);
    assert.ok(part.content.y >= part.cell.y + 24);
    assert.ok(part.content.x + part.content.width <= part.cell.x + part.cell.width - 24);
    assert.ok(part.content.y + part.content.height <= part.cell.y + part.cell.height - 24);
  }
});

test('sheet assembly creates a new actor, preserves source rig/atlas and masks all selected part boundaries', async t => {
  const { project, asset, options, json, atlas, page } = await fixture(t);
  const built = await buildReskinSheet(project, options);
  const sheet = await generatedSheet(built.layout, 128);
  const assembled = await assembleReskinSheet(project, { ...options, layout: built.layout, buffer: sheet, provenance: { prompt: 'Purple clockwork cat', model: 'fixture-model' } });
  assert.notEqual(assembled.id, asset.id);
  const revision = assembled.revisions[0];
  assert.deepEqual((await project.readArtifact({ assetId: assembled.id, revisionId: revision.id, fileName: 'actor.json' })).buffer, json);
  assert.deepEqual((await project.readArtifact({ assetId: assembled.id, revisionId: revision.id, fileName: 'actor.atlas' })).buffer, atlas);
  const output = (await project.readArtifact({ assetId: assembled.id, revisionId: revision.id, fileName: 'page.png' })).buffer;
  const originalRaw = (await raw(page)).data;
  const outputRaw = (await raw(output)).data;
  const regions = parseAtlas(atlas).regions;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const offset = (y * 32 + x) * 4;
    const inside = regions.some(region => x >= region.x && x < region.x + region.packedWidth && y >= region.y && y < region.y + region.packedHeight);
    if (!inside) assert.deepEqual(outputRaw.subarray(offset, offset + 4), originalRaw.subarray(offset, offset + 4));
    else assert.equal(outputRaw[offset + 3], Math.round(originalRaw[offset + 3] * 128 / 255));
  }
  const hand = await extractRegion({ atlas, pages: { 'page.png': output }, regionName: 'hand' });
  const handRaw = await raw(hand);
  assert.equal(handRaw.info.width, 3);
  assert.equal(handRaw.info.height, 5);
  assert.equal(handRaw.data[3], 0);
  assert.equal(handRaw.data[7], 128);
  assert.ok(handRaw.data[4] < 30 && handRaw.data[5] > 180);
  assert.equal(revision.metadata.reskin.provenance.prompt, 'Purple clockwork cat');
  assert.equal(revision.recipe.operation, 'spine.reskin-sheet');
  assert.ok(revision.metadata.spine.issues.some(issue => issue.code === 'RESKIN_SOURCE_SILHOUETTE'));
  assert.equal(revision.metadata.reskin.partChecks.length, 3);
  assert.ok(revision.metadata.reskin.partChecks.every(check => check.sourceVisiblePixels > 0 && check.outputVisiblePixels > 0 && check.coverageRatio === 1));
  assert.ok(revision.metadata.reskin.partChecks.every(check => check.visibleAlphaThreshold === 1 && check.visualAcceptance === 'not-reviewed'));
  assert.deepEqual((await project.readArtifact({ assetId: assembled.id, revisionId: revision.id, fileName: revision.recipe.generatedSheetFile })).buffer, sheet);
  const snapshot = await project.snapshot();
  assert.equal(snapshot.assets.length, 2);
  assert.equal(snapshot.assets.find(item => item.id === asset.id).revisions.length, 1);
  assert.deepEqual((await project.readArtifact({ ...options, fileName: 'page.png' })).buffer, page);
});

test('selected part reroll preserves unselected regions and stable part IDs', async t => {
  const { project, options, atlas, page } = await fixture(t);
  const built = await buildReskinSheet(project, { ...options, regionNames: ['hand'] });
  assert.equal(built.layout.parts[0].id, 'part_0002');
  assert.equal(built.layout.parts[0].regionName, 'hand');
  const assembled = await assembleReskinSheet(project, { ...options, layout: built.layout, buffer: await generatedSheet(built.layout), name: 'Changed hand only' });
  const output = (await project.readArtifact({ assetId: assembled.id, revisionId: assembled.selectedRevisionId, fileName: 'page.png' })).buffer;
  const before = (await raw(page)).data;
  const after = (await raw(output)).data;
  const region = parseAtlas(atlas).regions.find(region => region.name === 'hand');
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    if (x >= region.x && x < region.x + region.packedWidth && y >= region.y && y < region.y + region.packedHeight) continue;
    const offset = (y * 32 + x) * 4;
    assert.deepEqual(after.subarray(offset, offset + 4), before.subarray(offset, offset + 4));
  }
  assert.equal(assembled.name, 'Changed hand only');
});

test('invalid or stale layout, wrong sheet dimensions and unsupported selection cannot write assets', async t => {
  const { project, options } = await fixture(t);
  const built = await buildReskinSheet(project, options);
  const sheet = await generatedSheet(built.layout);
  const badLayout = structuredClone(built.layout); badLayout.parts[0].content.x++;
  await assert.rejects(assembleReskinSheet(project, { ...options, layout: badLayout, buffer: sheet }), { code: 'INVALID_RESKIN_LAYOUT' });
  const staleLayout = structuredClone(built.layout); staleLayout.source.revisionId = 'rev_' + '0'.repeat(32);
  await assert.rejects(assembleReskinSheet(project, { ...options, layout: staleLayout, buffer: sheet }), { code: 'INVALID_RESKIN_LAYOUT' });
  await assert.rejects(assembleReskinSheet(project, { ...options, layout: built.layout, buffer: await sharp(sheet).resize(512, 512).png().toBuffer() }), { code: 'INVALID_RESKIN_SHEET' });
  await assert.rejects(assembleReskinSheet(project, { ...options, layout: built.layout, buffer: Buffer.from('broken PNG') }), { code: 'INVALID_RESKIN_SHEET' });
  await assert.rejects(assembleReskinSheet(project, { ...options, layout: built.layout, buffer: sheet, transforms: { nonexistent: { scale: 2 } } }), { code: 'INVALID_TRANSFORM' });
  await assert.rejects(assembleReskinSheet(project, { ...options, layout: built.layout, buffer: sheet, transforms: { weapon: { scale: Infinity } } }), { code: 'INVALID_TRANSFORM' });
  await assert.rejects(buildReskinSheet(project, { ...options, regionNames: [] }), { code: 'RESKIN_SELECTION_LIMIT' });
  await assert.rejects(buildReskinSheet(project, { ...options, regionNames: ['body', 'body'] }), { code: 'DUPLICATE_REGION_SELECTION' });
  await assert.rejects(buildReskinSheet(project, { ...options, regionNames: ['missing'] }), { code: 'REGION_NOT_FOUND' });
  await assert.rejects(buildReskinSheet(project, { ...options, regionNames: Array.from({ length: 17 }, (_, index) => `part${index}`) }), { code: 'RESKIN_SELECTION_LIMIT' });
  assert.equal((await project.snapshot()).assets.length, 1);
});

test('mask opt-out is explicit and per-part transforms retain existing replacement behavior', async t => {
  const { project, options, atlas } = await fixture(t);
  const built = await buildReskinSheet(project, { ...options, regionNames: ['weapon'] });
  const assembled = await assembleReskinSheet(project, { ...options, layout: built.layout, buffer: await generatedSheet(built.layout), preserveAlpha: false, transforms: { weapon: { offsetX: 2 } } });
  const revision = assembled.revisions[0];
  assert.ok(revision.metadata.spine.issues.some(issue => issue.code === 'RESKIN_UNMASKED'));
  assert.equal(revision.recipe.transforms.weapon.offsetX, 2);
  const page = (await project.readArtifact({ assetId: assembled.id, revisionId: revision.id, fileName: 'page.png' })).buffer;
  const weapon = (await raw(await extractRegion({ atlas, pages: { 'page.png': page }, regionName: 'weapon' }))).data;
  assert.equal(weapon[3], 0);
  assert.equal(weapon[(2 * 4) + 3], 255);
});

test('sheet generation rejects selected overlaps and ninepatches before any paid generation or assembly', async t => {
  const { project, json, atlas, page } = await fixture(t);
  const variants = [
    { atlas: atlas.toString().replace('bounds:2,18,10,3', 'bounds:3,3,10,3'), code: 'OVERLAPPING_REGIONS' },
    { atlas: atlas.toString().replace('bounds:2,18,10,3', 'bounds:2,18,10,3\nsplit:1,1,1,1'), code: 'UNSUPPORTED_NINEPATCH' },
  ];
  for (const variant of variants) {
    const source = await importSpine(project, { name: variant.code, files: [{ name: 'actor.json', buffer: json }, { name: 'actor.atlas', buffer: Buffer.from(variant.atlas) }, { name: 'page.png', buffer: page }] });
    const before = (await project.snapshot()).assets.length;
    await assert.rejects(buildReskinSheet(project, { assetId: source.id, revisionId: source.selectedRevisionId, regionNames: ['weapon'] }), { code: variant.code });
    // Unaffected regions remain available for their own selected batch.
    const valid = await buildReskinSheet(project, { assetId: source.id, revisionId: source.selectedRevisionId, regionNames: ['hand'] });
    assert.equal(valid.layout.parts[0].regionName, 'hand');
    assert.equal((await project.snapshot()).assets.length, before);
  }
});

test('empty generated cells and transforms that erase a visible part are rejected before import', async t => {
  const { project, options } = await fixture(t);
  const built = await buildReskinSheet(project, { ...options, regionNames: ['weapon'] });
  const blank = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } }).png().toBuffer();
  await assert.rejects(assembleReskinSheet(project, { ...options, layout: built.layout, buffer: blank }), { code: 'RESKIN_EMPTY_PART' });
  await assert.rejects(assembleReskinSheet(project, { ...options, layout: built.layout, buffer: await generatedSheet(built.layout), transforms: { weapon: { offsetX: 100 } } }), { code: 'RESKIN_EMPTY_PART' });
  assert.equal((await project.snapshot()).assets.length, 1);
});

test('partial generated cell coverage records measurable diagnostics without claiming visual acceptance', async t => {
  const { project, options } = await fixture(t);
  const built = await buildReskinSheet(project, { ...options, regionNames: ['weapon'] });
  const content = built.layout.parts[0].content;
  const sheetPixels = Buffer.alloc(1024 * 1024 * 4);
  for (let y = content.y; y < content.y + content.height; y++) for (let x = content.x; x < content.x + Math.floor(content.width / 10); x++) sheetPixels.set([200, 40, 100, 255], (y * 1024 + x) * 4);
  const sheet = await sharp(sheetPixels, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer();
  const assembled = await assembleReskinSheet(project, { ...options, layout: built.layout, buffer: sheet });
  const revision = assembled.revisions[0];
  const check = revision.metadata.reskin.partChecks[0];
  assert.equal(check.sourceVisiblePixels, 10);
  assert.ok(check.outputVisiblePixels > 0 && check.coverageRatio < 0.5);
  assert.equal(check.coverageRatio, check.outputVisiblePixels / check.sourceVisiblePixels);
  assert.equal(check.scope, 'technical-alpha-coverage');
  assert.equal(check.visualAcceptance, 'not-reviewed');
  assert.ok(revision.metadata.spine.issues.some(issue => issue.code === 'RESKIN_LOW_COVERAGE' && issue.regionName === 'weapon'));
});
