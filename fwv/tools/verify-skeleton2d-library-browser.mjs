import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startEditor } from '../src/editor/server.mjs';

// Read-only visual loading audit against an already-running loopback workbench.
// FWE selection/transport changes stay in memory; this probe never saves drafts,
// creates revisions or exports. Every observed mutation request fails the audit.
const root = fileURLToPath(new URL('../', import.meta.url)), fwePath = fileURLToPath(new URL('../../fwe', import.meta.url));
const ownEditor = process.argv[2] === '--project' ? await startEditor({ projectRoot: path.resolve(process.argv[3]), fwePath, port: 0 }) : null;
const targetUrl = ownEditor?.url || process.argv[2];
if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(targetUrl || '')) throw new Error('Pass the running loopback workbench URL.');
const url = targetUrl.replace(/\/$/, '');
const require = createRequire(import.meta.url), { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test/browser-smoke.js'));
const output = path.join(root, '.local/reports/skeleton2d-library-browser'); await fs.mkdir(output, { recursive: true }); const runRoot = await fs.mkdtemp(path.join(output, 'run-'));
const snapshot = await (await fetch(url + '/api/fwv/snapshot')).json(), actors = snapshot.assets.filter(asset => asset.kind === 'skeleton2d');
const captureNames = (process.env.FWV_CAPTURE_NAMES || '').split(',').map(name => name.trim()).filter(Boolean);
const report = { status: 'running', runRoot, projectId: snapshot.id, actors: [], errors: [], mutations: [], screenshots: [], artifactRequests: 0 };
const q = JSON.stringify; let chrome, cdp;
const read = expression => evaluate(cdp, expression), wait = expression => waitForExpression(cdp, expression, 60000);
async function set(id, value) { await read(`(() => {const e=document.querySelector('[data-testid="${id}"]');e.value=${q(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function shot(index) { await read(`(() => {for(let node=document.querySelector('[data-testid="fwv-skeleton2d"]');node;node=node.parentElement)node.scrollTop=0;})()`); await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); const value = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), file = path.join(runRoot, `actor-${String(index).padStart(2, '0')}.png`); await fs.writeFile(file, Buffer.from(value.data, 'base64')); report.screenshots.push(file); }
try {
  const port = await getFreePort(); chrome = startChrome(url, port); const target = await waitForTarget(port, url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => report.errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Network.responseReceived', event => { if (event.response.status >= 400) report.errors.push(`${event.response.status} ${event.response.url}`); });
  cdp.on('Network.requestWillBeSent', event => { if (!['GET', 'HEAD'].includes(event.request.method)) report.mutations.push({ method: event.request.method, url: event.request.url }); if (event.request.url.includes('/api/fwv/artifact?')) report.artifactRequests++; });
  for (const domain of ['Runtime', 'Page', 'Network']) await cdp.call(domain + '.enable'); await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1050, deviceScaleFactor: 1, mobile: false });
  await wait(`window.fwe?.navigation && window.fwe.resources.current().domain?.id === 'fwv-catalog' && window.fwe.resources.current().data?.images && document.querySelector('#collectionSearch') && !document.querySelector('[aria-busy=true]')`);
  await read(`window.fwe.navigation.navigate({domainId:'fwv-authoring',fileName:'authoring.json',collectionId:'skeleton2dDrafts',mode:'edit'},{updateUrl:true})`);
  await wait(`window.fwe.resources.current().data?.skeleton2dDrafts?.length === ${actors.length} && document.querySelector('.collection-item[data-collection-id="skeleton2dDrafts"]')`);
  const catalogIds = await read(`window.fwe.resources.current().data.skeleton2dDrafts.map(row => row.id)`);
  assert.deepEqual([...catalogIds].sort(), actors.map(actor => actor.id).sort(), 'Native catalog must contain every registered skeleton actor');
  const artifactBaseline = report.artifactRequests;
  for (const [index, actor] of actors.entries()) {
    const loadStarted = performance.now();
    await read(`(() => {const search=document.querySelector('#collectionSearch');search.value=${q(actor.id)};search.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(`document.querySelector('.collection-item[data-collection-id="skeleton2dDrafts"][data-item-id="${actor.id}"]')`);
    await read(`document.querySelector('.collection-item[data-collection-id="skeleton2dDrafts"][data-item-id="${actor.id}"]').click()`);
    await wait(`document.querySelector('[data-testid="s2d-canvas"]')?.dataset.assetId === ${q(actor.id)}`);
    const loadMs = Math.round(performance.now() - loadStarted);
    const states = [];
    for (const animation of ['idle', 'walk', 'attack', 'stun']) {
      const exists = await read(`Array.from(document.querySelector('[data-testid="s2d-animation"]').options).some(option=>option.value===${q(animation)})`);
      if (!exists) continue;
      await set('s2d-animation', animation); await set('s2d-seek', 0.23);
      const pixels = await read(`(() => {const c=document.querySelector('[data-testid="s2d-canvas"]'),data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let count=0;for(let i=0;i<data.length;i+=4)if(Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>35&&Math.max(data[i],data[i+1],data[i+2])>90)count++;return count;})()`);
      assert.ok(pixels > 500, `${actor.name}/${animation}: expected rendered texture pixels, got ${pixels}`); states.push({ animation, time: 0.23, coloredPixels: pixels });
    }
    await set('s2d-animation', 'idle'); await set('s2d-seek', 0);
    report.actors.push({ name: actor.name, assetId: actor.id, revisionId: actor.selectedRevisionId, loadMs, states });
    if (index === 0 || index === actors.length - 1 || captureNames.some(name => actor.name.includes(name))) await shot(index);
    if ((index + 1) % 10 === 0 || index + 1 === actors.length) console.log(`[library] ${index + 1}/${actors.length} actors loaded`);
  }
  assert.equal(report.errors.length, 0, report.errors.join('\n')); assert.equal(report.mutations.length, 0, 'The read-only audit must not save any project data');
  assert.equal(await read('window.fwe.resources.current().dirty'), false, 'Playback and selection must not create unsaved edits');
  report.skeleton2dArtifactRequests = report.artifactRequests - artifactBaseline;
  assert.equal(report.skeleton2dArtifactRequests, 0, '2D textures must reuse the exact-revision bundle without one artifact request per PNG');
  const durations = report.actors.map(actor => actor.loadMs).sort((a, b) => a - b);
  report.readyTimeMs = { min: durations[0] ?? 0, median: durations[Math.floor(durations.length / 2)] ?? 0, max: durations.at(-1) ?? 0 };
  assert.equal(JSON.stringify((await (await fetch(url + '/api/fwv/snapshot')).json()).assets), JSON.stringify(snapshot.assets), 'Asset versions changed during the audit'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; console.error(error); if (cdp) try { await shot('failure'); report.pageText = await read('document.body.innerText'); } catch {} }
finally { cdp?.close(); if (chrome) await stopProcess(chrome); if (ownEditor) await ownEditor.close(); report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, report: path.join(runRoot, 'report.json') })); }
