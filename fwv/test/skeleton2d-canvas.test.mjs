import test from 'node:test';
import assert from 'node:assert/strict';
import { drawSkeleton2dSlot } from '../src/skeleton2d/sample.mjs';

// Canvas is a development dependency: a missing installation must fail the
// regression run rather than silently omit the pixel checks. Hosts may name an
// equivalent installed implementation explicitly without changing runtime deps.
const canvas = await import(process.env.FWV_CANVAS_MODULE ?? '@napi-rs/canvas');
const nativeCanvas = { timeout: 10000 };
const size = 32;
function texture() {
  const image = canvas.createCanvas(size, size), context = image.getContext('2d');
  const pixels = context.createImageData(size, size), alpha = [0, 17, 85, 128, 224, 255];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels.data.set([x * 7, y * 7, (x + y) * 3, alpha[(x + y * 3) % alpha.length]], (y * size + x) * 4);
  context.putImageData(pixels, 0, 0); return image;
}
const rectangle = () => ({ type: 'mesh', uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3],
  vertices: [{ x: 0, y: size }, { x: size, y: size }, { x: size, y: 0 }, { x: 0, y: 0 }] });
const region = { matrix: [1, 0, 0, 1, size / 2, size / 2], width: size, height: size };
function render(slot, image = texture()) {
  const output = canvas.createCanvas(size, size), context = output.getContext('2d');
  context.setTransform(1, 0, 0, -1, 0, size);
  let draws = 0;
  const drawImage = context.drawImage.bind(context);
  context.drawImage = (...args) => { draws++; drawImage(...args); };
  drawSkeleton2dSlot(context, slot, image);
  const pixels = context.getImageData(0, 0, size, size).data;
  return { pixels, draws, at: (x, y) => [...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)] };
}

test('affine rectangular mesh preserves every translucent pixel of a region at native size', nativeCanvas, () => {
  const image = texture(), expected = render(region, image), actual = render(rectangle(), image);
  assert.deepEqual(actual.pixels, expected.pixels);
  assert.equal(actual.draws, 1, 'shared triangle edges must not composite the source twice');
  assert.ok([...expected.pixels].some((value, index) => index % 4 === 3 && value > 0 && value < 255));
});

test('native-size integer-aligned art bypasses high-quality resampling without changing caller smoothing', nativeCanvas, () => {
  const image=texture(),expected=image.getContext('2d').getImageData(0,0,size,size).data;
  for(const slot of [region,rectangle()]){
    const output=canvas.createCanvas(size,size),ctx=output.getContext('2d');
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.setTransform(1,0,0,-1,0,size);
    drawSkeleton2dSlot(ctx,slot,image);
    assert.deepEqual(ctx.getImageData(0,0,size,size).data,expected);
    assert.equal(ctx.imageSmoothingEnabled,true);assert.equal(ctx.imageSmoothingQuality,'high');
  }
});

test('fractional native-size art still uses the caller smoothing filter', nativeCanvas, () => {
  const image=texture(),a=canvas.createCanvas(size,size),b=canvas.createCanvas(size,size);
  const direct=b.getContext('2d');direct.imageSmoothingQuality='high';direct.drawImage(image,.25,.5);
  const ctx=a.getContext('2d');ctx.imageSmoothingQuality='high';ctx.setTransform(1,0,0,-1,.25,size+.5);
  drawSkeleton2dSlot(ctx,rectangle(),image);
  assert.deepEqual(ctx.getImageData(0,0,size,size).data,direct.getImageData(0,0,size,size).data);
});

test('affine union retains concave clipping and does not draw the excluded image area', nativeCanvas, () => {
  const points = [[0, 0], [32, 0], [32, 12], [12, 12], [12, 32], [0, 32]];
  const slot = { type: 'mesh', uvs: points.flatMap(([x, y]) => [x / size, y / size]),
    vertices: points.map(([x, y]) => ({ x, y: size - y })), triangles: [0, 1, 3, 1, 2, 3, 0, 3, 5, 3, 4, 5] };
  const image = texture(), actual = render(slot, image), expected = render(region, image);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    assert.deepEqual(actual.at(x, y), x < 12 || y < 12 ? expected.at(x, y) : [0, 0, 0, 0], `pixel ${x},${y}`);
  }
  assert.equal(actual.draws, 1);
});

test('affine mesh union handles opposite triangle winding without cancellation', nativeCanvas, () => {
  const slot = rectangle(); slot.triangles = [0, 1, 2, 3, 2, 0];
  const image = texture(), actual = render(slot, image);
  assert.deepEqual(actual.pixels, render(region, image).pixels);
  assert.equal(actual.draws, 1);
});

test('a genuinely deformed mesh retains independent triangle transforms and its bent outline', nativeCanvas, () => {
  const slot = rectangle(); slot.vertices[2].x = 20;
  const image = canvas.createCanvas(size, size), context = image.getContext('2d');
  context.fillStyle = '#f08020'; context.fillRect(0, 0, size, size);
  const actual = render(slot, image);
  assert.equal(actual.draws, 2, 'different transforms must not be flattened to one image transform');
  assert.deepEqual(actual.at(29, 2), [240, 128, 32, 255]);
  assert.deepEqual(actual.at(18, 29), [240, 128, 32, 255]);
  assert.deepEqual(actual.at(27, 29), [0, 0, 0, 0]);
  assert.notDeepEqual(actual.pixels, render(region, image).pixels);
});

test('affine full texture survives fractional T-junction partitions without raster cracks', nativeCanvas, () => {
  const uv=[[0,0],[1,0],[1,.613],[0,.613],[1,1],[0,1],[.731,.613]];
  const slot={type:'mesh',uvs:uv.flat(),vertices:uv.map(([u,v])=>({x:u*size,y:(1-v)*size})),
    triangles:[0,1,2,0,2,3,3,6,5,6,4,5,6,2,4]};
  const image=texture();
  assert.deepEqual(render(slot,image).pixels,render(region,image).pixels);
});

test('unit total triangle area does not substitute for full texture coverage', nativeCanvas, () => {
  const uv=[[0,0],[.5,0],[.5,1],[0,1],[1,0],[1,1]];
  const slot={type:'mesh',uvs:uv.flat(),vertices:uv.map(([u,v])=>({x:u*size,y:(1-v)*size})),
    triangles:[0,1,2,0,2,3,0,1,2,0,2,3]};
  const actual=render(slot),expected=render(region);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)assert.deepEqual(actual.at(x,y),x<16?expected.at(x,y):[0,0,0,0]);
});

test('rigid islands in a deforming attachment preserve translucent source pixels and draw order', nativeCanvas, () => {
  const uv=[[0,0],[.5,0],[.5,1],[0,1],[.5,0],[1,0],[1,1],[.5,1]];
  const slot={type:'mesh',uvs:uv.flat(),vertices:uv.map(([u,v],i)=>({x:u*size+(i>=4?4:0),y:(1-v)*size})),
    triangles:[0,1,2,0,2,3,4,5,6,4,6,7]};
  const image=texture(),actual=render(slot,image),expected=render(region,image);
  assert.equal(actual.draws,2,'one draw per consecutive rigid island, not one per face');
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)assert.deepEqual(actual.at(x,y),x<16?expected.at(x,y):x<20?[0,0,0,0]:expected.at(x-4,y));
});

test('a UV hole away from the slab midpoint is not treated as a full rectangle', nativeCanvas, () => {
  const slot = rectangle();
  // Both faces span y=0..1 and meet at y=.5, but the lower center is empty.
  // Checking only vertex-height slab midpoints misses this valid clipped mesh.
  slot.triangles = [0, 1, 3, 0, 1, 2];
  const image = canvas.createCanvas(size, size), context = image.getContext('2d');
  context.fillStyle = '#f08020'; context.fillRect(0, 0, size, size);
  const actual = render(slot, image);
  assert.deepEqual(actual.at(16, 28), [0, 0, 0, 0], 'the uncovered UV triangle must remain transparent');
  assert.deepEqual(actual.at(2, 28), [240, 128, 32, 255]);
  assert.deepEqual(actual.at(28, 2), [240, 128, 32, 255]);
});

test('coverage caching observes in-place topology and UV edits', nativeCanvas, () => {
  const slot = rectangle(), image = canvas.createCanvas(size, size), context = image.getContext('2d');
  context.fillStyle = '#f08020'; context.fillRect(0, 0, size, size);
  assert.equal(render(slot, image).at(16, 28)[3], 255);
  slot.triangles.splice(0, 6, 0, 1, 3, 0, 1, 2);
  assert.equal(render(slot, image).at(16, 28)[3], 0);
  slot.triangles.splice(0, 6, 0, 1, 2, 0, 2, 3);
  assert.equal(render(slot, image).at(16, 28)[3], 255);
  for (const index of [1, 2]) { slot.uvs[index * 2] = .5; slot.vertices[index].x = size / 2; }
  assert.equal(render(slot, image).at(28, 16)[3], 0, 'changing UV coverage must invalidate a cached full-rectangle result');
  assert.equal(render(slot, image).at(8, 16)[3], 255);
});

test('mixed rigid and deformed mesh groups keep opaque shared edges closed without leaking the outline', nativeCanvas, () => {
  const xs = [2, 14, 30], ys = [2, 12, 22, 30], rightXs = [30, 26, 29, 24];
  const slot = { type: 'mesh', uvs: [], vertices: [], triangles: [] };
  for (let row = 0; row < ys.length; row++) for (let col = 0; col < xs.length; col++) {
    slot.uvs.push(xs[col] / size, ys[row] / size);
    slot.vertices.push({ x: col === 2 ? rightXs[row] : xs[col], y: size - ys[row] });
  }
  // The entire left column is one consecutive affine group. Its right edge
  // touches independently transformed faces, including their three-way joins.
  for (let col = 0; col < 2; col++) for (let row = 0; row < 3; row++) {
    const a = row * 3 + col, b = a + 1, c = b + 3, d = a + 3;
    slot.triangles.push(a, b, c, d, c, a);
  }
  const image = canvas.createCanvas(size, size), context = image.getContext('2d');
  context.fillStyle = '#f08020'; context.fillRect(0, 0, size, size);
  const actual = render(slot, image);
  assert.ok(actual.draws > 1 && actual.draws < slot.triangles.length / 3);
  for (let y = 4; y < 28; y++) for (let x = 4; x < 22; x++) {
    const pixel = actual.at(x, y);
    assert.equal(pixel[3], 255, `opaque interior alpha at ${x},${y}`);
    assert.ok(pixel.slice(0, 3).every((value, index) => Math.abs(value - [240, 128, 32][index]) <= 1), `interior color at ${x},${y}`);
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (y < 1 || y > 30 || x < 1 || x > 30) assert.equal(actual.at(x, y)[3], 0, `outside outline at ${x},${y}`);
  }
  assert.equal(actual.at(29, 27)[3], 0, 'the bent lower-right outline must not leak the original rectangle');
});

test('posed outline preserves a real interior hole when surrounding faces deform', nativeCanvas, () => {
  const uvPoints = [[2, 2], [30, 2], [30, 30], [2, 30], [11, 11], [21, 11], [21, 21], [11, 21]];
  const slot = { type: 'mesh', uvs: uvPoints.flatMap(([x, y]) => [x / size, y / size]),
    vertices: uvPoints.map(([x, y], index) => ({ x: index === 2 ? 27 : x, y: size - (index === 2 ? 29 : y) })), triangles: [] };
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    slot.triangles.push(side, next, 4 + next, side, 4 + next, 4 + side);
  }
  const image = canvas.createCanvas(size, size), context = image.getContext('2d');
  context.fillStyle = '#f08020'; context.fillRect(0, 0, size, size);
  const actual = render(slot, image);
  assert.ok(actual.draws > 1, 'the deformed ring must use the posed outline path');
  for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) assert.equal(actual.at(x, y)[3], 0, `hole at ${x},${y}`);
  for (const [x, y] of [[16, 5], [5, 16], [25, 16], [16, 25]]) assert.equal(actual.at(x, y)[3], 255, `ring at ${x},${y}`);
  assert.equal(actual.at(29, 28)[3], 0, 'the bent outer silhouette remains clipped');
});

test('posed outline retains overlapping folded faces instead of cancelling their shared fold', nativeCanvas, () => {
  const uv = [[0, 0], [.5, 0], [1, 0], [0, 1], [.5, 1], [1, 1]];
  const slot = { type: 'mesh', uvs: uv.flat(), triangles: [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4],
    vertices: uv.map(([u, v]) => ({ x: u === 0 ? 2 : u === .5 ? 20 : 10, y: size - (2 + v * 28) })) };
  const image = canvas.createCanvas(size, size), context = image.getContext('2d');
  context.fillStyle = '#f08020'; context.fillRect(0, 0, size, size);
  const actual = render(slot, image);
  assert.equal(actual.draws, 2);
  for (let y = 4; y < 28; y++) for (let x = 4; x < 19; x++) assert.equal(actual.at(x, y)[3], 255, `folded union at ${x},${y}`);
  assert.equal(actual.at(23, 16)[3], 0, 'folding back must not retain the undeformed right half');
  assert.equal(actual.at(0, 16)[3], 0);
});
