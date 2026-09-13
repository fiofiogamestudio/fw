import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectGlb, decodeGlb, encodeGlb, repairGlb, extractTexture, inspectVertex } from '../src/model/glb.mjs';
import { importModel, readModel, repairModelCandidate, extractModelTexture } from '../src/model/application.mjs';
import { FwvProject } from '../src/core/project.mjs';
import { ArtChanges } from '../src/workflows/changes.mjs';
import { createModelFixture } from './fixtures/model.mjs';
import { startEditor } from '../src/editor/server.mjs';

test('GLB fixture is independently valid with model, material, texture, skin and animation', async () => {
  const {buffer,texture}=await createModelFixture(),summary=await inspectGlb(buffer);
  assert.equal(summary.validation.status,'passed');assert.equal(summary.nodes.filter(n=>n.joint).length,2);assert.equal(summary.meshes[0].primitives[0].vertices,4);
  assert.equal(summary.animations[0].name,'Bend');assert.deepEqual(extractTexture(buffer,0).buffer,texture);
  const bad=decodeGlb(buffer);bad.json.images[0].uri='https://example.com/private.png';await assert.rejects(inspectGlb(encodeGlb(bad.json,bad.binary)),/内嵌/);
  bad.json.images[0].uri=undefined;bad.json.extensionsUsed=['KHR_draco_mesh_compression'];await assert.rejects(inspectGlb(encodeGlb(bad.json,bad.binary)),/扩展/);
  await assert.rejects(inspectGlb(buffer.subarray(0,-1)),/完整/);
});
test('bone and weight repairs preserve unrelated geometry, textures and animation with valid new data', async () => {
  const {buffer,texture}=await createModelFixture(),before=decodeGlb(buffer);
  const result=await repairGlb(buffer,{boneEdits:[{nodeIndex:1,translation:[.25,1,0]}],weightEdits:[{meshIndex:0,primitiveIndex:0,vertexIndex:2,weights:[2,2,0,0]}]});
  const after=decodeGlb(result.buffer);assert.deepEqual(after.json.nodes[1].translation,[.25,1,0]);assert.deepEqual(after.json.nodes[0],before.json.nodes[0]);
  assert.deepEqual(after.json.animations,before.json.animations);assert.deepEqual(after.binary.subarray(0,before.binary.length),before.binary);assert.deepEqual(extractTexture(result.buffer,0).buffer,texture);
  assert.deepEqual(inspectVertex(result.buffer,{meshIndex:0,primitiveIndex:0,vertexIndex:2}).weights,[.5,.5,0,0]);
  assert.deepEqual(inspectVertex(result.buffer,{meshIndex:0,primitiveIndex:0,vertexIndex:0}).weights,[1,0,0,0]);
  await assert.rejects(repairGlb(buffer,{boneEdits:[{nodeIndex:2,scale:[2,2,2]}]}),/骨骼/);
  await assert.rejects(repairGlb(buffer,{weightEdits:[{meshIndex:0,primitiveIndex:0,vertexIndex:5,weights:[1,0,0,0]}]}),/顶点/);
});
async function workspace(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fwd-model-test-')); t.after(()=>{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('fwd-model-test-'));
    return fs.rm(root,{recursive:true,force:true});
  });
  const project=new FwvProject(root);await project.init();return {application:project,artChanges:new ArtChanges({project})};
}
test('model candidate repair and texture round trip use exact source and manual adoption gates',async t=>{
  const state=await workspace(t),{buffer}=await createModelFixture(),asset=await importModel(state.application,{name:'Model',fileName:'model.glb',buffer});
  const change=await state.artChanges.create({sourceAssetId:asset.id,sourceRevisionId:asset.selectedRevisionId,title:'修正骨骼',request:'把tip局部位置向右调整',anchors:{objects:['node:1']}});
  const input={changeId:change.id,requestId:'model-repair-1',boneEdits:[{nodeIndex:1,translation:[.3,1,0]}]};
  const candidate=await repairModelCandidate(state,input);assert.equal(candidate.candidates.length,1);assert.equal(candidate.candidates[0].validation.status,'passed');
  assert.equal((await state.application.snapshot()).assets.find(a=>a.id===asset.id).selectedRevisionId,asset.selectedRevisionId);
  assert.equal((await repairModelCandidate(state,input)).candidates.length,1);
  await assert.rejects(repairModelCandidate(state,{...input,boneEdits:[{nodeIndex:1,translation:[.6,1,0]}]}),/不同/);
  const review={changeId:change.id,candidateId:candidate.candidates[0].id};await assert.rejects(state.artChanges.adopt(review),/接受/);
  await state.artChanges.review({...review,decision:'accepted',comment:'同相机动画检查通过'});await state.artChanges.adopt(review);
  assert.equal((await state.application.snapshot()).assets.find(a=>a.id===asset.id).revisions.length,2);
  const texture=await extractModelTexture(state.application,{assetId:asset.id,revisionId:asset.selectedRevisionId,imageIndex:0});
  assert.equal(texture.kind,'image');assert.equal((await extractModelTexture(state.application,{assetId:asset.id,revisionId:asset.selectedRevisionId,imageIndex:0})).id,texture.id);
});

test('texture replacement round trip embeds the exact chosen image revision and preserves the original model',async t=>{
  const state=await workspace(t),{buffer,texture}=await createModelFixture();
  const asset=await state.application.importAsset({name:'Model with provenance',kind:'model3d',metadata:{sourceTool:'fixture'},files:[
    {name:'original.glb',role:'model',mime:'model/gltf-binary',buffer},
    {name:'source-note.txt',role:'reference',mime:'text/plain',buffer:Buffer.from('Preserve original authoring context.')},
  ]});
  const extracted=await extractModelTexture(state.application,{assetId:asset.id,revisionId:asset.selectedRevisionId,imageIndex:0});
  const processed=await state.application.processImage({assetId:extracted.id,revisionId:extracted.selectedRevisionId,recipe:{width:16,height:16,padding:4,background:'#cc2244'}});
  const selected=processed.revisions.find(rev=>rev.id===processed.selectedRevisionId),imageFile=selected.files.find(file=>file.role==='image');
  const chosen=(await state.application.readArtifact({assetId:extracted.id,revisionId:selected.id,fileName:imageFile.name})).buffer;
  assert.notDeepEqual(chosen,texture);
  // Change the selected image again: model repair must still use the explicit earlier version.
  await state.application.selectRevision({assetId:extracted.id,revisionId:extracted.selectedRevisionId});
  const change=await state.artChanges.create({sourceAssetId:asset.id,sourceRevisionId:asset.selectedRevisionId,title:'Replace fabric',request:'Use the reviewed red padded texture.'});
  const input={changeId:change.id,requestId:'texture-replacement',textureEdits:[{imageIndex:0,assetId:extracted.id,revisionId:selected.id}]};
  const result=await repairModelCandidate(state,input),candidate=result.candidates[0];
  assert.deepEqual(extractTexture((await readModel(state.application,candidate)).buffer,0).buffer,chosen);
  const original=await readModel(state.application,{assetId:asset.id,revisionId:asset.selectedRevisionId});assert.deepEqual(original.buffer,buffer);
  const candidateAsset=(await state.application.snapshot()).assets.find(item=>item.id===candidate.assetId),candidateRevision=candidateAsset.revisions.find(item=>item.id===candidate.revisionId);
  assert.equal(candidateRevision.metadata.sourceTool,'fixture');assert.deepEqual(candidateRevision.recipe.parameters.textureEdits,input.textureEdits);
  assert.deepEqual((await state.application.readArtifact({assetId:candidate.assetId,revisionId:candidate.revisionId,fileName:'source-note.txt'})).buffer,Buffer.from('Preserve original authoring context.'));
  await state.artChanges.review({changeId:change.id,candidateId:candidate.id,decision:'accepted',comment:'Texture inspected on model.'});
  const adopted=await state.artChanges.adopt({changeId:change.id,candidateId:candidate.id}),revisionId=adopted.adoption.revisionId;
  const output=await state.application.exportAsset({assetId:asset.id,revisionId});
  const exported=await fs.readFile(path.join(state.application.root,output.path,'resources','original.glb'));
  assert.deepEqual(extractTexture(exported,0).buffer,chosen);assert.equal(output.manifest.validation.coverage,'glb-and-files');
});

test('repair clones a shared weights accessor for only the requested primitive',async()=>{
  const {buffer}=await createModelFixture(),before=decodeGlb(buffer);
  before.json.meshes[0].primitives.push(structuredClone(before.json.meshes[0].primitives[0]));
  const source=encodeGlb(before.json,before.binary),oldAccessor=before.json.meshes[0].primitives[0].attributes.WEIGHTS_0;
  assert.equal((await inspectGlb(source)).validation.status,'passed');
  const repaired=await repairGlb(source,{weightEdits:[{meshIndex:0,primitiveIndex:0,vertexIndex:2,weights:[1,1,0,0]}]}),after=decodeGlb(repaired.buffer);
  assert.notEqual(after.json.meshes[0].primitives[0].attributes.WEIGHTS_0,oldAccessor);
  assert.equal(after.json.meshes[0].primitives[1].attributes.WEIGHTS_0,oldAccessor);
  assert.deepEqual(inspectVertex(repaired.buffer,{meshIndex:0,primitiveIndex:0,vertexIndex:2}).weights,[.5,.5,0,0]);
  assert.deepEqual(inspectVertex(repaired.buffer,{meshIndex:0,primitiveIndex:1,vertexIndex:2}).weights,[0,1,0,0]);
  assert.deepEqual(after.binary.subarray(0,before.binary.length),before.binary);assert.deepEqual(after.json.animations,before.json.animations);
  assert.equal(repaired.summary.validation.status,'passed');
});

test('repairable weight errors can enter a change, but validation and export fail until a valid candidate is adopted',async t=>{
  const state=await workspace(t),{buffer}=await createModelFixture(),bad=decodeGlb(buffer);
  const weights=bad.json.accessors[bad.json.meshes[0].primitives[0].attributes.WEIGHTS_0],offset=bad.json.bufferViews[weights.bufferView].byteOffset;
  bad.binary.writeFloatLE(.25,offset);bad.binary.writeFloatLE(.25,offset+4);
  const broken=encodeGlb(bad.json,bad.binary),inspection=await inspectGlb(broken);
  assert.equal(inspection.validation.status,'failed');assert.equal(inspection.validation.repairable,true);
  const asset=await importModel(state.application,{name:'Broken weights',fileName:'broken.glb',buffer:broken}),source={assetId:asset.id,revisionId:asset.selectedRevisionId};
  assert.equal((await state.application.validateRevision(source)).status,'failed');await assert.rejects(state.application.exportAsset(source),/validation failed/);
  const change=await state.artChanges.create({sourceAssetId:source.assetId,sourceRevisionId:source.revisionId,title:'Normalize vertex',request:'Fix vertex 0 weight sum.'});
  assert.equal(change.sourceValidation.status,'failed');
  const repaired=await repairModelCandidate(state,{changeId:change.id,requestId:'normalize-0',weightEdits:[{meshIndex:0,primitiveIndex:0,vertexIndex:0,weights:[1,1,0,0]}]}),candidate=repaired.candidates[0];
  assert.equal(candidate.validation.status,'passed');
  await state.artChanges.review({changeId:change.id,candidateId:candidate.id,decision:'accepted',comment:'Checked the repaired bend.'});
  const adopted=await state.artChanges.adopt({changeId:change.id,candidateId:candidate.id}),output={assetId:asset.id,revisionId:adopted.adoption.revisionId};
  assert.equal((await state.application.validateRevision(output)).status,'passed');assert.equal((await state.application.exportAsset(output)).manifest.validation.status,'passed');
  assert.deepEqual((await readModel(state.application,source)).buffer,broken);
});

test('accessor bounds, unsupported influences and malformed embedded images are rejected',async t=>{
  const {buffer,texture}=await createModelFixture(),selector={meshIndex:0,primitiveIndex:0,vertexIndex:2};
  const short=decodeGlb(buffer),accessor=short.json.accessors[short.json.meshes[0].primitives[0].attributes.WEIGHTS_0];
  short.json.bufferViews[accessor.bufferView].byteLength=16;
  assert.throws(()=>inspectVertex(encodeGlb(short.json,short.binary),selector),/BufferView/);
  const negative=decodeGlb(buffer);negative.json.accessors[negative.json.meshes[0].primitives[0].attributes.WEIGHTS_0].byteOffset=-4;
  assert.throws(()=>inspectVertex(encodeGlb(negative.json,negative.binary),selector),/BufferView/);
  const extra=decodeGlb(buffer);extra.json.meshes[0].primitives[0].attributes.JOINTS_2=extra.json.meshes[0].primitives[0].attributes.JOINTS_0;
  assert.throws(()=>inspectVertex(encodeGlb(extra.json,extra.binary),selector),/四个/);
  await assert.rejects(repairGlb(buffer,{weightEdits:[{...selector,weights:[0,0,0,0]}]}),/总和/);
  await assert.rejects(repairGlb(buffer,{boneEdits:[{nodeIndex:1,rotation:[0,0,0,0]}]}),/四元数/);
  await assert.rejects(repairGlb(buffer,{textureEdits:[{imageIndex:0,buffer:texture.subarray(0,40),mime:'image/png'}]}));
  await assert.rejects(repairGlb(buffer,{textureEdits:[{imageIndex:0,buffer:texture,mime:'image/jpeg'}]}));
  const state=await workspace(t),asset=await state.application.importAsset({name:'Invalid GLB',kind:'model3d',files:[{name:'bad.glb',role:'model',mime:'model/gltf-binary',buffer:Buffer.from('invalid')}]});
  const source={assetId:asset.id,revisionId:asset.selectedRevisionId},validation=await state.application.validateRevision(source);
  assert.equal(validation.status,'failed');assert.equal(validation.checks.find(check=>check.id==='glb-structure').repairable,false);
  await assert.rejects(state.application.exportAsset(source),/validation failed/);
  await assert.rejects(state.artChanges.create({sourceAssetId:asset.id,sourceRevisionId:asset.selectedRevisionId,title:'Cannot read',request:'Reject unreadable model.'}),/技术/);
});
test('real HTTP serves local model runtime and verified texture; rejects forged selectors',async t=>{
  const state=await workspace(t),editor=await startEditor({projectRoot:state.application.root,fwePath:path.resolve('../fwe'),port:0});t.after(()=>editor.close());
  const session=await fetch(editor.url+'/api/fwv/session').then(r=>r.json()),{buffer,texture}=await createModelFixture();
  const r=await fetch(editor.url+'/api/fwv/commands',{method:'POST',headers:{Origin:editor.url,'Content-Type':'application/json','X-FWV-CSRF':session.csrfToken},body:JSON.stringify({type:'model.import',payload:{fileName:'test.glb',base64:buffer.toString('base64')}})});
  assert.equal(r.status,200);const asset=(await r.json()).result,q=new URLSearchParams({assetId:asset.id,revisionId:asset.selectedRevisionId});
  assert.equal((await fetch(editor.url+'/api/fwv/model?'+q).then(r=>r.json())).validation.status,'passed');
  assert.deepEqual(Buffer.from(await fetch(editor.url+'/api/fwv/model?'+q+'&view=texture&imageIndex=0').then(r=>r.arrayBuffer())),texture);
  const runtime=await fetch(editor.url+'/api/fwv/model-runtime?module=loader').then(r=>r.text());assert.ok(runtime.includes("from '/api/fwv/model-runtime?module=three'"));
  assert.equal((await fetch(editor.url+'/api/fwv/model-runtime?module=../../package.json')).status,400);
});

test('real CLI imports, inspects and repairs a model through the same durable change records',async t=>{
  const state=await workspace(t),{buffer}=await createModelFixture(),file=path.join(state.application.root,'input.glb');await fs.writeFile(file,buffer);
  const cli=fileURLToPath(new URL('../bin/fwv.mjs',import.meta.url));
  const invoke=async(...args)=>JSON.parse((await promisify(execFile)(process.execPath,[cli,...args,'--project',state.application.root],{maxBuffer:2*1024*1024})).stdout);
  const asset=await invoke('model-import','--file',file,'--name','CLI model');
  const inspected=await invoke('model-inspect','--asset',asset.id,'--revision',asset.selectedRevisionId);assert.equal(inspected.validation.status,'passed');
  const change=await state.artChanges.create({sourceAssetId:asset.id,sourceRevisionId:asset.selectedRevisionId,title:'CLI repair',request:'Move tip using the local Agent command.'});
  const commandFile=path.join(state.application.root,'repair.json');
  await fs.writeFile(commandFile,JSON.stringify({type:'model.candidate.repair',payload:{changeId:change.id,requestId:'cli-repair',boneEdits:[{nodeIndex:1,translation:[.4,1,0]}]}}));
  const repaired=await invoke('model','--file',commandFile),candidate=repaired.candidates[0];assert.equal(candidate.validation.status,'passed');
  const saved=await state.artChanges.get({changeId:change.id});assert.equal(saved.candidates[0].id,candidate.id);
  assert.deepEqual(decodeGlb((await readModel(state.application,candidate)).buffer).json.nodes[1].translation,[.4,1,0]);
  assert.equal((await state.application.snapshot()).assets.find(a=>a.id===asset.id).selectedRevisionId,asset.selectedRevisionId);
  assert.equal(candidate.review.decision,'pending');
});

test('truncated diagnostics cannot hide a later invalid weight behind a technical pass', async () => {
  const { buffer } = await createModelFixture(), model = decodeGlb(buffer);
  for (let i = 0; i < 120; i++) model.json.nodes.push({ name: 'unused-' + i });
  const weights = model.json.accessors[model.json.meshes[0].primitives[0].attributes.WEIGHTS_0];
  model.binary.writeFloatLE(.25, model.json.bufferViews[weights.bufferView].byteOffset);
  await assert.rejects(inspectGlb(encodeGlb(model.json, model.binary)), /检查尚未完成/);
});
