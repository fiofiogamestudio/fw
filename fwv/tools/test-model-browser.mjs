import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FwvProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { createModelFixture } from '../test/fixtures/model.mjs';
import { decodeGlb, encodeGlb } from '../src/model/glb.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), fwePath = fileURLToPath(new URL('../../fwe', import.meta.url)), require = createRequire(import.meta.url);
const { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test/browser-smoke.js'));
const output = path.join(root, '.local/reports/model-browser'); await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-')), projectRoot = path.join(runRoot, 'project'), project = new FwvProject(projectRoot);
const report = { status: 'running', runRoot, checks: [], errors: [], screenshots: [] }, q = JSON.stringify;
let editor, chrome, cdp;
const wait = expression => waitForExpression(cdp, expression, 20000), testId = id => `[data-testid="fwv-model-${id}"]`;
async function reveal(css) { await wait(`document.querySelector(${q(css)})`); await evaluate(cdp, `(()=>{const e=document.querySelector(${q(css)});for(let p=e;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;e.scrollIntoView({block:'center'});})()`); }
async function click(id) { const css=testId(id);await reveal(css);await wait(`!document.querySelector(${q(css)}).matches(':disabled')`);await evaluate(cdp,`document.querySelector(${q(css)}).click()`); }
async function fill(id,value,event='input') { const css=testId(id);await reveal(css);await wait(`!document.querySelector(${q(css)}).matches(':disabled')`);await evaluate(cdp,`(()=>{const e=document.querySelector(${q(css)});e.value=${q(String(value))};e.dispatchEvent(new Event(${q(event)},{bubbles:true}));})()`); }
async function snapshot(name) { const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const target=path.join(runRoot,name+'.png');await fs.writeFile(target,Buffer.from(shot.data,'base64'));report.screenshots.push(target); }
function record(name) { report.checks.push(name); console.log('[FWD model] '+name); }
async function waitStored(check) { const deadline=Date.now()+15000;while(Date.now()<deadline){const data=await project.snapshot();if(check(data))return data;await new Promise(resolve=>setTimeout(resolve,80));}throw new Error('Stored state timeout'); }
try {
  await project.init({name:'3D model repair acceptance'});const {buffer}=await createModelFixture(),glbFile=path.join(runRoot,'panel.glb');await fs.writeFile(glbFile,buffer);
  const reordered = decodeGlb(buffer), alternate = structuredClone(reordered.json.animations[0]); alternate.name='Other'; alternate.channels[0].target.node=0;
  reordered.json.animations.unshift(alternate); const externalFile=path.join(runRoot,'external.glb');await fs.writeFile(externalFile,encodeGlb(reordered.json,reordered.binary));
  editor=await startEditor({projectRoot,fwePath,port:0});report.url=editor.url;
  const debugPort=await getFreePort();chrome=startChrome(editor.url,debugPort);const target=await waitForTarget(debugPort,editor.url,16000);cdp=await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown',event=>report.errors.push(event.exceptionDetails?.exception?.description||event.exceptionDetails?.text));
  for(const domain of ['Runtime','Page','DOM'])await cdp.call(domain+'.enable');await cdp.call('Emulation.setDeviceMetricsOverride',{width:1600,height:1100,deviceScaleFactor:1,mobile:false});
  await cdp.call('Page.reload',{ignoreCache:true});await wait(`document.querySelector('[data-testid="fwv-assets-model-empty"]')`);
  await wait(`!document.querySelector('[data-testid="fwv-assets-model-empty"]').matches(':disabled')`);
  await evaluate(cdp,`document.querySelector('[data-testid="fwv-assets-model-empty"]').click()`);await wait(`document.querySelector(${q(testId('file'))})`);
  assert.equal(await evaluate(cdp,`document.querySelector(${q(testId('source-canvas'))}).getBoundingClientRect().width`),0);
  assert.equal(await evaluate(cdp,`document.querySelector(${q(testId('request'))}).getBoundingClientRect().width`),0);
  record('An empty 3D workspace offers import without a blank viewport or disabled editing form');
  const tree=await cdp.call('DOM.getDocument',{depth:0}),found=await cdp.call('DOM.querySelector',{nodeId:tree.root.nodeId,selector:testId('file')});await cdp.call('DOM.setFileInputFiles',{nodeId:found.nodeId,files:[glbFile]});
  await wait(`document.querySelector(${q(testId('source-canvas'))})?.dataset.ready==='true'`);
  let data=await project.snapshot();const source=data.assets[0],sourceRevision=source.selectedRevisionId;
  assert.equal(source.kind,'model3d');assert.ok(await evaluate(cdp,`document.querySelector(${q(testId('summary'))}).textContent.includes('2')`));
  assert.equal(await evaluate(cdp,`document.querySelector(${q(testId('candidate-canvas'))}).getBoundingClientRect().width`),0);
  assert.equal(await evaluate(cdp,`document.querySelector(${q(testId('tools'))}).open`),false);
  await wait(`document.querySelector('[data-testid="fwv-model-request"]').closest('[data-fwv-role="workspace"]').dataset.fwvPhase!=='busy'`);
  await fill('asset',source.id,'change');
  await wait(`document.querySelector(${q(testId('source-canvas'))}).dataset.ready==='true' && document.querySelector('[data-testid="fwv-model-request"]').closest('[data-fwv-role="workspace"]').dataset.fwvPhase!=='busy'`);
  await reveal(testId('source-canvas'));await snapshot('model-home-1600');record('Upload GLB into a single large viewport; professional controls start closed');
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await evaluate(cdp,`document.querySelector(${q(testId('back'))}).scrollIntoView({block:'start'})`);
  report.controlMetrics = await evaluate(cdp,`['#saveButton',${q(testId('asset'))},${q(testId('animation'))},${q(testId('time'))},${q(testId('create'))},${q(testId('request'))}].map(selector=>{const el=document.querySelector(selector),s=getComputedStyle(el),r=el.getBoundingClientRect();return {selector,height:r.height,font:s.fontSize,lineHeight:s.lineHeight,top:r.top,bottom:r.bottom};})`);
  for (const metric of report.controlMetrics) { assert.equal(metric.font,'14px'); if(metric.selector!==testId('request')) assert.ok(Math.abs(metric.height-36)<1,JSON.stringify(metric)); }
  await snapshot('model-home-1280x800');record('Default 3D controls share 36px height and 14px text at the common 1280x800 viewport');
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
  await evaluate(cdp,`document.querySelector(${q(testId('back'))}).scrollIntoView({block:'start'})`);
  await evaluate(cdp,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.ok(await evaluate(cdp,`(()=>{const box=document.querySelector(${q(testId('create'))}).getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;})()`),'the primary modification action is visible beside the model at 720p');
  await snapshot('model-home-1280x720');record('At 720p the model and primary modification action are visible together');
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:1600,height:1100,deviceScaleFactor:1,mobile:false});
  await fill('request','Move tip bone 0.3 units right; preserve all other bones, texture and animation');await click('create');
  data=await waitStored(d=>d.changes?.length===1);assert.equal(data.changes[0].title,'Move tip bone 0.3 units right; preserve all other bones, texture and animation');
  await wait(`document.querySelector(${q(testId('handoff'))}).value.includes('sourceFiles')`);assert.ok(await evaluate(cdp,`document.querySelector(${q(testId('handoff'))}).value.includes('sha256')`));record('One modification input prepares a titled request with actual source paths and hashes');
  const candidateInput=await cdp.call('DOM.querySelector',{nodeId:tree.root.nodeId,selector:testId('candidate-file')});
  await cdp.call('DOM.setFileInputFiles',{nodeId:candidateInput.nodeId,files:[externalFile]});
  await waitStored(d=>d.changes[0].candidates.length===1);await wait(`document.querySelector(${q(testId('candidate-canvas'))}).dataset.ready==='true'`);
  assert.ok(await evaluate(cdp,`document.querySelector(${q(testId('candidate-canvas'))}).getBoundingClientRect().width>0`));record('Imported AI result opens two comparison viewports without replacing the original');
  await click('skeleton');await fill('animation','0','change');await fill('time','0.5','change');
  const beforeOrbit=await evaluate(cdp,`document.querySelector(${q(testId('source-canvas'))}).toDataURL()`);
  const rect=await evaluate(cdp,`(()=>{const r=document.querySelector(${q(testId('source-canvas'))}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',buttons:1,clickCount:1});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+65,y:rect.y+20,button:'left',buttons:1});
  await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+65,y:rect.y+20,button:'left',buttons:0,clickCount:1});
  await evaluate(cdp,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const views=await evaluate(cdp,`['source-canvas','candidate-canvas'].map(id=>document.querySelector('[data-testid="fwv-model-'+id+'"]').toDataURL())`);
  assert.notEqual(views[0],beforeOrbit);assert.equal(views[0],views[1]);record('A real pointer orbit synchronizes both cameras and the same named animation despite reordered external clips');
  await reveal(testId('source-canvas'));await snapshot('model-animation-and-skeleton');record('Select animation, exact time and skeleton overlay through real controls');
  await fill('bone','1','change');await fill('translation','0.3, 1, 0');await click('repairBone');data=await waitStored(d=>d.changes?.[0]?.candidates.length===2);
  const change=data.changes[0],candidate=change.candidates[1];assert.equal(data.assets.find(a=>a.id===source.id).selectedRevisionId,sourceRevision);assert.equal(candidate.review.decision,'pending');
  const content=await project.readArtifact({assetId:candidate.assetId,revisionId:candidate.revisionId,fileName:candidate.files.find(file=>file.role==='model').name});assert.deepEqual(decodeGlb(content.buffer).json.nodes[1].translation,[.3,1,0]);
  await wait(`document.querySelector(${q(testId('candidates'))}).value===${q(candidate.id)}`);await fill('animation','-1','change');await wait(`document.querySelector(${q(testId('candidate-canvas'))}).dataset.ready==='true'`);
  await reveal(testId('adopt'));await snapshot('model-bone-candidate');record('Bone edit becomes an exact pending GLB candidate with Use this version above the preview');
  await wait(`document.querySelector(${q(testId('source-canvas'))}).dataset.ready==='true'`);
  await click('readVertex');await wait(`document.querySelector(${q(testId('weights'))}).value.length>0`);await fill('weights','0.5, 0.5, 0, 0');await click('repairWeight');data=await waitStored(d=>d.changes[0].candidates.length===3);record('Inspect an actual vertex and generate a separate normalized weight candidate');
  const weightId=data.changes[0].candidates[2].id;await wait(`document.querySelector(${q(testId('candidates'))}).value===${q(weightId)}`);await fill('comment','The inspected vertex still deforms incorrectly.');await click('reject');
  await waitStored(d=>d.changes[0].candidates[2].review.decision==='rejected');await wait(`document.querySelector(${q(testId('adopt'))}).disabled`);record('Rejected results cannot be used by the primary action');
  await click('extractTexture');data=await waitStored(d=>d.assets.some(a=>a.kind==='image'));assert.equal(data.assets.filter(a=>a.kind==='image').length,1);record('Embedded texture extraction produces an image asset for the existing AI artwork workflow');
  await fill('candidates',candidate.id,'change');await click('adopt');data=await waitStored(d=>Boolean(d.changes[0].adoptedCandidateId));
  assert.equal(data.assets.find(a=>a.id===source.id).revisions.length,2);assert.equal(data.changes[0].adoptedCandidateId,candidate.id);assert.equal(data.changes[0].candidates[1].review.decision,'accepted');
  assert.notEqual(data.changes[0].candidates[1].review.comment,'The inspected vertex still deforms incorrectly.');record('One Use this version click records acceptance for this candidate, without copying another result\'s rejection note');
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:1000,height:1100,deviceScaleFactor:1,mobile:false});await reveal(testId('source-canvas'));
  await evaluate(cdp,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await evaluate(cdp,'document.documentElement.scrollWidth>innerWidth'),false);await snapshot('model-1000');record('The model workspace remains usable at 1000px without horizontal page overflow');
  await click('revise');await wait(`document.querySelector(${q(testId('request'))}).getBoundingClientRect().width>0`);await wait(`document.querySelector(${q(testId('candidate-canvas'))}).getBoundingClientRect().width===0`);
  assert.equal(await evaluate(cdp,`document.querySelector(${q(testId('revision'))}).value`),data.assets.find(a=>a.id===source.id).selectedRevisionId);record('Continue after adoption starts from the current revision in a single viewport');
  await click('back');await wait(`document.querySelector('[data-testid="fwv-assets-model-tool"]')`);await cdp.call('Page.reload',{ignoreCache:true});await wait(`document.querySelector('[data-testid="fwv-assets-model-tool"]')`);record('Return to the asset center and reopen without losing the model or adoption history');
  assert.deepEqual(report.errors,[]);report.status='passed';
} catch(error) {report.status='failed';report.error=error.stack;console.error(error.stack);if(cdp)await snapshot('failure').catch(()=>{});process.exitCode=1;}
finally {await fs.writeFile(path.join(runRoot,'report.json'),JSON.stringify(report,null,2));console.log(path.join(runRoot,'report.json'));cdp?.close();if(chrome)await stopProcess(chrome);if(editor)await editor.close();}
