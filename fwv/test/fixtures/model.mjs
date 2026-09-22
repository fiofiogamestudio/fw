import sharp from 'sharp';
import { encodeGlb } from '../../src/model/glb.mjs';

export async function createModelFixture() {
  const json = { asset: { version: '2.0', generator: 'FWV isolated acceptance fixture' }, scene: 0, scenes: [{ nodes: [0, 2] }],
    nodes: [{ name: 'root', children: [1] }, { name: 'tip', translation: [0, 1, 0] }, { name: 'panel', mesh: 0, skin: 0 }],
    buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [],
    skins: [{ name: 'Two bones', joints: [0, 1], skeleton: 0 }], meshes: [{ name: 'Skinned panel', primitives: [{ attributes: {} }] }],
    materials: [{ name: 'Teal fabric', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true }], textures: [{ source: 0 }], images: [], animations: [] };
  let binary = Buffer.alloc(0);
  function append(bytes) { const offset = Math.ceil(binary.length / 4) * 4; binary = Buffer.concat([binary, Buffer.alloc(offset - binary.length), bytes]);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }); return json.bufferViews.length - 1; }
  function accessor(values, size, type, componentType = 5126, bounds) {
    const bytes = Buffer.alloc(values.length * size); values.forEach((value, i) => bytes[componentType === 5126 ? 'writeFloatLE' : 'writeUInt16LE'](value, i * size));
    json.accessors.push({ bufferView: append(bytes), componentType, type, count: values.length / ({ VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16, SCALAR: 1 })[type], ...bounds }); return json.accessors.length - 1;
  }
  const p = json.meshes[0].primitives[0];
  p.attributes.POSITION = accessor([-.5, 0, 0, .5, 0, 0, -.5, 2, 0, .5, 2, 0], 4, 'VEC3', 5126, { min: [-.5, 0, 0], max: [.5, 2, 0] });
  p.attributes.NORMAL = accessor([0,0,1, 0,0,1, 0,0,1, 0,0,1],4,'VEC3');
  p.attributes.TEXCOORD_0 = accessor([0,1,1,1,0,0,1,0],4,'VEC2');
  p.attributes.JOINTS_0 = accessor([0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0],2,'VEC4',5123);
  p.attributes.WEIGHTS_0 = accessor([1,0,0,0,1,0,0,0,0,1,0,0,0,1,0,0],4,'VEC4');
  p.indices = accessor([0,1,2,2,1,3],2,'SCALAR',5123); p.material = 0;
  json.skins[0].inverseBindMatrices = accessor([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1, 1,0,0,0,0,1,0,0,0,0,1,0,0,-1,0,1],4,'MAT4');
  const times = accessor([0,1,2],4,'SCALAR',5126,{min:[0],max:[2]}), rotations = accessor([0,0,0,1,0,0,Math.sin(Math.PI/8),Math.cos(Math.PI/8),0,0,0,1],4,'VEC4');
  json.animations.push({ name:'Bend', samplers:[{input:times,output:rotations}], channels:[{sampler:0,target:{node:1,path:'rotation'}}] });
  const png = await sharp({create:{width:8,height:8,channels:4,background:'#32b7b0'}}).png().toBuffer();
  json.images.push({ name:'Fabric', mimeType:'image/png',bufferView:append(png) }); json.buffers[0].byteLength=binary.length;
  return { buffer: encodeGlb(json,binary), texture:png };
}
