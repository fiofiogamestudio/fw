import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readProject, initProject, updateProject } from '../src/core/project.mjs';
import { startEditor } from '../src/editor/server.mjs';
import { MAX_BODY_BYTES } from '../src/editor/api.mjs';
import { launchEditor, parseStartOptions } from '../tools/start-editor.mjs';

const fwePath = fileURLToPath(new URL('../../fwe', import.meta.url));
async function projectAt(root) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Editor Fixture"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  return initProject(root, { name: 'Editor Fixture' });
}
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwb-editor-'));
  await projectAt(root);
  const services = { readProject, updateProject, environmentFile: path.join(root, '.local/test-environment.json'), listArtifacts: () => [],
    readArtifact: (root, id) => ({ schemaVersion: 1, id, outputs: [] }), readArtifactLog: () => 'fixture build log',
    doctor: async (project, options) => ({ ok: true, root: project.root, ...options, checks: [{ id: 'fixture', status: 'passed', message: 'checked' }] }),
    buildProject: async (root, options) => ({ id: 'build_fixture123', status: 'built', ...options }),
    validateArtifact: async (root, id) => ({ ok: true, artifactId: id, scope: 'package', runtimeStatus: 'not-tested' }),
    planUpload: async (root, id, options) => ({ ok: true, artifactId: id, ...options, canExecute: false, status: 'handoff', handoff: 'Use the platform console.', checks: [] }),
    startPreview: async () => ({ url: 'http://127.0.0.1:1234', close: async () => {} }), ...overrides };
  const editor = await startEditor({ projectRoot: root, fwePath, port: 0, services });
  t.after(async () => { await editor.close(); await fs.rm(root, { recursive: true, force: true }); });
  const session = await fetch(`${editor.url}/api/fwb/session`).then(response => response.json());
  const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWB-CSRF': session.csrfToken };
  const post = (type, payload, changes = {}) => fetch(`${editor.url}/api/fwb/commands`, { method: 'POST', headers: { ...headers, ...changes }, body: JSON.stringify({ type, payload }) });
  const waitJob = async job => {
    for (let i = 0; i < 100; i++) {
      const value = await fetch(`${editor.url}/api/fwb/job?id=${job.id}`).then(response => response.json());
      if (value.status !== 'running') return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Fixture job did not finish.');
  };
  return { root, editor, session, headers, post, waitJob };
}

test('real FWE shell mounts FWB extension and only fixed project resources', async t => {
  const { editor, session } = await fixture(t);
  assert.equal(session.protocol, 'fwb-workbench-v1');
  const html = await fetch(editor.url).then(response => response.text()); assert.match(html, /documentTree/);
  const app = await fetch(`${editor.url}/api/app`).then(response => response.json());
  assert.equal(app.id, 'fwb-workbench'); assert.equal(app.domains[0].workbench.layout, 'fwb-workbench');
  assert.equal(app.domains[0].workbench.default.collection, 'platforms');
  for (const extension of app.extensions) assert.equal((await fetch(editor.url + extension.url)).status, 200);
  const resource = await fetch(`${editor.url}/api/domains/fwb-project/files/fwb.project.json`).then(response => response.json());
  assert.equal(resource.data.platforms.length, 7);
  assert.deepEqual(resource.data.platforms.filter(item => item.target.startsWith('taptap-')).map(item => [item.target, item.label]), [['taptap-h5', 'TapTap（App 内即玩）']]);
  const snapshot = await fetch(`${editor.url}/api/fwb/snapshot`).then(response => response.json());
  assert.equal(snapshot.publication.status, 'development-only'); assert.equal(snapshot.platforms.length, 7);
  assert.deepEqual(snapshot.platforms.filter(item => item.target.startsWith('taptap-')).map(item => item.target), ['taptap-h5']);
  for (const route of ['/api/domains/fwb-project/files/package.json', '/api/fwb/artifact?id=..%2Fsecret', '/api/fwb/snapshot?project=C%3A%5CWindows']) {
    assert.ok([400, 404].includes((await fetch(editor.url + route)).status), route);
  }
});

test('retained disabled TapTap legacy settings do not restore editor doctor or build actions', async t => {
  let calls = 0;
  const { editor, post } = await fixture(t, {
    readProject: root => {
      const project = readProject(root);
      project.config.targets['taptap-minigame'] = { enabled: false, preset: 'Legacy TapTap' };
      return project;
    },
    doctor: async () => { calls++; }, buildProject: async () => { calls++; },
  });
  for (const type of ['doctor', 'build']) {
    assert.equal((await post(type, { target: 'taptap-minigame', profile: 'debug' })).status, 400);
  }
  const snapshot = await fetch(`${editor.url}/api/fwb/snapshot`).then(response => response.json());
  assert.equal(snapshot.platforms.some(item => item.target === 'taptap-minigame'), false);
  assert.equal(snapshot.jobs.length, 0);
  assert.equal(calls, 0);
});

test('origin, host, CSRF, generic writes and unexpected fields are rejected', async t => {
  const { editor, post, headers } = await fixture(t);
  for (const overrides of [{ Origin: 'https://attacker.invalid' }, { Origin: '' }, { 'X-FWB-CSRF': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await post('build', { target: 'web', profile: 'debug' }, overrides)).status, 403);
  }
  assert.equal((await post('build', { target: 'web', profile: 'debug' }, { 'Content-Type': 'text/plain' })).status, 415);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(`${editor.url}/api/fwb/session`, { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  for (const [route, method] of [['/api/app/stop', 'POST'], ['/api/domains/fwb-project/files/fwb.project.json', 'PUT']]) {
    assert.equal((await fetch(editor.url + route, { method, headers, body: '{}' })).status, 405);
  }
  assert.equal((await post('build', { target: 'web', profile: 'debug', command: 'arbitrary' })).status, 400);
  assert.equal((await post('upload', { artifactId: 'build_fixture123' })).status, 400);
});

test('builds run asynchronously, reject duplicate jobs and preserve failure artifact and log', async t => {
  let finish, calls = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const { post, waitJob, editor } = await fixture(t, { buildProject: async () => { calls++; await gate; throw Object.assign(new Error('Export failed'), { artifactId: 'build_fixture123' }); } });
  const response = await post('build', { target: 'web', profile: 'debug' }); assert.equal(response.status, 202);
  const { job } = await response.json(); assert.equal(job.status, 'running');
  assert.equal((await post('build', { target: 'web', profile: 'debug' })).status, 409);
  assert.equal(calls, 1); finish();
  const completed = await waitJob(job); assert.equal(completed.status, 'failed'); assert.equal(completed.artifactId, 'build_fixture123');
  const artifact = await fetch(`${editor.url}/api/fwb/artifact?id=build_fixture123`).then(response => response.json());
  assert.equal(artifact.logText, 'fixture build log');
  const next = await post('doctor', { target: 'web', profile: 'debug' }); assert.equal(next.status, 202);
  assert.equal((await waitJob((await next.json()).job)).result.ok, true);
});

test('configuration edits retain trusted tool paths and use optimistic revisions', async t => {
  const { root, editor, post, waitJob } = await fixture(t);
  const original = await fetch(`${editor.url}/api/fwb/config`).then(response => response.json());
  const injected = structuredClone(original); injected.config.godot.executable = 'untrusted-command';
  assert.equal((await post('config.save', injected)).status, 400);
  const allowed = structuredClone(original); allowed.config.version = '0.2.0'; allowed.config.targets.web.maxBytes = 1000000;
  const response = await post('config.save', allowed); assert.equal(response.status, 202);
  assert.equal((await waitJob((await response.json()).job)).status, 'completed');
  assert.equal(readProject(root).config.version, '0.2.0');
  assert.equal((await post('config.save', original)).status, 409);
  const before = readProject(root); updateProject(root, { ...before.config, name: 'External edit' }, before.revision);
  assert.equal((await fetch(`${editor.url}/api/fwb/snapshot`)).status, 409);
});

test('oversized commands are rejected before buffering body', async t => {
  const { editor, headers } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${editor.url}/api/fwb/commands`, { method: 'POST', headers: { ...headers, 'Content-Length': MAX_BODY_BYTES + 1 } }, res => {
      res.resume(); res.on('end', () => { resolve(res.statusCode); req.destroy(); });
    }); req.on('error', reject); req.write('{}');
  });
  assert.equal(status, 413);
});

test('upload conditions use the fixed development channel without exposing upload execution', async t => {
  let seen;
  const { root, post, waitJob } = await fixture(t, { planUpload: async (...args) => {
    seen = args; return { ok: false, canExecute: false, status: 'blocked', checks: [{ id: 'credentials', status: 'fail', message: 'Missing credentials' }] };
  } });
  const response = await post('upload-plan', { artifactId: 'build_fixture123' }); assert.equal(response.status, 202);
  const completed = await waitJob((await response.json()).job);
  assert.equal(completed.status, 'completed'); assert.equal(completed.result.status, 'blocked');
  assert.deepEqual(seen, [root, 'build_fixture123', { channel: 'development' }]);
  assert.equal((await post('upload-plan', { artifactId: 'build_fixture123', channel: 'production' })).status, 400);
  assert.equal((await post('upload', { artifactId: 'build_fixture123' })).status, 400);
});

test('default launcher check is read-only and launch preserves the demo source', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwb-launch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'examples/demo'); await projectAt(source);
  const options = parseStartOptions(['--fwe-path', fwePath, '--no-open', '--check'], { packageRoot: root });
  const result = await launchEditor(options); assert.equal(result.inspection.createDemoOnStart, true);
  await assert.rejects(fs.stat(path.join(root, '.local')), { code: 'ENOENT' });
  const launched = await launchEditor({ ...options, check: false });
  try {
    assert.equal(readProject(path.join(root, '.local/demo')).config.name, 'Editor Fixture');
    assert.equal(readProject(source).config.name, 'Editor Fixture');
    await fs.writeFile(path.join(root, '.local/demo/retained.txt'), 'retained');
  } finally { await launched.editor.close(); }
  const checkAgain = await launchEditor(options); assert.equal(checkAgain.inspection.createDemoOnStart, false);
  assert.equal(await fs.readFile(path.join(root, '.local/demo/retained.txt'), 'utf8'), 'retained');
});

test('structured settings save tool paths and disabled targets cannot start builds',async t=>{
 const {editor,post,waitJob,root}=await fixture(t);const config=await fetch(editor.url+'/api/fwb/config').then(r=>r.json());config.config.godot.executable=path.join(root,'Godot.exe');config.config.targets.web.enabled=false;
 const response=await post('settings.save',config);assert.equal(response.status,202);assert.equal((await waitJob((await response.json()).job)).status,'completed');assert.equal(readProject(root).config.godot.executable,path.join(root,'Godot.exe'));
 const snapshot=await fetch(editor.url+'/api/fwb/snapshot').then(r=>r.json());assert.equal(snapshot.platforms.find(x=>x.target==='web').enabled,false);assert.equal((await post('build',{target:'web',profile:'debug'})).status,400);
 assert.equal((await post('settings.save',config)).status,409);
});
test('environment save invalidates diagnostics and stale machine revisions are rejected',async t=>{
 const {editor,post,waitJob,root}=await fixture(t);const report=await post('doctor',{target:'web',profile:'debug'});await waitJob((await report.json()).job);
 const before=await fetch(editor.url+'/api/fwb/snapshot').then(r=>r.json());const machine=await fetch(editor.url+'/api/fwb/environment').then(r=>r.json());const payload={config:{...machine.config,android:{javaHome:path.join(root,'jdk')}},revision:machine.revision};
 const saved=await post('environment.save',payload);await waitJob((await saved.json()).job);const after=await fetch(editor.url+'/api/fwb/snapshot').then(r=>r.json());assert(after.generation>before.generation);assert.notEqual(after.environmentRevision,before.environmentRevision);
 const stale=await post('environment.save',payload);assert.equal((await waitJob((await stale.json()).job)).status,'failed');
});
test('project import switches the active root and does not overwrite an existing game',async t=>{
 const {editor,post,waitJob,root}=await fixture(t);const destination=path.join(root,'second');await fs.mkdir(destination);const game='[application]\nconfig/name="Second"\n';await fs.writeFile(path.join(destination,'project.godot'),game);
 const opened=await post('project.open',{path:destination,initialize:true});assert.equal((await waitJob((await opened.json()).job)).status,'completed');const snapshot=await fetch(editor.url+'/api/fwb/snapshot').then(r=>r.json());assert.equal(snapshot.project.root,destination);assert.equal(await fs.readFile(path.join(destination,'project.godot'),'utf8'),game);assert.deepEqual(readProject(destination).config.godot,{});assert(snapshot.recentProjects.includes(destination));
 const config=await fetch(editor.url+'/api/fwb/config').then(r=>r.json());assert.equal(config.config.name,'second');
});
test('active build streams output and cancellation reaches the build process',async t=>{
 const {editor,post,waitJob}=await fixture(t,{buildProject:async(root,options)=>{options.onEvent({phase:'export',artifactId:'build_fixture123',message:'start'});options.onOutput('live-output');await new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('Build cancelled.')),{once:true});});}});
 const started=await post('build',{target:'web',profile:'debug'});const job=(await started.json()).job;const snapshot=await fetch(editor.url+'/api/fwb/snapshot').then(r=>r.json());assert.match(snapshot.jobs[0].output,/live-output/);assert.equal(snapshot.jobs[0].phase,'export');assert.equal((await post('build.cancel',{jobId:job.id})).status,202);const finished=await waitJob(job);assert.equal(finished.status,'failed');assert.match(finished.error,/cancelled/);
});

test('reviewed upload revision and fingerprint must still match before execution',async t=>{
 let calls=0;const {editor,post,waitJob}=await fixture(t,{planUpload:async()=>({canExecute:true,outputsSha256:'reviewed-hash'}),uploadArtifact:async()=>{calls++;return {status:'uploaded'};}});
 const original=await fetch(editor.url+'/api/fwb/config').then(r=>r.json());const base={artifactId:'build_fixture123',revision:original.revision,outputsSha256:'reviewed-hash',confirmed:true};
 assert.equal((await post('upload.execute',{...base,confirmed:false})).status,400);
 for(const payload of [{...base,revision:'stale'},{...base,outputsSha256:'changed'}]){const started=await post('upload.execute',payload);assert.equal((await waitJob((await started.json()).job)).status,'failed');}
 assert.equal(calls,0);const started=await post('upload.execute',base);assert.equal((await waitJob((await started.json()).job)).result.status,'uploaded');assert.equal(calls,1);
});
test('batch build runs sequentially and skips blocked platforms without creating artifacts',async t=>{
 let executing=0,peak=0;const order=[];const {post,waitJob}=await fixture(t,{doctor:async(project,{target})=>({ok:target!=='wechat-minigame',checks:target==='wechat-minigame'?[{status:'fail',message:'SDK missing'}]:[]}),buildProject:async(root,{target})=>{executing++;peak=Math.max(peak,executing);order.push(target);await new Promise(resolve=>setTimeout(resolve,5));executing--;return {id:'build_'+target};}});
 const started=await post('build.batch',{targets:['web','wechat-minigame','poki'],profile:'release'});const job=await waitJob((await started.json()).job);assert.equal(job.status,'completed');assert.equal(peak,1);assert.deepEqual(order,['web','poki']);assert.deepEqual(job.result.entries.map(entry=>entry.status),['built','blocked','built']);assert.equal(job.result.ok,false);
});
