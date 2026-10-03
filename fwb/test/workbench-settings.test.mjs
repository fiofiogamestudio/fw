import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { initProject, readProject, updateProject } from '../src/core/project.mjs';
import { readEnvironment } from '../src/core/environment.mjs';
import { createWorkbenchState } from '../src/editor/state.mjs';

class Element {
  constructor(tag) { this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.listeners={};this.textContent='';this.value='';this.isConnected=true; }
  append(...children) { for(const child of children){child.parentElement=this;this.children.push(child);} }
  replaceChildren(...children) { for(const child of this.children)child.parentElement=null;this.children=[];this.append(...children); }
  setAttribute(key,value) { this.attributes[key]=value; }
  addEventListener(type,handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type) { if(type==='click'&&this.disabled)return;for(const handler of this.listeners[type]||[])handler({target:this}); }
  get firstChild() { return this.children[0]; }
  get options() { return this.querySelectorAll('option'); }
  querySelectorAll(selector) { const names=selector.split(',');return this.children.flatMap(child=>[...(names.includes(child.tagName)?[child]:[]),...child.querySelectorAll(selector)]); }
  showModal() { this.open=true; }
  close() { this.open=false;this.dispatch('close'); }
  remove() { this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this); }
}
const descendants=node=>[node,...node.children.flatMap(descendants)];
const flush=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t,configure=()=>{},services={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fwb-settings-ui-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'project.godot'),'[application]\nconfig/name="UI settings fixture"\n');
  await fs.mkdir(path.join(root,'sdk/wechat'),{recursive:true});
  await fs.writeFile(path.join(root,'sdk/wechat/convert.mjs'),'// Adapter test fixture.\n');
  await fs.mkdir(path.join(root,'tools'));await fs.writeFile(path.join(root,'tools/prepare.mjs'),'// Resource preparation test fixture.\n');
  let project=initProject(root);configure(project.config);project=updateProject(root,project.config,project.revision);
  const environmentFile=path.join(root,'.local/environment.json'),commands=[],operations=[];
  const artifact={id:'build_fixture123',target:'web',profile:'debug',status:'built',validation:{package:'passed',runtime:'not-tested',platform:'not-tested'}};
  const state=await createWorkbenchState(root,{readProject,updateProject,environmentFile,listArtifacts:()=>[artifact],
    doctor:async(project,payload)=>{operations.push({type:'doctor',config:structuredClone(project.config),payload});return{ok:true,checks:[]};},
    buildProject:async(root,payload)=>{operations.push({type:'build',payload});return artifact;},
    planUpload:async(...args)=>{operations.push({type:'upload-plan',args});return{canExecute:false,status:'handoff',checks:[]};},
    ...services,
  });
  t.after(()=>state.close());let layout,tick;
  const document={createElement:tag=>new Element(tag),createTextNode:text=>Object.assign(new Element('#text'),{textContent:text})};
  const context=vm.createContext({document,setInterval:callback=>{tick=callback;return 0;},clearInterval(){},window:{fwe:{session:{headers:headers=>headers},registerWorkbenchLayout:(name,value)=>{layout=value;}}},fetch:async(url,options)=>{
    try {
      let body;
      if(url==='/api/fwb/session')body={csrfToken:'fixture'};
      else if(url==='/api/fwb/snapshot')body=await state.snapshot();
      else if(url==='/api/fwb/config')body=await state.configuration();
      else if(url==='/api/fwb/environment')body=await state.environment();
      else if(url==='/api/fwb/releases')body=await state.releases();
      else if(url==='/api/fwb/commands'){const command=JSON.parse(options.body);commands.push(command);body={job:await state.command(command)};}
      else throw new Error('Unexpected route: '+url);
      return{ok:true,json:async()=>structuredClone(body)};
    }catch(error){return{ok:false,json:async()=>({error:error.message})};}
  }});
  vm.runInContext(await fs.readFile(new URL('../src/editor/app/workbench.js',import.meta.url),'utf8'),context);
  const host=new Element('div');layout.render({hosts:{documentTree:host},showView(){}});
  const settle=async()=>{for(let i=0;i<4;i++){await flush();tick();}await flush();};await settle();
  const find=predicate=>descendants(host).find(predicate),byLabel=name=>find(node=>node.attributes['aria-label']===name),byId=id=>find(node=>node.dataset.testid===id);
  const button=name=>find(node=>node.tagName==='button'&&node.textContent===name);
  const click=async node=>{assert.ok(node,'Expected button');node.dispatch('click');await settle();};
  const set=(name,value)=>{const node=byLabel(name);assert.ok(node,name);node.value=value;node.dispatch('input');node.dispatch('change');};
  return{root,environmentFile,commands,operations,host,find,byLabel,byId,button,click,set,settle,state};
}

test('shared Web preparation can be configured and cleared through saved UI settings without changing other pipelines or targets',async t=>{
  const ui=await fixture(t,config=>{config.resourcePipelines={mobile:{prepareScript:'tools/mobile.mjs'}};config.targets.web.prepareScript='tools/legacy.mjs';});
  const targets=readProject(ui.root).config.targets;
  assert.match(ui.byId('fwb-resource-preparation').textContent,/tools\/legacy.mjs.*平台单独设置/);
  await ui.click(ui.button('工程接入'));ui.set('共享 Web 资源准备脚本（可选）','tools/prepare.mjs');
  await ui.click(ui.button('保存工程参数'));
  let saved=readProject(ui.root).config;
  assert.deepEqual(saved.resourcePipelines,{mobile:{prepareScript:'tools/mobile.mjs'},web:{prepareScript:'tools/prepare.mjs'}});
  assert.deepEqual(saved.targets,targets);assert.equal(ui.byId('fwb-unsaved').hidden,true);
  ui.set('共享 Web 资源准备脚本（可选）','');await ui.click(ui.button('保存工程参数'));
  saved=readProject(ui.root).config;assert.deepEqual(saved.resourcePipelines,{mobile:{prepareScript:'tools/mobile.mjs'}});assert.deepEqual(saved.targets,targets);
  assert.equal(ui.commands.filter(command=>command.type==='settings.save').length,2);
});

test('clearing the only shared Web definition removes its empty container',async t=>{
  const ui=await fixture(t,config=>{config.resourcePipelines={web:{prepareScript:'tools/prepare.mjs'}};});
  ui.set('共享 Web 资源准备脚本（可选）','');await ui.click(ui.button('保存工程参数'));
  assert.equal(Object.hasOwn(readProject(ui.root).config,'resourcePipelines'),false);
  assert.equal(ui.byId('fwb-unsaved').hidden,true);
});

test('platform preparation override can be edited and cleared with immediate effective-source feedback',async t=>{
  const ui=await fixture(t,config=>{config.resourcePipelines={web:{prepareScript:'tools/prepare.mjs'}};config.targets.web.prepareScript='tools/legacy.mjs';});
  await ui.click(ui.button('平台设置'));
  assert.equal(ui.byLabel('平台资源准备脚本（覆盖共享，可选）').value,'tools/legacy.mjs');
  ui.set('平台资源准备脚本（覆盖共享，可选）','tools/new-override.mjs');
  assert.match(ui.byId('fwb-resource-preparation').textContent,/tools\/new-override.mjs.*平台单独设置/);
  ui.set('平台资源准备脚本（覆盖共享，可选）','');
  assert.match(ui.byId('fwb-resource-preparation').textContent,/tools\/prepare.mjs.*共享流水线 web/);
  await ui.click(ui.button('保存平台设置'));
  const saved=readProject(ui.root).config;
  assert.equal(Object.hasOwn(saved.targets.web,'prepareScript'),false);
  assert.deepEqual(saved.resourcePipelines,{web:{prepareScript:'tools/prepare.mjs'}});
  assert.equal(ui.byId('fwb-unsaved').hidden,true);
});

test('opening an unconfigured mini-game target leaves preset unset so its selected route owns the default',async t=>{
  const ui=await fixture(t,config=>{delete config.targets['wechat-minigame'];delete config.targets['douyin-minigame'];});
  ui.set('构建目标','wechat-minigame');await ui.click(ui.button('平台设置'));
  assert.equal(ui.byLabel('导出预设名称').value,'');
  ui.set('Web → 微信转换脚本（可选）','sdk/wechat/convert.mjs');await ui.click(ui.button('保存平台设置'));
  assert.equal(Object.hasOwn(readProject(ui.root).config.targets['wechat-minigame'],'preset'),false);
  ui.set('设置平台','douyin-minigame');assert.equal(ui.byLabel('导出预设名称').value,'');
  ui.set('SDK 版本','fixture-1');await ui.click(ui.button('保存平台设置'));
  assert.equal(Object.hasOwn(readProject(ui.root).config.targets['douyin-minigame'],'preset'),false);
});

test('unsaved project and machine settings block dependent commands, preserve drafts across pages and recover independently after save or reload',async t=>{
  const ui=await fixture(t);ui.set('版本号','0.2.0');ui.set('Godot 可执行文件',process.execPath);
  await ui.click(ui.button('平台设置'));ui.set('导出预设名称','Web Revised');
  await ui.click(ui.button('工程接入'));assert.equal(ui.byLabel('版本号').value,'0.2.0');
  await ui.click(ui.button('本机环境'));assert.equal(ui.byLabel('Godot 可执行文件').value,process.execPath);
  await ui.click(ui.button('平台设置'));assert.equal(ui.byLabel('导出预设名称').value,'Web Revised');
  const before=ui.commands.length;
  for(const node of [ui.byId('fwb-doctor'),ui.byId('fwb-build'),ui.button('批量构建已启用平台'),ui.button('补全缺失导出预设')])await ui.click(node);
  assert.equal(ui.commands.length,before);assert.match(ui.byId('fwb-unsaved').textContent,/工程设置和本机环境/);assert.equal(ui.byId('fwb-unsaved').hidden,false);
  await ui.click(ui.button('保存平台设置'));assert.equal(readProject(ui.root).config.version,'0.2.0');
  assert.match(ui.byId('fwb-unsaved').textContent,/未保存的本机环境/);
  const afterProjectSave=ui.commands.length;await ui.click(ui.byId('fwb-doctor'));assert.equal(ui.commands.length,afterProjectSave);
  await ui.click(ui.button('保存本机环境'));assert.equal(readEnvironment(ui.environmentFile).config.godot.executable,process.execPath);
  assert.equal(ui.byId('fwb-unsaved').hidden,true);await ui.click(ui.byId('fwb-doctor'));assert.equal(ui.operations.at(-1).type,'doctor');
  assert.equal(ui.operations.at(-1).config.targets.web.preset,'Web Revised');
  ui.set('版本号','0.3.0');ui.set('Godot 可执行文件','unsaved-godot');
  await ui.click(ui.button('重新读取工程配置'));assert.equal(ui.byLabel('版本号').value,'0.2.0');assert.equal(ui.byLabel('Godot 可执行文件').value,'unsaved-godot');
  assert.equal(ui.byId('fwb-unsaved').hidden,false);await ui.click(ui.button('重新读取本机环境'));assert.equal(ui.byId('fwb-unsaved').hidden,true);
  await ui.click(ui.button('补全缺失导出预设'));assert.match(await fs.readFile(path.join(ui.root,'export_presets.cfg'),'utf8'),/name="Web Revised"/);
});

test('temporary acceptance fields do not mark persisted settings dirty or block checking upload conditions',async t=>{
  const ui=await fixture(t);await ui.click(ui.button('验收与上传'));ui.set('验收产物','build_fixture123');await ui.settle();
  ui.set('验收备注','Review report fixture');assert.equal(ui.byId('fwb-unsaved').hidden,true);
  await ui.click(ui.button('检查上传条件'));assert.equal(ui.operations.at(-1).type,'upload-plan');
});

test('browsing resolves relative SDK and converter paths against the project and keeps absolute paths usable',async t=>{
  const ui=await fixture(t,config=>{config.targets['wechat-minigame'].sdkPath='sdk/wechat';config.targets['wechat-minigame'].convertScript='sdk/wechat/convert.mjs';});
  ui.set('构建目标','wechat-minigame');await ui.click(ui.button('平台设置'));
  const browse=label=>ui.byLabel(label).parentElement.children.find(node=>node.tagName==='button');
  await ui.click(browse('平台适配 SDK 目录'));
  assert.equal(path.resolve(ui.commands.at(-1).payload.path),path.join(ui.root,'sdk/wechat'));
  await ui.click(ui.button('选择此目录'));assert.equal(ui.byLabel('平台适配 SDK 目录').value,'sdk/wechat');
  await ui.click(browse('平台适配 SDK 目录'));assert.equal(path.resolve(ui.commands.at(-1).payload.path),path.join(ui.root,'sdk/wechat'));await ui.click(ui.button('关闭'));
  await ui.click(browse('Web → 微信转换脚本（可选）'));
  assert.equal(path.resolve(ui.commands.at(-1).payload.path),path.join(ui.root,'sdk/wechat/convert.mjs'));
  await ui.click(ui.button('文件 · convert.mjs'));assert.equal(ui.byLabel('Web → 微信转换脚本（可选）').value,'sdk/wechat/convert.mjs');
  await ui.click(ui.button('保存平台设置'));assert.equal(readProject(ui.root).config.targets['wechat-minigame'].convertScript,'sdk/wechat/convert.mjs');
  ui.set('工程 Godot 路径（可选）',process.execPath);await ui.click(browse('工程 Godot 路径（可选）'));
  assert.equal(ui.commands.at(-1).payload.path,process.execPath);await ui.click(ui.button('关闭'));
});

test('failed build preflight exposes its recorded checks and blocks rebuild without losing failure status',async t=>{
  const message='模板版本标记与引擎不一致。',artifact={id:'build_preflight_failed',target:'web',profile:'release',status:'failed',diagnosis:{ok:false,checks:[{id:'template-version',status:'fail',message,action:'选择与当前引擎相同版本的导出模板。'}]}};
  const ui=await fixture(t,()=>{},{listArtifacts:()=>[artifact],buildProject:async()=>{throw Object.assign(new Error(message),{artifactId:artifact.id});},readArtifact:(root,id)=>{assert.equal(id,artifact.id);return artifact;}});
  ui.set('构建配置','release');await ui.click(ui.byId('fwb-build'));
  const job=(await ui.state.snapshot()).jobs[0];
  assert.equal(job.status,'failed');assert.equal(job.error,message);assert.equal(job.artifactId,artifact.id);assert.deepEqual(job.result,{diagnosis:artifact.diagnosis});
  assert.ok(descendants(ui.byId('fwb-diagnostics')).some(node=>node.textContent==='受阻 · '+message));
  assert.equal(ui.byId('fwb-build').disabled,true);assert.equal(ui.byId('fwb-doctor').disabled,false);
  assert.equal(ui.find(node=>node.textContent==='尚未检查 release 配置，构建前会自动预检。'),undefined);
  assert.ok(descendants(ui.byId('fwb-artifacts')).some(node=>node.textContent==='release · 失败'));
  ui.set('构建配置','debug');assert.equal(ui.byId('fwb-build').disabled,false);
  ui.set('构建配置','release');assert.equal(ui.byId('fwb-build').disabled,true);
  ui.set('版本号','0.2.0');await ui.click(ui.button('保存工程参数'));
  assert.equal(ui.byId('fwb-build').disabled,false);
  assert.ok(descendants(ui.byId('fwb-diagnostics')).some(node=>node.textContent==='尚未检查 release 配置，构建前会自动预检。'));
});

test('a failed export retains failure and allows retry when its recorded preflight passed',async t=>{
  const artifact={id:'build_export_failed',target:'web',profile:'debug',status:'failed',diagnosis:{ok:true,checks:[{id:'export-template',status:'pass',message:'模板检查通过。'}]}};
  const ui=await fixture(t,()=>{},{listArtifacts:()=>[artifact],buildProject:async()=>{throw Object.assign(new Error('Godot export reported errors.'),{artifactId:artifact.id});},readArtifact:()=>artifact});
  await ui.click(ui.byId('fwb-build'));const job=(await ui.state.snapshot()).jobs[0];
  assert.equal(job.status,'failed');assert.equal(job.error,'Godot export reported errors.');assert.equal(job.result.diagnosis.ok,true);
  assert.equal(ui.byId('fwb-build').disabled,false);
  assert.ok(descendants(ui.byId('fwb-artifacts')).some(node=>node.textContent==='debug · 失败'));
  assert.equal(ui.button('启动预览'),undefined);
  assert.equal(ui.find(node=>node.textContent==='构建完成。请继续运行和平台验收。'),undefined);
});

test('unreadable or mismatched failure manifests never replace the original build error',async t=>{
  for(const broken of ['unreadable','other-target'])await t.test(broken,async t=>{
    const ui=await fixture(t,()=>{},{listArtifacts:()=>[],buildProject:async()=>{throw Object.assign(new Error('Original build failure'),{artifactId:'build_failed_manifest'});},readArtifact:()=>{if(broken==='unreadable')throw new Error('Manifest unavailable');return{target:'poki',profile:'debug',diagnosis:{ok:false,checks:[]}};}});
    await ui.click(ui.byId('fwb-build'));const job=(await ui.state.snapshot()).jobs[0];
    assert.equal(job.status,'failed');assert.equal(job.error,'Original build failure');assert.equal(job.artifactId,'build_failed_manifest');assert.equal(job.result,undefined);
  });
});
