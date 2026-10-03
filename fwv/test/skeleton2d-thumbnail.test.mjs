import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { inspectSkeleton2dFiles } from '../src/skeleton2d/application.mjs';
import { renderSkeleton2dThumbnail } from '../src/skeleton2d/thumbnail.mjs';

const rgba = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0] };
const solid = color => sharp({ create: { width: 16, height: 16, channels: 4, background: color } }).png().toBuffer();
const colors = Object.fromEntries(await Promise.all(Object.entries(rgba).map(async ([name, [r, g, b]]) => [name, await solid({ r, g, b, alpha: 1 })])));
function document(parts) {
  return { format: 'fwd-skeleton2d', schemaVersion: 1, coordinateSystem: 'y-up',
    // Deliberately unrelated authoring bounds: thumbnail fitting uses sampled art.
    bounds: { x: 1000, y: 1000, width: 1, height: 1 }, bones: [{ name: 'root' }],
    slots: parts.map(part => ({ name: part.name, bone: 'root', attachment: 'part' })),
    skins: [{ name: 'default', attachments: Object.fromEntries(parts.map(part => [part.name, { part: {
      type: 'region', path: part.color, width: part.width ?? 20, height: part.height ?? 20, x: part.x ?? 0, y: part.y ?? 0,
      ...(part.rotation === undefined ? {} : { rotation: part.rotation }), ...(part.scaleX === undefined ? {} : { scaleX: part.scaleX }),
    } }])) }], textures: Object.fromEntries(parts.map(part => [part.color, `${part.color}.png`])),
    animations: { idle: {} }, animationDurations: { idle: 1 } };
}
async function bundle(document, images = colors) {
  const files = [{ name: 'skeleton2d.json', role: 'skeleton2d', mime: 'application/json', buffer: Buffer.from(JSON.stringify(document)) },
    ...[...new Set(Object.values(document.textures))].map(name => ({ name, role: 'texture', mime: 'image/png', buffer: images[name.slice(0, -4)] }))];
  return { files, ...await inspectSkeleton2dFiles(files) };
}
async function pixels(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const groups = Object.fromEntries(Object.keys(rgba).map(name => [name, { count: 0, x: 0, y: 0 }]));
  const bounds = { minX: info.width, minY: info.height, maxX: -1, maxY: -1 }; let visible = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    if (data[i + 3] > 0) { visible++; bounds.minX = Math.min(bounds.minX, x); bounds.minY = Math.min(bounds.minY, y); bounds.maxX = Math.max(bounds.maxX, x); bounds.maxY = Math.max(bounds.maxY, y); }
    if (data[i + 3] < 240) continue;
    for (const [name, color] of Object.entries(rgba)) if (color.every((value, channel) => Math.abs(data[i + channel] - value) < 10)) { groups[name].count++; groups[name].x += x; groups[name].y += y; }
  }
  for (const group of Object.values(groups)) { group.x /= group.count; group.y /= group.count; }
  return { info, data, visible, bounds, groups, at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)] };
}
function assertMargin(result, size, padding) {
  assert.ok(result.visible > 0);
  assert.ok(result.bounds.minX >= padding - 1 && result.bounds.minY >= padding - 1, JSON.stringify(result.bounds));
  assert.ok(result.bounds.maxX <= size - padding && result.bounds.maxY <= size - padding, JSON.stringify(result.bounds));
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) assert.equal(result.at(x, y)[3], 0);
}

test('complete transparent thumbnail includes all parts and fits actual sampled geometry', async () => {
  const input = await bundle(document([{ name: 'body', color: 'red', width: 20, height: 30 }, { name: 'head', color: 'blue', width: 12, height: 10, y: 25 }, { name: 'arm', color: 'green', width: 12, height: 8, x: 20 }]));
  const before = JSON.stringify(input.document), result = await pixels(await renderSkeleton2dThumbnail(input));
  assert.equal(result.info.width, 256); assert.equal(result.info.height, 256); assertMargin(result, 256, 16);
  for (const color of ['red', 'blue', 'green']) assert.ok(result.groups[color].count > 200, color);
  assert.ok(result.groups.blue.y < result.groups.red.y); assert.ok(result.groups.green.x > result.groups.red.x);
  assert.equal(JSON.stringify(input.document), before, 'sampling and rendering do not mutate the exact revision');
});

const quadrants = Buffer.alloc(16 * 16 * 4);
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
  const color = y < 8 ? x < 8 ? rgba.red : rgba.green : x < 8 ? rgba.blue : rgba.yellow;
  quadrants.set([...color, 255], (y * 16 + x) * 4);
}
const quarterImage = await sharp(quadrants, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
test('texture top stays up and sampled rotation, nonuniform scale and reflection preserve orientation', async () => {
  const d = document([{ name: 'part', color: 'quadrants', width: 20, height: 10 }]);
  const images = { quadrants: quarterImage }, options = { size: 128, padding: 8 };
  const normal = await pixels(await renderSkeleton2dThumbnail(await bundle(d, images), options));
  assert.ok(normal.groups.red.x < normal.groups.green.x && normal.groups.red.y < normal.groups.blue.y);
  d.bones[0] = { name: 'root', x: 70, y: -40, rotation: 90, scaleX: 2, scaleY: 1 };
  const rotated = await pixels(await renderSkeleton2dThumbnail(await bundle(d, images), options));
  assertMargin(rotated, 128, 8);
  assert.ok(rotated.groups.green.y < rotated.groups.red.y && rotated.groups.red.x < rotated.groups.blue.x);
  assert.ok((rotated.bounds.maxY - rotated.bounds.minY) / (rotated.bounds.maxX - rotated.bounds.minX) > 3.8);
  d.bones[0] = { name: 'root', scaleX: -2, scaleY: 1 };
  const mirrored = await pixels(await renderSkeleton2dThumbnail(await bundle(d, images), options));
  assert.ok(mirrored.groups.green.x < mirrored.groups.red.x && mirrored.groups.red.y < mirrored.groups.blue.y);
});

test('default first animation and time zero honor sampled draw order and attachment visibility', async () => {
  const d = document([{ name: 'back', color: 'red' }, { name: 'front', color: 'blue' }]);
  d.animations.idle = { drawOrder: [{ time: 0, offsets: [{ slot: 'back', offset: 1 }] }], slots: { front: { attachment: [{ time: 0.5, name: null }] }, back: { attachment: [{ time: 0.5, name: null }] } } };
  const input = await bundle(d), first = await pixels(await renderSkeleton2dThumbnail(input));
  assert.deepEqual(first.at(128, 128), [255, 0, 0, 255]);
  const setup = await pixels(await renderSkeleton2dThumbnail(input, { animation: '' }));
  assert.deepEqual(setup.at(128, 128), [0, 0, 255, 255]);
  assert.equal((await pixels(await renderSkeleton2dThumbnail(input, { time: 0.75 }))).visible, 0);
});

test('world-space lines render before their slot and their stroke participates in the fit', async () => {
  const d = document([{ name: 'body', color: 'red' }]);
  d.lines = [{ name: 'cable', slot: 'body', attachment: 'part', color: '#00ff00ff', width: 4,
    points: [{ bone: 'root', x: -50, y: 0 }, { bone: 'root', x: 50, y: 0 }] }];
  const result = await pixels(await renderSkeleton2dThumbnail(await bundle(d)));
  assertMargin(result, 256, 16); assert.ok(result.groups.green.count > 500); assert.ok(result.groups.red.count > 500);
  assert.deepEqual(result.at(128, 128), [255, 0, 0, 255], 'the attachment covers its line at their overlap');
});

test('clip bounds crop in y-up world coordinates and a completely clipped pose stays transparent', async () => {
  const d = document([{ name: 'part', color: 'quadrants' }]);
  d.clipBounds = { idle: { x: 0, y: -10, width: 10, height: 20 } };
  const result = await pixels(await renderSkeleton2dThumbnail(await bundle(d, { quadrants: quarterImage })));
  assertMargin(result, 256, 16); assert.ok(result.groups.green.count > 1000 && result.groups.yellow.count > 1000);
  assert.equal(result.groups.red.count, 0); assert.equal(result.groups.blue.count, 0);
  assert.ok(result.groups.green.y < result.groups.yellow.y);
  d.clipBounds.idle = { x: 100, y: 100, width: 10, height: 10 };
  assert.equal((await pixels(await renderSkeleton2dThumbnail(await bundle(d, { quadrants: quarterImage })))).visible, 0);
});

test('only buffered PNGs from a validated bundle are usable, with bounded output settings', async () => {
  const input = await bundle(document([{ name: 'body', color: 'red' }]));
  await assert.rejects(renderSkeleton2dThumbnail({ document: input.document, files: [] }), /Missing validated PNG buffer/);
  await assert.rejects(renderSkeleton2dThumbnail({ document: input.document, files: [{ name: 'red.png', role: 'texture', mime: 'image/png', buffer: Buffer.from('<svg/>') }] }), /Missing validated PNG buffer/);
  for (const options of [{ size: 0 }, { size: 2048 }, { padding: -1 }, { padding: 128 }]) await assert.rejects(renderSkeleton2dThumbnail(input, options), /size or padding/);
  await assert.rejects(renderSkeleton2dThumbnail(input, { animation: 'missing' }), /Unknown Skeleton2D animation/);
});
