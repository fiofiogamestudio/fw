import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';

// Uses an isolated project and FWE's owned Chrome profile; never attaches to the user's browser.
const require=createRequire(import.meta.url),fwvRoot=fileURLToPath(new URL('../',import.meta.url));
const fwePath=await fs.realpath(process.env.FWV_FWE_PATH||fileURLToPath(new URL('../../fwe',import.meta.url)));
const {startChrome,stopProcess,getFreePort,waitForTarget,connectCdp,evaluate,waitForExpression}=require(path.join(fwePath,'test','browser-smoke.js'));
let outputArgument;
for(let i=2;i<process.argv.length;i++){if(process.argv[i]!=='--output'||!process.argv[i+1])throw new Error('Usage: node tools/test-image-recipe-browser.mjs [--output directory]');outputArgument=process.argv[++i];}
const output=path.resolve(outputArgument||path.join(fwvRoot,'.local','reports','image-recipe-browser'));
await fs.mkdir(output,{recursive:true});
const runRoot=await fs.mkdtemp(path.join(output,'run-')),projectRoot=path.join(runRoot,'project'),project=new FwvProject(projectRoot);
const report={schemaVersion:1,startedAt:new Date().toISOString(),status:'running',runRoot,projectRoot,checks:[],screenshots:[],browserErrors:[],modelRequests:[],dialogs:[]};
const digest=buffer=>createHash('sha256').update(buffer).digest('hex'),q=JSON.stringify,sel=id=>`[data-testid="${id}"]`,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let editor,chrome,cdp,assetId,stage='setup';
const provider=http.createServer((request,response)=>{report.modelRequests.push({method:request.method,url:request.url});request.resume();response.writeHead(503,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:'Image processing must not call a model.'}}));});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
function passed(name,details={}){report.checks.push({name,status:'passed',...details});console.log(`[FWV image recipe] ${name}`);}
const expression=value=>waitForExpression(cdp,value,20000);
async function waitFor(fn,label){const until=Date.now()+20000;while(Date.now()<until){const value=await fn();if(value)return value;await pause(60);}throw new Error('Timed out: '+label);}
async function value(id){return evaluate(cdp,`document.querySelector(${q(sel(id))})?.value`);}
async function text(id){return evaluate(cdp,`document.querySelector(${q(sel(id))})?.textContent`);}
async function reveal(id,{picker=false}={}){
  await expression(`document.querySelector(${q(sel(id))})`);
  await evaluate(cdp,`(()=>{const node=document.querySelector(${q(sel(id))}),ancestors=[];for(let item=node.parentElement;item;item=item.parentElement)if(item.tagName==='DETAILS')ancestors.unshift(item);for(const item of ancestors)if(!item.open)item.querySelector(':scope > summary').click();node.scrollIntoView({block:'nearest'});})()`);
  if(!picker)await expression(`document.querySelector(${q(sel(id))}).checkVisibility()`);
}
async function click(id){await reveal(id);await expression(`!document.querySelector(${q(sel(id))}).disabled`);await evaluate(cdp,`document.querySelector(${q(sel(id))}).click()`);}
async function fill(id,newValue,event='input'){await reveal(id);await expression(`!document.querySelector(${q(sel(id))}).disabled`);await evaluate(cdp,`(()=>{const node=document.querySelector(${q(sel(id))});node.value=${q(String(newValue))};node.dispatchEvent(new Event(${q(event)},{bubbles:true}));})()`);}
async function toolbar(id){await expression(`document.querySelector(${q('#'+id)})&&!document.querySelector(${q('#'+id)}).disabled`);await evaluate(cdp,`document.querySelector(${q('#'+id)}).click()`);}
async function saveParameters(){await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS',modifiers:2,windowsVirtualKeyCode:83});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS',modifiers:2,windowsVirtualKeyCode:83});await expression(`document.querySelector('#saveButton').disabled`);}
async function images(){await expression(`document.querySelector('button[data-workspace-id="fwv-tools"]')&&!document.querySelector('button[data-workspace-id="fwv-tools"]').disabled`);await evaluate(cdp,`(()=>{const tab=document.querySelector('button[data-workspace-id="fwv-tools"]');if(tab.getAttribute('aria-selected')!=='true')tab.click();})()`);await expression(`document.querySelector('button[data-section-id="images"]')&&!document.querySelector('button[data-section-id="images"]').disabled`);await evaluate(cdp,`document.querySelector('button[data-section-id="images"]').click()`);await expression(`document.querySelector(${q(sel('fwv-process'))})&&!document.querySelector(${q(sel('fwv-process'))}).disabled`);}
async function asset(){return (await project.snapshot()).assets.find(item=>item.id===assetId);}
async function pixels(revision){const file=revision.files.find(item=>item.role==='image'||item.role==='source');const buffer=(await project.readArtifact({assetId,revisionId:revision.id,fileName:file.name})).buffer;
  const {data,info}=await sharp(buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});let left=info.width,top=info.height,right=-1,bottom=-1;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>=128){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  return {sha256:digest(buffer),width:info.width,height:info.height,bounds:{x:left,y:top,width:right-left+1,height:bottom-top+1}};
}
async function processImage(){const before=(await asset()).revisions.length;await click('fwv-process');const updated=await waitFor(async()=>{const next=await asset();return next.revisions.length>before?next:false;},'processed revision');const revision=updated.revisions.find(item=>item.id===updated.selectedRevisionId);
  await expression(`document.querySelector(${q(sel('fwv-revision'))})?.value===${q(revision.id)}&&!document.querySelector(${q(sel('fwv-process'))}).disabled`);
  await expression(`document.querySelector(${q(sel('fwv-current-preview'))})?.complete&&document.querySelector(${q(sel('fwv-current-preview'))})?.naturalWidth>0`);return revision;
}
async function screenshot(name){await evaluate(cdp,`(()=>{const root=document.querySelector(${q(sel('fwv-workbench'))});for(const item of root.querySelectorAll('details[open]'))item.querySelector(':scope > summary').click();for(let node=root;node;node=node.parentElement){node.scrollTop=0;node.scrollLeft=0;}window.scrollTo(0,0);})()`);await pause(80);const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const target=path.join(runRoot,name+'.png');await fs.writeFile(target,Buffer.from(shot.data,'base64'));report.screenshots.push(target);}

try{
  await project.init({name:'图片配方修订验收'});
  const source=await sharp({create:{width:100,height:100,channels:4,background:'#ff0000'}}).png().toBuffer(),sourceFile=path.join(runRoot,'red.png');await fs.writeFile(sourceFile,source);
  editor=await startEditor({projectRoot,fwePath,port:0});report.url=editor.url;
  const session=await fetch(editor.url+'/api/fwv/session').then(response=>response.json());
  const configured=await fetch(editor.url+'/api/fwv/commands',{method:'POST',headers:{Origin:editor.url,'X-FWV-CSRF':session.csrfToken,'Content-Type':'application/json'},body:JSON.stringify({type:'provider.configure',payload:{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,protocol:'openai-compatible',clearKey:true}})});assert.equal(configured.status,200);
  const debugPort=await getFreePort();chrome=startChrome(editor.url,debugPort);const target=await waitForTarget(debugPort,editor.url,16000);cdp=await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown',event=>report.browserErrors.push(event.exceptionDetails?.exception?.description||event.exceptionDetails?.text));
  cdp.on('Log.entryAdded',event=>{if(event.entry?.level==='error')report.browserErrors.push(`${event.entry.text} @ ${event.entry.url||''}`);});
  cdp.on('Page.javascriptDialogOpening',event=>{report.dialogs.push({stage,type:event.type,message:event.message});void cdp.call('Page.handleJavaScriptDialog',{accept:event.type==='beforeunload'});});
  for(const domain of ['Runtime','Log','Page','DOM'])await cdp.call(domain+'.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp.call('Page.reload',{ignoreCache:true});
  await images();
  stage='import source';await reveal('fwv-import-input',{picker:true});const tree=await cdp.call('DOM.getDocument',{depth:0});const {nodeId}=await cdp.call('DOM.querySelector',{nodeId:tree.root.nodeId,selector:sel('fwv-import-input')});await cdp.call('DOM.setFileInputFiles',{nodeId,files:[sourceFile]});
  const imported=await waitFor(async()=>(await project.snapshot()).assets.find(item=>item.kind==='image'),'file picker import');assetId=imported.id;const original=imported.revisions[0];await images();
  assert.match(await text('fwv-processing-source'),/v1.*输入/);
  await fill('fwv-padding',10);const first=await processImage(),firstPixels=await pixels(first);assert.deepEqual(firstPixels.bounds,{x:10,y:10,width:80,height:80});
  assert.equal(await value('fwv-processing-mode'),'revise');assert.equal(await value('fwv-padding'),'10');assert.match(await text('fwv-processing-source'),/修改 v2.*v1.*输入/);
  passed('First processing creates an 80 by 80 subject and the resulting editor defaults to revising the original input',{revisionId:first.id,pixels:firstPixels});

  stage='repeat revision recipe';const repeated=await processImage(),repeatedPixels=await pixels(repeated);assert.deepEqual(repeatedPixels.bounds,firstPixels.bounds);assert.equal(repeatedPixels.sha256,firstPixels.sha256);assert.equal(repeated.metadata.processing.inputRevisionId,original.id);assert.match(await text('fwv-processing-source'),/修改 v3.*输入 v1/);
  passed('Repeating the displayed recipe keeps identical pixels instead of shrinking the already processed result',{revisionId:repeated.id,pixels:repeatedPixels});
  await fill('fwv-padding',20);const revised=await processImage(),revisedPixels=await pixels(revised);assert.deepEqual(revisedPixels.bounds,{x:20,y:20,width:60,height:60});assert.equal(revised.metadata.processing.inputRevisionId,original.id);assert.match(await text('fwv-processing-source'),/修改 v4.*v1.*输入/);
  await screenshot('01-revise-1280');passed('Changing padding to 20 revises the original input into a 60 by 60 subject',{revisionId:revised.id,pixels:revisedPixels});

  stage='mode and recipe persistence';await fill('fwv-processing-mode','append','change');assert.equal(await value('fwv-padding'),'0');assert.match(await text('fwv-processing-source'),/输入 v4.*追加加工/);await fill('fwv-padding',10);await saveParameters();
  let stored=JSON.parse(await fs.readFile(path.join(projectRoot,'.fwv','editor-drafts.json'),'utf8'));let entry=stored.imageDrafts.find(item=>item.id===`${assetId}:${revised.id}`);assert.equal(entry.data.processingMode,'append');assert.equal(entry.data.recipe.padding,10);
  await toolbar('undoButton');await expression(`document.querySelector(${q(sel('fwv-padding'))})?.value==='0'`);assert.equal(await value('fwv-processing-mode'),'append');
  await toolbar('undoButton');await expression(`document.querySelector(${q(sel('fwv-processing-mode'))})?.value==='revise'`);assert.equal(await value('fwv-padding'),'20');
  await toolbar('redoButton');await expression(`document.querySelector(${q(sel('fwv-processing-mode'))})?.value==='append'`);await toolbar('redoButton');await expression(`document.querySelector(${q(sel('fwv-padding'))})?.value==='10'`);await saveParameters();
  const timeOrigin=await evaluate(cdp,'performance.timeOrigin');await cdp.call('Page.reload',{ignoreCache:true});await expression(`performance.timeOrigin!==${timeOrigin}`);await images();await expression(`document.querySelector(${q(sel('fwv-revision'))})?.value===${q(revised.id)}`);assert.equal(await value('fwv-processing-mode'),'append');assert.equal(await value('fwv-padding'),'10');assert.match(await text('fwv-processing-source'),/以 v4 当前图片为输入/);
  passed('Mode switches reset append parameters; native Ctrl+S, undo, redo and reload preserve mode with the matching recipe');
  stage='explicit append';const appended=await processImage(),appendedPixels=await pixels(appended);assert.ok(appendedPixels.bounds.width<60&&appendedPixels.bounds.height<60);assert.equal(appended.metadata.processing.inputRevisionId,revised.id);assert.equal(await value('fwv-processing-mode'),'revise');assert.match(await text('fwv-processing-source'),/修改 v5.*输入 v4/);
  passed('Explicit append uses the currently displayed pixels, while later revision edits retain that exact input',{revisionId:appended.id,pixels:appendedPixels});

  stage='fit cover';await fill('fwv-fit','cover','change');await fill('fwv-width',120);await fill('fwv-height',80);const covered=await processImage(),coveredPixels=await pixels(covered);assert.equal(coveredPixels.width,120);assert.equal(coveredPixels.height,80);assert.equal(covered.recipe.fit,'cover');passed('The visible cover fit option executes successfully and creates the requested rectangular output',{revisionId:covered.id,pixels:coveredPixels});
  stage='exact export display';await click('fwv-export');const exported=await waitFor(async()=>(await project.snapshot()).exports.find(item=>item.assetId===assetId&&item.revisionId===covered.id),'export current revision');await expression(`document.querySelector(${q(sel('fwv-export-path'))})?.textContent.includes(${q(exported.path)})`);
  await fill('fwv-revision',original.id,'change');assert.equal(await text('fwv-export-path'),'');assert.equal(await evaluate(cdp,`document.querySelector(${q(sel('fwv-export-path'))}).hidden`),true);
  await fill('fwv-revision',covered.id,'change');assert.ok((await text('fwv-export-path')).includes(exported.path));passed('Export paths follow the exact displayed revision and disappear when viewing an unexported revision');

  stage='narrow layout';await cdp.call('Emulation.setDeviceMetricsOverride',{width:1000,height:1000,deviceScaleFactor:1,mobile:false});await screenshot('02-image-1000');
  const layout=await evaluate(cdp,`(()=>{const root=document.querySelector(${q(sel('fwv-workbench'))}),action=document.querySelector(${q(sel('fwv-process'))}).getBoundingClientRect(),preview=document.querySelector(${q(sel('fwv-current-preview'))}).getBoundingClientRect(),source=document.querySelector(${q(sel('fwv-processing-source'))}).getBoundingClientRect();return {pageOverflow:document.documentElement.scrollWidth-innerWidth,panelOverflow:root.scrollWidth-root.clientWidth,actionVisible:action.top>=0&&action.bottom<=innerHeight,previewVisible:preview.top>=0&&preview.bottom<=innerHeight,sourceVisible:source.top>=0&&source.bottom<=innerHeight};})()`);
  assert.ok(layout.pageOverflow<=2&&layout.panelOverflow<=2);assert.equal(layout.actionVisible,true);assert.equal(layout.previewVisible,true);assert.equal(layout.sourceVisible,true);passed('A 1000px viewport keeps the preview, exact input summary and processing action visible without horizontal overflow',layout);
  assert.equal((await pixels(original)).sha256,digest(source));assert.deepEqual(report.browserErrors,[]);assert.deepEqual(report.modelRequests,[]);assert.deepEqual(report.dialogs,[]);
  passed('Original pixels remain unchanged and the complete workflow makes no model requests');report.status='passed';
}catch(error){report.status='failed';report.failureStage=stage;report.error=error.stack||String(error);process.exitCode=1;if(cdp)try{await screenshot('failure');report.visibleStatus=await text('fwv-status');}catch{}console.error(`[FWV image recipe] FAILED at ${stage}: ${error.message}`);
}finally{if(cdp)cdp.close();if(chrome)await stopProcess(chrome);if(editor)await editor.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(runRoot,'report.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(path.join(output,'latest.json'),JSON.stringify({status:report.status,report:path.join(runRoot,'report.json')},null,2)+'\n');console.log(JSON.stringify({status:report.status,report:path.join(runRoot,'report.json')},null,2));}
