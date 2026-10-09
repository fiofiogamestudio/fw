import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
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
function deliveryFixture(t, target = 'web') {
 const project=fixture(t),id='build_delivery_fixture_001',directory=path.join(project.root,'.local/fwb/artifacts',id);fs.mkdirSync(path.join(directory,'out'),{recursive:true});
 const files={'index.html':Buffer.from('<!doctype html><title>Fixture</title>'),'index.js':Buffer.from('// engine fixture'),'index.wasm':wasmFixture(),'index.pck':pckFixture()};
 const outputs=Object.entries(files).map(([name,bytes])=>{fs.writeFileSync(path.join(directory,'out',name),bytes);return{path:'out/'+name,size:bytes.length,sha256:digest(bytes)};});
 const manifest={schemaVersion:1,id,status:'built',target,entry:'out/index.html',outputs,validation:{package:'passed',runtime:'not-tested',platform:'not-tested'}};
 const save=()=>atomicJson(path.join(directory,'manifest.json'),manifest);save();
 return{project,id,directory,manifest,save,artifact:()=>readArtifact(project.root,id)};
}

function unpackZip(bytes) {
 const end = bytes.length - 22;
 assert.equal(bytes.readUInt32LE(end), 0x06054b50);
 const count = bytes.readUInt16LE(end + 10), directoryOffset = bytes.readUInt32LE(end + 16);
 assert.equal(directoryOffset + bytes.readUInt32LE(end + 12), end);
 const files = new Map(); let cursor = directoryOffset;
 for (let i = 0; i < count; i++) {
  assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
  assert.equal(bytes.readUInt16LE(cursor + 10), 8, 'ZIP entry must use Deflate');
  assert.equal(bytes.readUInt16LE(cursor + 8), 0x800, 'names are UTF-8');
  const compressedSize = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
  const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
  const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8'), local = bytes.readUInt32LE(cursor + 42);
  assert.equal(bytes.readUInt32LE(local), 0x04034b50);
  assert.equal(bytes.readUInt16LE(local + 8), 8);
  assert.equal(bytes.readUInt16LE(local + 6), 0x800);
  assert.equal(bytes.readUInt32LE(local + 18), compressedSize);
  assert.equal(bytes.readUInt32LE(local + 22), size);
  const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28);
  assert.equal(bytes.subarray(local + 30, local + 30 + localNameSize).toString('utf8'), name);
  const start = local + 30 + localNameSize + localExtraSize;
  assert(start + compressedSize <= directoryOffset);
  const data = inflateRawSync(bytes.subarray(start, start + compressedSize));
  assert.equal(data.length, size);
  // Independent bitwise CRC validates ZIP readers' integrity fields.
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  assert.equal(bytes.readUInt32LE(cursor + 16), crc);
  assert.equal(bytes.readUInt32LE(local + 14), crc);
  assert(!files.has(name)); files.set(name, data);
  cursor += 46 + nameSize + extraSize + commentSize;
 }
 assert.equal(cursor, end);
 return files;
}

test('workbench ZIP deflates every output and preserves Web and TapTap H5 layouts', async t => {
 for (const target of ['web', 'taptap-h5']) {
  const f = deliveryFixture(t, target), payload = Buffer.from('Repeated media fixture data.\n'.repeat(4096));
  const relative = 'media/营地.txt'; fs.mkdirSync(path.join(f.directory, 'out/media'));
  fs.writeFileSync(path.join(f.directory, 'out', relative), payload);
  f.manifest.outputs.push({ path: 'out/' + relative, size: payload.length, sha256: digest(payload) }); f.save();
  const zip = await packageArtifact(f.artifact()), files = unpackZip(zip), prefix = target === 'taptap-h5' ? 'game/' : '';
  assert(zip.length < payload.length / 10, 'repeated payload must actually be compressed');
  assert.deepEqual([...files.keys()], f.manifest.outputs.map(output => prefix + output.path.slice(4)));
  for (const output of f.manifest.outputs) assert.deepEqual(files.get(prefix + output.path.slice(4)), fs.readFileSync(path.join(f.directory, output.path)));
  assert(files.has(prefix + 'index.html'));
  if (target === 'taptap-h5') { assert(!files.has('index.html')); assert([...files.keys()].every(name => name.startsWith('game/'))); }
  else assert(!files.has('game/index.html'));
 }
});

test('workbench TapTap H5 ZIP requires index.html and preserves the legacy entry fallback', async t => {
 const legacy = deliveryFixture(t, 'taptap-h5'); delete legacy.manifest.entry; legacy.save();
 assert(unpackZip(await packageArtifact(legacy.artifact())).has('game/index.html'));
 const wrong = deliveryFixture(t, 'taptap-h5'); wrong.manifest.entry = 'out/other.html'; wrong.save();
 await assert.rejects(packageArtifact(wrong.artifact()), { code: 'invalid-package' });
 const f = deliveryFixture(t, 'taptap-h5');
 f.manifest.outputs = f.manifest.outputs.filter(output => output.path !== 'out/index.html');
 fs.unlinkSync(path.join(f.directory, 'out/index.html')); f.save();
 await assert.rejects(packageArtifact(f.artifact()), { code: 'invalid-package' });
});

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
