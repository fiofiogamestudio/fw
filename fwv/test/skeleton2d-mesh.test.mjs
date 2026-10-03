import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { validateSkeleton2dDocument } from '../src/skeleton2d/document.mjs';
import { sampleSkeleton2d, skeleton2dMeshTriangles, drawSkeleton2dSlot, transformPoint } from '../src/skeleton2d/sample.mjs';
import { renderSkeleton2dThumbnail } from '../src/skeleton2d/thumbnail.mjs';
import { FwvProject } from '../src/core/project.mjs';
import { importSkeleton2d, readSkeleton2dBundle, saveSkeleton2d, exportSkeleton2d } from '../src/skeleton2d/application.mjs';
import { validateAuthoringData } from '../src/editor/authoring.mjs';
import { handleSkeleton2dApi } from '../src/editor/skeleton2d-api.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
function document() {
  return { format: 'fwd-skeleton2d', schemaVersion: 1, coordinateSystem: 'y-up',
    bones: [{ name: 'root' }, { name: 'hinge', parent: 'root', x: 10 }],
    slots: [{ name: 'cloth', bone: 'root', attachment: 'cloth' }],
    skins: [{ name: 'default', attachments: { cloth: { cloth: { type: 'mesh', path: 'cloth', width: 20, height: 20,
      uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3],
      vertices: [1, 0, -10, 10, 1, 1, 1, 0, 10, 1, 2, 0, 10, -10, 0.5, 1, 0, -10, 0.5, 1, 0, -10, -10, 1],
    } } } }], textures: { cloth: 'cloth.png' },
    animations: { bend: { bones: { hinge: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 90 }] } } } }, animationDurations: { bend: 1 } };
}
const attachment = d => d.skins[0].attachments.cloth.cloth;

test('weighted points follow their influencing bones and preserve setup pose, interpolation and skin setup', () => {
  const d = validateSkeleton2dDocument(document());
  const start = sampleSkeleton2d(d, { animation: '' }).slots[0];
  assert.deepEqual(start.worldVertices, [-10, 10, 10, 10, 10, -10, -10, -10]);
  assert.deepEqual(start.uvs, attachment(d).uvs); assert.deepEqual(start.triangles, attachment(d).triangles);
  const end = sampleSkeleton2d(d, { time: 1 }).slots[0];
  near(end.vertices[1].x, 0); near(end.vertices[1].y, 0);
  near(end.vertices[2].x, 15); near(end.vertices[2].y, -5);
  assert.deepEqual(end.vertices[0], start.vertices[0], 'root-weighted corner stays fixed');
  d.skinBones = { default: structuredClone(d.bones) }; d.skinBones.default[0].x = 21; d.skinBones.default[0].scaleX = -2;
  const mirrored = sampleSkeleton2d(d, { time: 1 }).slots[0];
  near(mirrored.vertices[1].x, 21); near(mirrored.vertices[2].x, -9);
  near(mirrored.vertices[2].y, -5);
  assert.deepEqual(attachment(d).vertices, attachment(document()).vertices, 'sampling never rewrites local weights');
});

test('UV affine triangles used by Canvas and thumbnails reproduce each sampled world vertex', () => {
  const slot = sampleSkeleton2d(validateSkeleton2dDocument(document()), { time: 0.75 }).slots[0];
  const triangles = skeleton2dMeshTriangles(slot); assert.equal(triangles.length, 2);
  for (const triangle of triangles) for (const index of triangle.indices) {
    const point = transformPoint(triangle.matrix, slot.uvs[index * 2], slot.uvs[index * 2 + 1]);
    near(point.x, slot.vertices[index].x); near(point.y, slot.vertices[index].y);
  }
  const calls = [];
  const context = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, args]) });
  drawSkeleton2dSlot(context, slot, { image: true });
  assert.equal(calls.filter(([name]) => name === 'clip').length, 3, 'posed outline plus two independently transformed faces');
  assert.equal(calls.filter(([name]) => name === 'save').length, 3);
  assert.equal(calls.filter(([name]) => name === 'restore').length, 3);
  assert.deepEqual(calls.filter(([name]) => name === 'transform').map(([, args]) => args), triangles.map(triangle => triangle.matrix));
  assert.ok(calls.filter(([name]) => name === 'drawImage').every(([, args]) => args.slice(1).join(',') === '0,0,1,1'));
});

test('subpixel seam padding cannot produce long miters on acute animated mesh faces', () => {
  const slot = { type: 'mesh', uvs: [0,0,1,0,1,1,0,1], triangles: [0,1,2,0,2,3],
    vertices: [{x:0,y:0},{x:100,y:0},{x:100,y:0.0001},{x:0,y:20}] };
  for (const triangle of skeleton2dMeshTriangles(slot, { seamPadding: 0.75 })) {
    triangle.clipPoints.forEach((point, i) => assert.ok(Math.hypot(point.x-triangle.points[i].x, point.y-triangle.points[i].y) <= 1.500001));
  }
});

test('mesh draws submit only each UV neighborhood with a bounded filter margin', () => {
  const image={width:100,height:200};
  const slot={type:'mesh',uvs:[.25,.5,.5,.5,.5,.75,.25,.75],triangles:[0,1,2,0,2,3],
    vertices:[{x:25,y:100},{x:50,y:100},{x:50,y:50},{x:25,y:50}]};
  for(const deformed of [false,true]){
    if(deformed)slot.vertices[3].x=29;
    const draws=[],context=new Proxy({}, {get:(_,name)=>name==='drawImage'?((...args)=>draws.push(args)):(()=>{})});
    drawSkeleton2dSlot(context,slot,image);
    assert.equal(draws.length,deformed?2:1);
    for(const args of draws)assert.deepEqual(args,[image,23,98,29,54,.23,.49,.29,.27],
      'distant source pixels must never be submitted for either grouped or independent faces');
  }
});

test('affine slivers preserve a single image draw despite weighted-coordinate roundoff', () => {
  const uvs=[0,0,1,0,1,1,0,1,.26171875,.53125,.266055117,.564470723,.266055127,.564470713];
  const slot={type:'mesh',uvs,triangles:[0,1,2,0,2,3,4,5,6],
    vertices:Array.from({length:7},(_,i)=>({x:256*uvs[i*2]-127,y:244-256*uvs[i*2+1]}))};
  slot.vertices[6].x+=1e-13;
  const triangles=skeleton2dMeshTriangles(slot),expected=[256,0,0,-256,-127,244];
  assert.ok(Math.max(...triangles.at(-1).matrix.map((v,i)=>Math.abs(v-expected[i])))>1e-8,
    'the narrow face must exercise unstable matrix inversion');
  const draws=[],context=new Proxy({}, {get:(_,name)=>name==='drawImage'?((...args)=>draws.push(args)):(()=>{})});
  drawSkeleton2dSlot(context,slot,{width:256,height:256});
  assert.equal(draws.length,1,'affine vertices require one texture sample, including translucent pixels');
  slot.vertices[6].x+=.1;draws.length=0;
  drawSkeleton2dSlot(context,slot,{width:256,height:256});
  assert.ok(draws.length>1,'real deformation must still use independently transformed faces');
});

test('complete affine coverage tolerates only an output-bounded numerical seam', () => {
  const mesh=gap=>{const uvs=[0,0,.5,0,.5,1,0,1,.5+gap,0,1,0,1,1,.5+gap,1];
    return{type:'mesh',uvs,triangles:[0,1,2,0,2,3,4,5,6,4,6,7],vertices:Array.from({length:8},(_,i)=>({x:uvs[i*2]*256,y:uvs[i*2+1]*256}))};};
  const numerical=mesh(2e-7);
  for(const [slot,scale,expectedClips]of [[numerical,1,0],[numerical,100,1],[mesh(.001),1,1]]){
    const clips=[],context=new Proxy({}, {get:(_,name)=>name==='getTransform'?(()=>({a:scale,b:0,c:0,d:scale,e:0,f:0})):name==='clip'?(()=>clips.push(1)):(()=>{})});
    drawSkeleton2dSlot(context,slot,{width:256,height:256});
    assert.equal(clips.length,expectedClips,'coverage tolerance must shrink with zoom and preserve visible holes');
  }
});

test('mesh validation rejects malformed weighted streams, unsupported transforms and invalid topology', () => {
  const mutations = [
    a => a.vertices[0] = 0, a => a.vertices[0] = 5, a => a.vertices[1] = 2,
    a => a.vertices[1] = 0.5, a => a.vertices[2] = Infinity, a => a.vertices[4] = -1,
    a => a.vertices[4] = 0, a => a.vertices[4] = 0.9,
    a => a.vertices[15] = 0, // duplicate influence on the mixed corner
    a => a.vertices.pop(), a => a.vertices.push(1),
    a => a.uvs[0] = -0.01, a => a.uvs[0] = NaN, a => a.uvs.pop(),
    a => a.triangles.push(0), a => a.triangles[1] = 4, a => a.triangles[1] = 0,
    a => a.triangles = [0, 1, 2], a => a.triangles.push(2, 1, 0),
    a => a.uvs.splice(2, 2, 0.5, 0.5), // first triangle has collinear UVs
    a => a.x = 3, a => a.rotation = 5, a => a.scaleX = 2,
    a => a.hull = 4, a => a.type = 'linkedmesh',
  ];
  for (const [index, mutate] of mutations.entries()) { const d = document(); mutate(attachment(d)); assert.throws(() => validateSkeleton2dDocument(d), /Skeleton2D/, `mutation ${index}`); }
  const oversized = document(); attachment(oversized).uvs = Array(8194).fill(0);
  assert.throws(() => validateSkeleton2dDocument(oversized), /mesh.uvs/);
});

const quadrants = Buffer.alloc(16 * 16 * 4);
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) quadrants.set([...(y < 8 ? x < 8 ? [255, 0, 0] : [0, 255, 0] : x < 8 ? [0, 0, 255] : [255, 255, 0]), 255], (y * 16 + x) * 4);
const png = await sharp(quadrants, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
async function pixels(d, options = {}) {
  const result = await renderSkeleton2dThumbnail({ document: validateSkeleton2dDocument(d), files: [{ name: 'cloth.png', role: 'texture', mime: 'image/png', buffer: png }] }, { size: 128, padding: 8, ...options });
  const { data, info } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
  return { data, info, at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)] };
}
test('mesh thumbnail keeps UV orientation, transparency and all corners through complete-pose clipping', async () => {
  const d = document(), result = await pixels(d);
  for (const [point, color] of [[[35, 35], [255, 0, 0, 255]], [[93, 35], [0, 255, 0, 255]], [[35, 93], [0, 0, 255, 255]], [[93, 93], [255, 255, 0, 255]]]) assert.deepEqual(result.at(...point), color);
  assert.equal(result.at(0, 0)[3], 0); assert.equal(result.at(127, 127)[3], 0);
  const bent = await pixels(d, { time: 1 }); assert.notDeepEqual(bent.data, result.data);
  d.clipBounds = { bend: { x: -10, y: 0, width: 20, height: 10 } };
  const clipped = await pixels(d); let blue = 0, visible = 0;
  for (let i = 0; i < clipped.data.length; i += 4) { if (clipped.data[i + 3]) visible++; if (clipped.data[i + 2] > 240 && clipped.data[i + 3] > 240) blue++; }
  assert.ok(visible > 3000); assert.equal(blue, 0);
});

test('region and mesh import/save/export retain exact pixels and weight data across immutable revisions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-mesh-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = new FwvProject(root); await project.init(); const d = document();
  d.slots.push({ name: 'badge', bone: 'hinge', attachment: 'part' });
  d.skins[0].attachments.badge = { part: { type: 'region', path: 'cloth', width: 3, height: 3, x: 5 } };
  const asset = await importSkeleton2d(project, { document: d, textures: [{ name: 'cloth.png', buffer: png }] }), first = asset.selectedRevisionId;
  attachment(d).vertices[2] = -12;
  const next = await saveSkeleton2d(project, { assetId: asset.id, revisionId: first, expectedRevisionId: first, document: d });
  const bundle = await readSkeleton2dBundle(project, { assetId: asset.id, revisionId: next.selectedRevisionId });
  assert.deepEqual(bundle.document, d); assert.deepEqual(bundle.files.find(file => file.name === 'cloth.png').buffer, png);
  const original = await readSkeleton2dBundle(project, { assetId: asset.id, revisionId: first }); assert.equal(attachment(original.document).vertices[2], -10);
  const exported = await exportSkeleton2d(project, { assetId: asset.id, revisionId: next.selectedRevisionId }); assert.equal(exported.manifest.validation.status, 'passed');
  const sample = sampleSkeleton2d(bundle.document); assert.equal(sample.slots[0].type, 'mesh'); assert.equal(sample.slots[1].type, undefined);
});

test('large bounded weighted arrays remain saveable in native authoring drafts', () => {
  const d = document(), a = attachment(d); d.bones.push({ name: 'extra1', parent: 'root' }, { name: 'extra2', parent: 'root' });
  a.uvs = []; a.vertices = []; a.triangles = []; const side = 40;
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    a.uvs.push(x / (side - 1), y / (side - 1)); a.vertices.push(4);
    for (let bone = 0; bone < 4; bone++) a.vertices.push(bone, x - (bone === 1 ? 10 : 0), y, 0.25);
    if (x + 1 < side && y + 1 < side) { const n = y * side + x; a.triangles.push(n, n + 1, n + side + 1, n, n + side + 1, n + side); }
  }
  assert.ok(a.vertices.length > 10000);
  const draft = { schemaVersion: 1, projectId: 'independent', skeleton2dDrafts: [{ id: 'mesh', data: { document: d } }] };
  assert.deepEqual(validateAuthoringData(draft, 'independent'), draft);
});

test('protected browser runtime exposes the same mesh validator and render mapping', async () => {
  let content;
  await handleSkeleton2dApi({ req: { method: 'GET' }, res: { writeHead() {}, end(value) { content = value; } }, url: new URL('http://localhost/api/fwv/skeleton2d-runtime') });
  const runtime = await import('data:text/javascript;base64,' + content.toString('base64'));
  assert.deepEqual(runtime.validateSkeleton2dDocument(document()), document());
  assert.deepEqual(runtime.sampleSkeleton2d(document(), { time: 0.5 }), sampleSkeleton2d(document(), { time: 0.5 }));
  assert.equal(typeof runtime.drawSkeleton2dSlot, 'function');
});
