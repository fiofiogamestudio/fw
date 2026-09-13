import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseAtlas, inspectSpine, extractRegion, replaceRegion } from '../src/spine/index.mjs';
import { createSpineFixture } from '../examples/spine-fixture/create.mjs';

const solid = (width, height, background) => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
const rgba = async buffer => sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const skeleton = path => ({ skeleton: { spine: '4.2.120' }, bones: [{ name: 'root' }], slots: [{ name: 'slot', bone: 'root', attachment: 'part' }], skins: [{ name: 'default', attachments: { slot: { part: { path, width: 2, height: 3 } } } }], animations: { idle: {} } });

test('Spine fixture inspection reports actual skeleton, animation and texture mapping', async () => {
  const fixture = await createSpineFixture();
  const report = await inspectSpine(fixture);
  assert.equal(report.supported, true);
  assert.equal(report.version, '4.2.120');
  assert.equal(report.bones.length, 2);
  assert.deepEqual(report.animations, ['idle', 'wave']);
  assert.deepEqual(report.issues, []);
  assert.equal(report.regions[0].page, 'fixture.png');
});

test('atlas parser handles modern bounds and legacy trim/rotation fields', () => {
  const modern = parseAtlas('page.png\nsize:8,8\npma:false\npart\nbounds:1,2,2,3\noffsets:1,2,5,7\nrotate:90\n');
  const legacy = parseAtlas('page.png\nsize:8,8\npart\nrotate:true\nxy:1,2\nsize:2,3\norig:5,7\noffset:1,2\nindex:-1\n');
  for (const atlas of [modern, legacy]) {
    const region = atlas.regions[0];
    assert.equal(region.packedWidth, 3);
    assert.equal(region.packedHeight, 2);
    assert.equal(region.offsetTop, 2);
    assert.equal(region.originalWidth, 5);
  }
});

test('part replacement preserves skeleton/atlas input and every outside pixel', async () => {
  const fixture = await createSpineFixture();
  const beforeAtlas = Buffer.from(fixture.atlas);
  const beforeJson = Buffer.from(fixture.json);
  const beforePage = Buffer.from(fixture.pages.get('fixture.png'));
  const result = await replaceRegion({ ...fixture, regionName: 'body', buffer: fixture.replacement });
  assert.deepEqual(fixture.atlas, beforeAtlas);
  assert.deepEqual(fixture.json, beforeJson);
  assert.deepEqual(fixture.pages.get('fixture.png'), beforePage);
  const before = await rgba(beforePage);
  const after = await rgba(result.buffer);
  let changed = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const offset = (y * 128 + x) * 4;
    if (x < 24 || x >= 104 || y < 16 || y >= 112) assert.deepEqual(after.data.subarray(offset, offset + 4), before.data.subarray(offset, offset + 4));
    else if (!after.data.subarray(offset, offset + 4).equals(before.data.subarray(offset, offset + 4))) changed++;
  }
  assert.ok(changed > 1000);
  const part = await extractRegion({ atlas: fixture.atlas, pages: result.pages, regionName: 'body' });
  assert.deepEqual((await rgba(part)).data, (await rgba(fixture.replacement)).data);
});

test('90-degree packing and trim restore correct original orientation and position', async () => {
  const original = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 255, 0, 255, 255, 0, 255, 255, 255]);
  const sprite = await sharp(original, { raw: { width: 2, height: 3, channels: 4 } }).png().toBuffer();
  const packed = await sharp(sprite).rotate(270).png().toBuffer();
  const page = await sharp(await solid(8, 8, '#00000000')).composite([{ input: packed, left: 1, top: 2 }]).png().toBuffer();
  const atlas = 'page.png\nsize:8,8\npart\nbounds:1,2,2,3\noffsets:1,1,4,5\nrotate:90\n';
  const pages = { 'page.png': page };
  const extracted = await extractRegion({ atlas, pages, regionName: 'part', restoreTrim: false });
  assert.deepEqual((await rgba(extracted)).data, original);
  const restored = await extractRegion({ atlas, pages, regionName: 'part' });
  const restoredRaw = await rgba(restored);
  assert.equal(restoredRaw.info.width, 4);
  assert.equal(restoredRaw.info.height, 5);
  assert.deepEqual(restoredRaw.data.subarray((1 * 4 + 1) * 4, (1 * 4 + 2) * 4), Buffer.from([255, 0, 0, 255]));
  const replaced = await replaceRegion({ atlas, pages, regionName: 'part', buffer: restored });
  assert.deepEqual((await rgba(replaced.buffer)).data, (await rgba(page)).data);
});

test('PMA pages convert replacement alpha and preview back to straight alpha', async () => {
  const atlas = 'page.png\nsize:4,4\npma:true\npart\nbounds:1,1,2,2\n';
  const pages = { 'page.png': await solid(4, 4, '#00000000') };
  const replacement = await solid(2, 2, { r: 200, g: 100, b: 50, alpha: 0.5 });
  const result = await replaceRegion({ atlas, pages, regionName: 'part', buffer: replacement });
  const rawPage = (await rgba(result.buffer)).data;
  assert.deepEqual([...rawPage.subarray(20, 24)], [100, 50, 25, 128]);
  const part = (await rgba(await extractRegion({ atlas, pages: result.pages, regionName: 'part', restoreTrim: false }))).data;
  assert.ok(Math.abs(part[0] - 200) <= 1);
  assert.equal(part[3], 128);
});

test('safe optional extrusion duplicates edge pixels without touching other regions', async () => {
  const atlas = 'page.png\nsize:8,8\npart\nbounds:2,2,2,2\nother\nbounds:6,6,1,1\n';
  const result = await replaceRegion({ atlas, pages: { 'page.png': await solid(8, 8, '#00000000') }, regionName: 'part', buffer: await solid(2, 2, '#ff0000'), transform: { extrude: 1 } });
  const data = (await rgba(result.buffer)).data;
  assert.equal(data[(1 * 8 + 1) * 4], 255);
  assert.equal(data[(4 * 8 + 4) * 4], 255);
  assert.equal(data[(6 * 8 + 6) * 4 + 3], 0);
});

test('inspection detects missing textures, attachment mappings and unsupported versions', async () => {
  const json = skeleton('missing');
  json.skeleton.spine = '4.1.24';
  json.animations.idle = { slots: { slot: { attachment: [{ time: 0, name: 'ghost' }] } } };
  const report = await inspectSpine({ json, atlas: 'page.png\nsize:8,8\npart\nbounds:1,1,2,3\n', pages: {} });
  assert.equal(report.supported, false);
  for (const code of ['UNSUPPORTED_VERSION', 'MISSING_REGION', 'MISSING_PAGE', 'MISSING_ANIMATION_ATTACHMENT']) assert.ok(report.issues.some(item => item.code === code), code);
});

test('invalid formats, bounds, unsafe overlaps and transform keys fail explicitly', async () => {
  assert.throws(() => parseAtlas('../page.png\npart\nbounds:0,0,1,1\n'), { code: 'INVALID_FILE_NAME' });
  assert.throws(() => parseAtlas('page.png\npart\nbounds:0,0,1,1\nrotate:180\n'), { code: 'UNSUPPORTED_ROTATION' });
  assert.throws(() => parseAtlas('page.png\npart\nbounds:0,0,1.5,1\n'), { code: 'INVALID_ATLAS' });
  assert.throws(() => parseAtlas('page.png\npart\nbounds:0,0,2,2\noffsets:1,0,2,2\n'), { code: 'INVALID_ATLAS' });
  const pages = { 'page.png': await solid(8, 8, '#00000000') };
  const buffer = await solid(2, 2, '#ff0000');
  const atlas = 'page.png\nsize:8,8\npart\nbounds:1,1,2,2\n';
  await assert.rejects(replaceRegion({ atlas, pages, regionName: 'part', buffer, transform: { unknown: 2 } }), { code: 'INVALID_TRANSFORM' });
  await assert.rejects(replaceRegion({ atlas, pages, regionName: 'part', buffer, transform: { scale: Infinity } }), { code: 'INVALID_TRANSFORM' });
  await assert.rejects(replaceRegion({ atlas, pages, regionName: 'part', buffer, transform: { extrude: 2 } }), { code: 'UNSAFE_EXTRUSION' });
  await assert.rejects(replaceRegion({ atlas: atlas + 'other\nbounds:2,2,2,2\n', pages, regionName: 'part', buffer }), { code: 'OVERLAPPING_REGIONS' });
  await assert.rejects(extractRegion({ atlas: atlas.replace('1,1,2,2', '7,7,2,2'), pages, regionName: 'part' }), { code: 'REGION_OUT_OF_BOUNDS' });
  await assert.rejects(inspectSpine({ json: Buffer.from('SKEL binary'), atlas, pages }), { code: 'INVALID_JSON' });
});

test('existing trim rectangle clipping is surfaced and transparent replacement clears old pixels', async () => {
  const atlas = 'page.png\nsize:8,8\npart\nbounds:2,2,2,2\noffsets:1,1,4,4\n';
  const pages = { 'page.png': await solid(8, 8, '#ff0000') };
  const clipped = await replaceRegion({ atlas, pages, regionName: 'part', buffer: await solid(4, 4, '#00ff00') });
  assert.equal(clipped.warnings[0].code, 'TRIM_CLIPPED');
  assert.equal(clipped.warnings[0].pixels, 12);
  const transparent = await replaceRegion({ atlas, pages, regionName: 'part', buffer: await solid(4, 4, '#00000000') });
  const data = (await rgba(transparent.buffer)).data;
  assert.equal(data[(2 * 8 + 2) * 4 + 3], 0);
  assert.equal(data[3], 255);
});

test('input limits and preview-incompatible physics/mixed-PMA fail with explicit diagnostics', async () => {
  assert.throws(() => parseAtlas('x'.repeat(4 * 1024 * 1024 + 1)), { code: 'INPUT_LIMIT' });
  assert.throws(() => parseAtlas('page.png\npart\nbounds:1,,2,3\n'), { code: 'INVALID_ATLAS' });
  const json = skeleton('part');
  json.physics = [{ name: 'dynamic', bone: 'root' }];
  const atlas = 'page.png\nsize:8,8\npma:false\npart\nbounds:1,1,2,3\n\nsecond.png\nsize:8,8\npma:true\nother\nbounds:1,1,2,3\n';
  const pages = { 'page.png': await solid(8, 8, '#00000000'), 'second.png': await solid(8, 8, '#00000000') };
  const report = await inspectSpine({ json, atlas, pages });
  assert.equal(report.supported, false);
  assert.ok(report.issues.some(item => item.code === 'UNSUPPORTED_PHYSICS'));
  assert.ok(report.issues.some(item => item.code === 'MIXED_PMA'));
  await assert.rejects(inspectSpine({ json: ' '.repeat(16 * 1024 * 1024 + 1), atlas, pages }), { code: 'INPUT_LIMIT' });
});

test('owned animation fixture parses and animates through optional official Spine runtime', async t => {
  let runtime;
  try { runtime = await import('@esotericsoftware/spine-core'); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') { t.skip('Optional Spine runtime is not installed.'); return; }
    throw error;
  }
  const fixture = await createSpineFixture();
  const atlas = new runtime.TextureAtlas(fixture.atlas.toString());
  const data = new runtime.SkeletonJson(new runtime.AtlasAttachmentLoader(atlas)).readSkeletonData(JSON.parse(fixture.json));
  const skeletonInstance = new runtime.Skeleton(data);
  const state = new runtime.AnimationState(new runtime.AnimationStateData(data));
  state.setAnimation(0, 'idle', true);
  state.update(0.6);
  state.apply(skeletonInstance);
  const body = skeletonInstance.findBone('body');
  assert.ok(Math.abs(body.rotation - 12) < 0.00001);
  assert.ok(Math.abs(body.y - 58) < 0.00001);
});
