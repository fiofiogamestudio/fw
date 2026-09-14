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
import { configureExport } from '../src/core/build.mjs';
import { digest } from '../src/core/files.mjs';
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
test('delivery ZIP contains only intact outputs and rejects changed files',t=>{
 const project=fixture(t),directory=path.join(project.root,'artifact');fs.mkdirSync(path.join(directory,'out'),{recursive:true});const bytes=Buffer.from('test-output');fs.writeFileSync(path.join(directory,'out/index.html'),bytes);fs.writeFileSync(path.join(directory,'private.txt'),'not-exported');
 const artifact={status:'built',directory,outputs:[{path:'out/index.html',size:bytes.length,sha256:digest(bytes)}]};const zip=packageArtifact(artifact);assert.equal(zip.readUInt32LE(0),0x04034b50);assert(zip.includes(Buffer.from('index.html')));assert(!zip.includes(Buffer.from('private.txt')));fs.writeFileSync(path.join(directory,'out/index.html'),'tampered!!!');assert.throws(()=>packageArtifact(artifact),/变化/);
});
