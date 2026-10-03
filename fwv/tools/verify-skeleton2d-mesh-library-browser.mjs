import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { startEditor } from '../src/editor/server.mjs';
import { PROJECT_FILE } from '../src/core/project.mjs';
import { AUTHORING_STORAGE_FILE } from '../src/editor/authoring.mjs';
import { sampleSkeleton2d } from '../src/skeleton2d/sample.mjs';

// Actual FWE selection + professional Canvas evidence. It never edits a draft,
// asset or pixel source. Mutation API requests are blocked before transmission.
const args = process.argv.slice(2), options = {};
if (args.includes('--help')) {
  console.log('node tools/verify-skeleton2d-mesh-library-browser.mjs --project <absolute-project> [--url http://127.0.0.1:54683/] [--expected 55] [--output <evidence-directory>]');
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  if (!['--project', '--url', '--expected', '--output'].includes(args[i]) || !args[i + 1]) throw new Error(`Unknown/incomplete option ${args[i]}`);
  options[args[i].slice(2)] = args[i + 1];
}
if (!path.isAbsolute(options.project ?? '')) throw new Error('An explicit absolute --project is required.');
const expected = Number(options.expected ?? 55);
if (!Number.isInteger(expected) || expected < 1 || expected > 200) throw new Error('--expected must be 1..200.');
if (options.url && !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(options.url)) throw new Error('--url must be a loopback workbench origin.');
const root = fileURLToPath(new URL('../', import.meta.url)), fwePath = fileURLToPath(new URL('../../fwe', import.meta.url));
const require = createRequire(import.meta.url), { startChrome, stopProcess, getFreePort, waitForTarget, connectCdp, evaluate, waitForExpression } = require(path.join(fwePath, 'test/browser-smoke.js'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), q = JSON.stringify;
async function fileIdentity(file) { try { const bytes = await fs.readFile(file); return { exists: true, bytes: bytes.length, sha256: sha(bytes) }; } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; } }
const manifestFile = path.join(options.project, PROJECT_FILE), draftFile = path.join(options.project, '.fwv', AUTHORING_STORAGE_FILE);
const before = { manifest: await fileIdentity(manifestFile), drafts: await fileIdentity(draftFile) };
assert.equal(before.manifest.exists, true, 'The selected library must already exist');
const localManifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
const parent = path.resolve(options.output || path.join(root, '.local/reports/skeleton2d-mesh-library-browser'));
await fs.mkdir(parent, { recursive: true }); const runRoot = await fs.mkdtemp(path.join(parent, 'run-'));
const report = { status: 'running', startedAt: new Date().toISOString(), runRoot, projectRoot: options.project, before, expected, actors: [], errors: [], mutations: [], requests: { bundles: 0, artifacts: 0 }, screenshots: [], contacts: [], overviewSheets: [] };
const clips = ['idle', 'walk', 'attack', 'hit', 'death'], fractions = [0, 0.25, 0.5, 0.75];
const requestReferences = new Map(), pending = new Set();
let ownEditor, chrome, cdp, url, stage = 'setup';
const read = expression => evaluate(cdp, expression), wait = expression => waitForExpression(cdp, expression, 60000);
async function set(id, value) { await read(`(() => {const element=document.querySelector('[data-testid="${id}"]');if(!element)throw new Error('Missing control ${id}');element.value=${q(String(value))};element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function settled() { await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function readDocument(key) {
  await wait(`window.__meshLibraryAudit.documents.has(${q(key)})`);
  return read(`(() => {const documents=window.__meshLibraryAudit.documents,document=documents.get(${q(key)});documents.delete(${q(key)});return document;})()`);
}
async function captureFrame() {
  const result = await read(`(() => {const canvas=document.querySelector('[data-testid="s2d-canvas"]'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let colored=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])>35&&Math.max(pixels[i],pixels[i+1],pixels[i+2])>90)colored++;return {png:canvas.toDataURL('image/png').split(',')[1],coloredPixels:colored,width:canvas.width,height:canvas.height,assetId:canvas.dataset.assetId,revisionId:canvas.dataset.revisionId,animation:canvas.dataset.animation,time:Number(canvas.dataset.time),dirty:window.fwe.resources.current().dirty,error:document.querySelector('[data-testid="s2d-status"]').dataset.error==='true'};})()`);
  const buffer = Buffer.from(result.png, 'base64'); delete result.png; return { ...result, sha256: sha(buffer), buffer };
}
const escape = text => String(text).replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character]));
function label(text, width, height, fontSize = 16, background = '#edf0f5') {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${background}"/><text x="10" y="${Math.round(height * 0.65)}" font-family="Arial,Microsoft YaHei,sans-serif" font-size="${fontSize}" fill="#172537">${escape(text)}</text></svg>`);
}
async function contact(file, title, rows, cellWidth = 250, cellHeight = 245) {
  const width = cellWidth * 4, rowTitle = 28, height = 42 + rows.length * (rowTitle + cellHeight), layers = [{ input: label(title, width, 42, 20), top: 0, left: 0 }];
  for (const [index, row] of rows.entries()) {
    const top = 42 + index * (rowTitle + cellHeight);
    layers.push({ input: label(row.title, width, rowTitle), top, left: 0 });
    for (const [column, frame] of row.frames.entries()) {
      layers.push({ input: await sharp(frame.buffer).resize(cellWidth, cellHeight - 24, { fit: 'contain', background: '#181e2b' }).png().toBuffer(), top: top + rowTitle, left: column * cellWidth });
      layers.push({ input: label(`${frame.time.toFixed(3)} s`, cellWidth, 24, 13), top: top + rowTitle + cellHeight - 24, left: column * cellWidth });
    }
  }
  await sharp({ create: { width, height, channels: 4, background: '#edf0f5' } }).composite(layers).png().toFile(file);
}
function motionMetrics(samples) {
  const localPoints = sample => sample.slots.filter(slot => slot.type === 'mesh').flatMap(slot => {
    const [a, b, c, d, x, y] = sample.bones.find(bone => bone.name === slot.bone).matrix, determinant = a * d - b * c;
    return slot.vertices.map(point => Math.abs(determinant) < 1e-12 ? null : ({ x: (d * (point.x - x) - c * (point.y - y)) / determinant, y: (a * (point.y - y) - b * (point.x - x)) / determinant }));
  });
  const base = localPoints(samples[0]); let maxLocalDeformation = 0; const changed = new Set();
  for (const sample of samples.slice(1)) localPoints(sample).forEach((point, index) => { if (!point || !base[index]) return; const distance = Math.hypot(point.x - base[index].x, point.y - base[index].y); maxLocalDeformation = Math.max(maxLocalDeformation, distance); if (distance > 0.01) changed.add(index); });
  return { maxLocalDeformation, verticesChangingRelativeToSlotBone: changed.size };
}
async function screenshot(name) {
  await read(`(() => {for(let node=document.querySelector('[data-testid="fwv-skeleton2d"]');node;node=node.parentElement)node.scrollTop=0;})()`); await settled();
  const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), file = path.join(runRoot, `${name}.png`);
  await fs.writeFile(file, Buffer.from(result.data, 'base64')); report.screenshots.push(file);
}
try {
  ownEditor = options.url ? null : await startEditor({ projectRoot: options.project, fwePath, port: 0 }); url = (ownEditor?.url || options.url).replace(/\/$/, '');
  const response = await fetch(url + '/api/fwv/snapshot'); assert.equal(response.status, 200); const snapshot = await response.json();
  assert.equal(snapshot.id, localManifest.id, 'The running editor must be bound to the explicitly selected real library'); report.projectId = snapshot.id; report.url = url;
  const actors = snapshot.assets.filter(asset => asset.kind === 'skeleton2d'); assert.equal(actors.length, expected);
  const port = await getFreePort(); chrome = startChrome(url, port); const target = await waitForTarget(port, url, 16000); cdp = await connectCdp(target.webSocketDebuggerUrl);
  // A lost CDP response must fail with the current actor/call, not hang forever.
  const call = cdp.call.bind(cdp);
  cdp.call = (method, params) => {
    let timer;
    return Promise.race([call(method, params), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CDP ${method} stalled at ${stage}: ${String(params?.expression ?? '').slice(0, 180)}`)), 30000);
    })]).finally(() => clearTimeout(timer));
  };
  cdp.on('Runtime.exceptionThrown', event => report.errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') report.errors.push(event.args.map(item => item.value ?? item.description).join(' ')); });
  cdp.on('Network.responseReceived', event => {
    if (event.response.status >= 400) report.errors.push(`${event.response.status} ${event.response.url}`);
    const parsed = new URL(event.response.url);
    if (parsed.pathname === '/api/fwv/skeleton2d') requestReferences.set(event.requestId, `${parsed.searchParams.get('assetId')}/${parsed.searchParams.get('revisionId')}`);
  });
  cdp.on('Network.loadingFinished', event => {
    const key = requestReferences.get(event.requestId); if (!key) return; requestReferences.delete(event.requestId);
    report.requests.bundles++;
  });
  cdp.on('Network.requestWillBeSent', event => { if (event.request.url.includes('/api/fwv/artifact?')) report.requests.artifacts++; });
  cdp.on('Fetch.requestPaused', event => {
    const mutation = !['GET', 'HEAD'].includes(event.request.method);
    if (mutation) report.mutations.push({ method: event.request.method, url: event.request.url });
    const promise = cdp.call(mutation ? 'Fetch.failRequest' : 'Fetch.continueRequest', mutation ? { requestId: event.requestId, errorReason: 'BlockedByClient' } : { requestId: event.requestId }).catch(error => report.errors.push(error.stack)).finally(() => pending.delete(promise)); pending.add(promise);
  });
  for (const domain of ['Runtime', 'Page']) await cdp.call(domain + '.enable');
  await cdp.call('Network.enable', { maxTotalBufferSize: 128 * 1024 * 1024, maxResourceBufferSize: 64 * 1024 * 1024 });
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: url + '/api/*', requestStage: 'Request' }] });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await wait(`window.fwe?.navigation && window.fwe.resources.current().data?.images && document.querySelector('#collectionSearch') && !document.querySelector('[aria-busy=true]')`);
  // Observe the same response used by the panel, without a second HTTP read or
  // copying all embedded PNGs back through the debugging WebSocket.
  await read(`(() => {const original=window.fetch.bind(window);window.__meshLibraryAudit={documents:new Map(),errors:[]};window.fetch=async(...args)=>{const response=await original(...args),url=new URL(response.url,location.href);if(url.pathname==='/api/fwv/skeleton2d')response.clone().json().then(bundle=>{if(!bundle.document)throw new Error('Missing document in observed bundle');window.__meshLibraryAudit.documents.set(url.searchParams.get('assetId')+'/'+url.searchParams.get('revisionId'),bundle.document);}).catch(error=>window.__meshLibraryAudit.errors.push(String(error)));return response;};})()`);
  await read(`window.fwe.navigation.navigate({domainId:'fwv-authoring',fileName:'authoring.json',collectionId:'skeleton2dDrafts',mode:'edit'},{updateUrl:true})`);
  await wait(`window.fwe.resources.current().data?.skeleton2dDrafts?.length === ${actors.length} && document.querySelector('.collection-item[data-collection-id="skeleton2dDrafts"]')`);
  const nativeRows = await read('window.fwe.resources.current().data.skeleton2dDrafts.map(row=>({id:row.id,revisionId:row.data.revisionId,hasDocument:Boolean(row.data.document)}))');
  assert.deepEqual(nativeRows.map(row => row.id).sort(), actors.map(actor => actor.id).sort());
  for (const actor of actors) assert.equal(nativeRows.find(row => row.id === actor.id).revisionId, actor.selectedRevisionId, `A stored draft overrides the selected revision of ${actor.name}; review it before this audit`);
  let overview = [], group = 0;
  for (const [index, actor] of actors.entries()) {
    stage = actor.name; const started = performance.now();
    await read(`(() => {const search=document.querySelector('#collectionSearch');search.value=${q(actor.id)};search.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(`document.querySelector('.collection-item[data-collection-id="skeleton2dDrafts"][data-item-id="${actor.id}"]')`);
    await read(`document.querySelector('.collection-item[data-collection-id="skeleton2dDrafts"][data-item-id="${actor.id}"]').click()`);
    await wait(`document.querySelector('[data-testid="s2d-canvas"]')?.dataset.assetId === ${q(actor.id)} && document.querySelector('[data-testid="s2d-canvas"]').dataset.revisionId === ${q(actor.selectedRevisionId)} && document.querySelector('[data-testid="fwv-skeleton2d"]').inert === false`);
    const document = await readDocument(`${actor.id}/${actor.selectedRevisionId}`), skin = document.skins[0].name;
    const meshes = Object.values(document.skins[0].attachments).flatMap(items => Object.values(items)).filter(item => item.type === 'mesh');
    assert.ok(meshes.length > 0, `${actor.name}: selected revision is not a weighted mesh revision`);
    await read(`(() => {const checkbox=document.querySelector('[data-testid="s2d-show-bones"]');if(checkbox.checked)checkbox.click();})()`);
    const record = { name: actor.name, assetId: actor.id, revisionId: actor.selectedRevisionId, sourceActorId: document.metadata?.actor?.actorId, skin, bones: document.bones.length, meshAttachments: meshes.length, meshVertices: meshes.reduce((sum, mesh) => sum + mesh.uvs.length / 2, 0), loadMs: Math.round(performance.now() - started), motions: [] };
    const rows = [];
    for (const animation of clips) {
      stage = `${actor.name}/${animation}`;
      assert.equal(await read(`Array.from(document.querySelector('[data-testid="s2d-animation"]').options).some(option=>option.value===${q(animation)})`), true, `Missing semantic animation ${stage}`);
      const clip = document.skinAnimations?.[skin]?.[animation] ?? animation, duration = document.animationDurations[clip];
      await set('s2d-animation', animation); const frames = [], samples = [];
      for (const fraction of fractions) {
        const time = duration * fraction; await set('s2d-seek', time); await settled(); const frame = await captureFrame();
        assert.equal(frame.assetId, actor.id); assert.equal(frame.revisionId, actor.selectedRevisionId); assert.equal(frame.animation, animation);
        assert.equal(frame.dirty, false, `${stage} became dirty`); assert.equal(frame.error, false, `${stage} reported a renderer error`);
        assert.ok(Math.abs(frame.time - time) <= 0.00051, `${stage}: seek mismatch`); assert.ok(frame.coloredPixels > 500, `${stage}: missing visible pixels (${frame.coloredPixels})`);
        frames.push(frame); samples.push(sampleSkeleton2d(document, { skin, animation, time, loop: false }));
      }
      const distinctFrames = new Set(frames.map(frame => frame.sha256)).size; assert.ok(distinctFrames > 1, `${stage}: all four real Canvas frames are identical`);
      record.motions.push({ animation, clip, duration, distinctFrames, ...motionMetrics(samples), frames: frames.map(({ buffer, ...frame }) => frame) });
      rows.push({ title: `${animation} → ${clip}`, frames });
    }
    // Confirm requestAnimationFrame playback as well as deterministic scrubbing.
    await set('s2d-animation', 'walk'); await set('s2d-seek', 0); await read(`document.querySelector('[data-testid="s2d-play"]').click()`);
    await wait(`Number(document.querySelector('[data-testid="s2d-canvas"]').dataset.time)>0.04`); await read(`document.querySelector('[data-testid="s2d-play"]').click()`);
    record.playbackAdvanced = true;
    const file = path.join(runRoot, `actor-${String(index + 1).padStart(2, '0')}-${actor.id}.png`);
    await contact(file, `${actor.name} · ${record.bones} bones · ${record.meshAttachments} meshes`, rows); record.contact = file; report.contacts.push(file); report.actors.push(record);
    overview.push({ title: `${index + 1}. ${actor.name}`, frames: rows.find(row => row.title.startsWith('attack ')).frames });
    if (overview.length === 7 || index + 1 === actors.length) {
      const sheet = path.join(runRoot, `overview-${String(++group).padStart(2, '0')}-attack.png`); await contact(sheet, `Attack motion · group ${group}`, overview, 260, 240); report.overviewSheets.push(sheet); overview = [];
    }
    if (index === 0 || index === actors.length - 1 || record.sourceActorId === 'unit-farmer') await screenshot(`workspace-${index + 1}`);
    assert.equal(await read('window.fwe.resources.current().dirty'), false);
    await fs.writeFile(path.join(runRoot, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
    if ((index + 1) % 5 === 0 || index + 1 === actors.length) console.log(`[mesh-library] ${index + 1}/${actors.length} · ${(index + 1) * 20} Canvas frames captured`);
  }
  await Promise.all([...pending]);
  report.errors.push(...await read('window.__meshLibraryAudit.errors'));
  assert.equal(report.errors.length, 0, report.errors.join('\n')); assert.equal(report.mutations.length, 0, 'Mutation request attempted during read-only audit'); assert.equal(report.requests.artifacts, 0);
  assert.equal(JSON.stringify((await (await fetch(url + '/api/fwv/snapshot')).json()).assets), JSON.stringify(snapshot.assets), 'Asset identities changed during the audit');
  const times = report.actors.map(actor => actor.loadMs).sort((a, b) => a - b);
  report.readyTimeMs = { min: times[0], median: times[Math.floor(times.length / 2)], max: times.at(-1) }; report.frames = report.actors.length * clips.length * fractions.length;
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.stage = stage; report.error = error.stack; process.exitCode = 1; console.error(error); if (cdp) try { await screenshot('failure'); report.pageText = await read('document.body.innerText'); } catch {} }
finally {
  cdp?.close(); if (chrome) await stopProcess(chrome); if (ownEditor) await ownEditor.close();
  report.after = { manifest: await fileIdentity(manifestFile), drafts: await fileIdentity(draftFile) };
  if (JSON.stringify(report.after) !== JSON.stringify(before)) { report.status = 'failed'; report.errors.push('Library manifest or draft bytes changed during the read-only audit.'); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, actors: report.actors.length, frames: report.frames, report: path.join(runRoot, 'report.json'), overviewSheets: report.overviewSheets }));
}
