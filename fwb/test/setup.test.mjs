import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvironment, saveEnvironment, resolveEnvironment, browsePaths } from '../src/core/environment.mjs';
import { initProject, readProject } from '../src/core/project.mjs';
import { ensureExportPreset } from '../src/core/setup.mjs';
import { inspectExportPresets } from '../src/doctor.mjs';
import { prepareAndroidTools } from '../src/core/android-tools.mjs';
import { packageArtifact } from '../src/core/package.mjs';
import { configureExport, readArtifact, validateArtifact } from '../src/core/build.mjs';
import { atomicJson, digest } from '../src/core/files.mjs';
import { pckFixture, wasmFixture } from './fixtures/web-output.mjs';
import { handleWorkbenchApi } from '../src/editor/api.mjs';
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'fwb-setup-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); fs.writeFileSync(path.join(root,'project.godot'),'[application]\nconfig/name="Fixture"\n'); return initProject(root); }

test('shared environment preserves revisions and project overrides without storing secrets',t=>{
 const project=fixture(t),file=path.join(project.root,'machine/environment.json');const initial=readEnvironment(file);
 const saved=saveEnvironment({schemaVersion:1,godot:{executable:path.join(project.root,'godot.exe')},android:{javaHome:path.join(project.root,'jdk')}},initial.revision,file);
 assert.throws(()=>saveEnvironment(saved.config,initial.revision,file),/变化/);
 assert.throws(()=>saveEnvironment({...saved.config,password:'secret'},saved.revision,file),/无效/);
 assert.throws(()=>saveEnvironment({...saved.config,godot:{executable:'relative.exe'}},saved.revision,file),/绝对路径/);
 project.config.godot={};let resolved=resolveEnvironment(project,'google-play',{settings:saved.config,env:{}});assert.equal(resolved.godot.executable,saved.config.godot.executable);assert.equal(resolved.processEnv.JAVA_HOME,saved.config.android.javaHome);
 project.config.targets['google-play'].godot={executable:'custom.exe'};project.config.targets['google-play'].javaHome='project-jdk';resolved=resolveEnvironment(project,'google-play',{settings:saved.config,env:{}});assert.equal(resolved.godot.executable,'custom.exe');assert.equal(resolved.javaHome,path.join(project.root,'project-jdk'));
 assert.equal(browsePaths(project.root,{directoriesOnly:true}).entries.some(e=>e.name==='project.godot'),false);
});
test('preset creation is additive, repeatable, and refuses fake minigame presets',async t=>{
 const project=fixture(t);await ensureExportPreset(project,'web');const source=fs.readFileSync(path.join(project.root,'export_presets.cfg'),'utf8');assert.equal((await ensureExportPreset(project,'web')).created,false);assert.equal(fs.readFileSync(path.join(project.root,'export_presets.cfg'),'utf8'),source);
 await ensureExportPreset(project,'google-play');const presets=await inspectExportPresets(project.root);assert.deepEqual(presets.map(p=>p.platform),['Web','Android']);assert(fs.readFileSync(path.join(project.root,'export_presets.cfg'),'utf8').startsWith(source));await assert.rejects(ensureExportPreset(project,'wechat-minigame'),/真实导出预设/);
});
test('Android uses isolated settings and debug resets an inherited AAB format',async t=>{
 const project=fixture(t);await ensureExportPreset(project,'google-play');const binary=path.join(project.root,'godot.exe');fs.writeFileSync(binary,'engine-fixture');const artifact=path.join(project.root,'artifact');fs.mkdirSync(artifact);
 const diagnosis={engine:{executable:binary,version:'4.6.2.stable'},toolchain:{androidSdkPath:'C:/Android/sdk',javaHome:'C:/Java/jdk'}};
 const result=prepareAndroidTools(artifact,diagnosis);assert.notEqual(result.executable,binary);assert.equal(fs.readFileSync(binary,'utf8'),'engine-fixture');assert(fs.readFileSync(path.join(result.settingsDir,'editor_settings-4.6.tres'),'utf8').includes('C:/Android/sdk'));assert(!fs.existsSync(path.join(project.root,'._sc_')));
 const stage=path.join(project.root,'stage');fs.mkdirSync(stage);fs.copyFileSync(path.join(project.root,'export_presets.cfg'),path.join(stage,'export_presets.cfg'));configureExport(project,stage,'google-play',{release:true},{});configureExport(project,stage,'google-play',{release:false},{});assert.equal((await inspectExportPresets(stage))[0].options['gradle_build/export_format'],0);
});
function deliveryFixture(t) {
 const project=fixture(t),id='build_delivery_fixture_001',directory=path.join(project.root,'.local/fwb/artifacts',id);fs.mkdirSync(path.join(directory,'out'),{recursive:true});
 const files={'index.html':Buffer.from('<!doctype html><title>Fixture</title>'),'index.js':Buffer.from('// engine fixture'),'index.wasm':wasmFixture(),'index.pck':pckFixture()};
 const outputs=Object.entries(files).map(([name,bytes])=>{fs.writeFileSync(path.join(directory,'out',name),bytes);return{path:'out/'+name,size:bytes.length,sha256:digest(bytes)};});
 const manifest={schemaVersion:1,id,status:'built',target:'web',outputs,validation:{package:'passed',runtime:'not-tested',platform:'not-tested'}};
 const save=()=>atomicJson(path.join(directory,'manifest.json'),manifest);save();
 return{project,id,directory,manifest,save,artifact:()=>readArtifact(project.root,id)};
}

test('delivery ZIP contains only intact outputs and rejects changed files',async t=>{
 const f=deliveryFixture(t);fs.writeFileSync(path.join(f.directory,'private.txt'),'not-exported');
 const zip=await packageArtifact(f.artifact());assert.equal(zip.readUInt32LE(0),0x04034b50);assert(zip.includes(Buffer.from('index.html')));assert(!zip.includes(Buffer.from('private.txt')));
 fs.writeFileSync(path.join(f.directory,'out/index.html'),'tampered!!!');await assert.rejects(packageArtifact(f.artifact()),{code:'invalid-package'});
});

test('delivery ZIP freshly enforces package budgets, exact file sets and structures',async t=>{
 for(const mutate of [
  f=>{f.manifest.maxBytes=1;f.save();},
  f=>{fs.writeFileSync(path.join(f.directory,'out/unrecorded.json'),'{}');},
  f=>{const bytes=Buffer.from('invalid pack');fs.writeFileSync(path.join(f.directory,'out/index.pck'),bytes);Object.assign(f.manifest.outputs.find(o=>o.path==='out/index.pck'),{size:bytes.length,sha256:digest(bytes)});f.save();},
 ]) {const f=deliveryFixture(t);const stale=f.artifact();mutate(f);await assert.rejects(packageArtifact(stale),{code:'invalid-package'});assert.equal(f.artifact().validation.package,'failed');}
 const f=deliveryFixture(t);f.manifest.maxBytes=1;f.save();assert.equal((await validateArtifact(f.project.root,f.id)).ok,false);await assert.rejects(packageArtifact(f.artifact()),{code:'invalid-package'});
});

test('workbench download awaits fresh validation before sending ZIP bytes',async t=>{
 const f=deliveryFixture(t);let sent;const errors=[];
 const app={fwbWorkbench:{artifact:async()=>f.artifact()}};
 const res={setHeader(){},end(value){sent=value;}};
 const url=new URL('http://localhost/api/fwb/download?id='+f.id);
 await handleWorkbenchApi({app,req:{method:'GET'},res,url,sendJson:(status,body)=>errors.push({status,body})});
 assert(Buffer.isBuffer(sent));assert.equal(sent.readUInt32LE(0),0x04034b50);assert.deepEqual(errors,[]);
 sent=undefined;f.manifest.maxBytes=1;f.save();
 await handleWorkbenchApi({app,req:{method:'GET'},res,url,sendJson:(status,body)=>errors.push({status,body})});
 assert.equal(sent,undefined);assert.equal(errors.at(-1).status,400);assert.match(errors.at(-1).body.error,/检查失败/);
});
