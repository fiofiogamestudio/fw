import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublisher, listReleases, outputsFingerprint, recordUploadReceipt } from '../src/core/publish.mjs';
import { fileDigest, atomicJson } from '../src/core/files.mjs';

const specifications = {
  'wechat-ci': { target: 'wechat-minigame', name: 'miniprogram-ci', version: '2.1.31', entry: 'bin/miniprogram-ci.js', bin: 'miniprogram-ci', applicationId: 'wx1234567890abcdef' },
  'douyin-cli': { target: 'douyin-minigame', name: 'tt-minigame-ide-cli', version: '2.1.1', entry: 'bin/tmg.js', bin: 'tmg', applicationId: 'tt1234567890abcdef' },
  'poki-cli': { target: 'poki', name: '@poki/cli', version: '0.1.19', entry: 'bin/index.js', bin: 'poki', applicationId: '01234567-89ab-cdef-0123-456789abcdef' },
};
const id = 'build_1750000000000_platform_fixture';
const remoteId = '12345678-abcd-ef01-2345-6789abcdef01';
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

function fixture(t, providerId = 'wechat-ci') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = specifications[providerId];
  const homeDirectory = path.join(root, 'test-home');
  const packagePath = path.join(root, 'tools', spec.name);
  write(path.join(packagePath, spec.entry), '// Unit test placeholder; never executed.');
  atomicJson(path.join(packagePath, 'package.json'), { name: spec.name, version: spec.version, bin: { [spec.bin]: spec.entry } });
  write(path.join(root, 'project.godot'), '[application]\nconfig/name="Upload fixture"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  const directory = path.join(root, '.local', 'fwb', 'artifacts', id);
  const out = path.join(directory, 'out');
  const files = spec.target === 'poki' ? {
    'index.html': '<script src="https://game-cdn.poki.com/scripts/v2/poki-sdk.js"></script>', 'index.js': '/* fixture */', 'index.wasm': Buffer.from([0, 97, 115, 109]), 'index.pck': 'fixture',
  } : { 'game.js': '/* fixture */', 'game.json': '{}', 'project.config.json': JSON.stringify({ appid: spec.applicationId, compileType: 'game', miniprogramRoot: './' }) };
  for (const [file, data] of Object.entries(files)) write(path.join(out, file), data);
  const artifact = { schemaVersion: 1, id, status: 'built', target: spec.target, version: '1.2.3', buildNumber: 7, profile: 'release',
    outputs: Object.keys(files).map((file) => ({ path: `out/${file}`, size: fs.statSync(path.join(out, file)).size, sha256: fileDigest(path.join(out, file)) })),
    validation: { package: 'passed', runtime: 'not-tested', platform: 'not-tested' } };
  atomicJson(path.join(directory, 'manifest.json'), artifact);
  write(path.join(root, 'acceptance.md'), 'Unit test fixture: external device validation is simulated, not performed.');
  const upload = { provider: providerId, packagePath, toolVersion: spec.version, applicationId: spec.applicationId,
    acceptance: { artifactId: id, outputsSha256: outputsFingerprint(artifact), runtime: 'passed', platform: 'passed', evidence: 'acceptance.md' } };
  const env = {};
  if (providerId === 'wechat-ci') {
    upload.privateKeyPathEnv = 'FWB_TEST_KEY_PATH';
    env.FWB_TEST_KEY_PATH = path.join(root, 'private-key.fixture');
    write(env.FWB_TEST_KEY_PATH, 'PRIVATE_KEY_VALUE_NOT_FOR_OUTPUT');
  } else if (providerId === 'douyin-cli') write(path.join(homeDirectory, '.tmg-cli', '.cookies'), 'PRIVATE_SESSION_NOT_FOR_OUTPUT');
  else write(path.join(homeDirectory, '.config', 'poki', 'auth.json'), '{"access_token":"PRIVATE_SESSION_NOT_FOR_OUTPUT"}');
  const config = { schemaVersion: 1, name: 'Upload fixture', version: '1.2.3', buildNumber: 7, godot: { executable: 'godot', version: '4.6.2' }, targets: { [spec.target]: { enabled: true, preset: 'Fixture', upload } }, profiles: { release: { release: true } } };
  const save = () => atomicJson(path.join(root, 'fwb.project.json'), config);
  save();
  return { root, directory, artifact, config, upload, env, homeDirectory, out, save, spec };
}

test('upload defaults to a reviewable plan with no process execution or release record', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const publish = createPublisher({ env: f.env, homeDirectory: f.homeDirectory, run: async () => { calls++; throw new Error('must not execute'); } });
  const plan = await publish.uploadArtifact(f.root, id);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.checks));
  assert.equal(plan.canExecute, true);
  assert.equal(calls, 0);
  assert.deepEqual(listReleases(f.root), []);
  assert.ok(plan.command.args.includes('--project-type'));
  assert.ok(plan.command.args.includes('miniGame'));
  assert.ok(plan.command.args.includes('<env:FWB_TEST_KEY_PATH>'));
  assert.ok(!JSON.stringify(plan).includes('PRIVATE_KEY_VALUE'));
  assert.ok(!JSON.stringify(plan).includes(f.env.FWB_TEST_KEY_PATH));
});

test('retired TapTap artifacts cannot be planned or uploaded even through handoff', async t => {
  const f = fixture(t);
  f.artifact.target = 'taptap-minigame';
  atomicJson(path.join(f.directory, 'manifest.json'), f.artifact);
  f.config.targets['taptap-minigame'] = { enabled: false, preset: 'Legacy TapTap', upload: { provider: 'handoff' } };
  f.save();
  const before = fs.readFileSync(path.join(f.directory, 'manifest.json'), 'utf8');
  let calls = 0;
  const publish = createPublisher({ env: f.env, homeDirectory: f.homeDirectory, run: async () => { calls++; } });
  await assert.rejects(publish.planUpload(f.root, id), { code: 'retired-target', message: /taptap-h5/ });
  await assert.rejects(publish.uploadArtifact(f.root, id, { execute: true }), { code: 'retired-target', message: /taptap-h5/ });
  assert.equal(calls, 0);
  assert.deepEqual(listReleases(f.root), []);
  assert(!fs.existsSync(path.join(f.root, '.local/fwb/upload.lock')));
  assert.equal(fs.readFileSync(path.join(f.directory, 'manifest.json'), 'utf8'), before);
});

test('unvalidated runtime or wrong artifact fingerprint blocks execution', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const publish = createPublisher({ env: f.env, homeDirectory: f.homeDirectory, run: async () => { calls++; return { ok: true, output: 'done' }; } });
  f.upload.acceptance.runtime = 'not-tested'; f.save();
  assert.equal((await publish.uploadArtifact(f.root, id, { execute: true })).status, 'blocked');
  f.upload.acceptance.runtime = 'passed'; f.upload.acceptance.outputsSha256 = 'a'.repeat(64); f.save();
  assert.equal((await publish.planUpload(f.root, id)).canExecute, false);
  assert.equal(calls, 0);
});

test('tampered artifact output cannot be uploaded even with old acceptance', async (t) => {
  const f = fixture(t);
  write(path.join(f.out, 'game.js'), 'tampered');
  const result = await createPublisher({ env: f.env, homeDirectory: f.homeDirectory }).planUpload(f.root, id);
  assert.equal(result.status, 'blocked');
  assert.equal(result.checks.find((check) => check.id === 'package').status, 'fail');
});

test('missing provider, package version, private key and wrong channel are explicit blockers', async (t) => {
  const f = fixture(t);
  const publish = createPublisher({ env: f.env, homeDirectory: f.homeDirectory });
  const original = f.upload.provider;
  f.upload.provider = 'shell-hook'; f.save();
  assert.equal((await publish.planUpload(f.root, id)).status, 'blocked');
  f.upload.provider = original; f.upload.toolVersion = '0.0.0'; f.save();
  assert.equal((await publish.planUpload(f.root, id)).checks.find((check) => check.id === 'official-tool').status, 'fail');
  f.upload.toolVersion = f.spec.version; f.save();
  assert.equal((await publish.planUpload(f.root, id, { channel: 'production' })).status, 'blocked');
  delete f.env.FWB_TEST_KEY_PATH;
  assert.equal((await publish.planUpload(f.root, id)).checks.find((check) => check.id === 'credential').status, 'fail');
});

test('wechat upload copies immutable output and records only bounded safe result', async (t) => {
  const f = fixture(t);
  const calls = [];
  const publish = createPublisher({ env: f.env, homeDirectory: f.homeDirectory, run: async (executable, args, options) => {
    calls.push({ executable, args, options });
    const packageDirectory = args[args.indexOf('--pp') + 1];
    assert.notEqual(packageDirectory, f.out);
    assert.ok(fs.existsSync(path.join(packageDirectory, 'game.js')));
    assert.equal(args[args.indexOf('--pkp') + 1], f.env.FWB_TEST_KEY_PATH);
    return { ok: true, code: 0, output: 'PRIVATE_TOKEN_DO_NOT_PERSIST\ndone\n' };
  } });
  const result = await publish.uploadArtifact(f.root, id, { execute: true });
  assert.equal(result.status, 'uploaded');
  assert.equal(result.remote.status, 'cli-confirmed-awaiting-platform-check');
  assert.equal(calls.length, 1);
  assert.equal(fileDigest(path.join(f.out, 'game.js')), f.artifact.outputs.find((item) => item.path === 'out/game.js').sha256);
  const stored = fs.readFileSync(path.join(result.directory, 'release.json'), 'utf8');
  assert.ok(!stored.includes('PRIVATE_TOKEN'));
  assert.ok(!stored.includes(f.env.FWB_TEST_KEY_PATH));
  assert.equal((await publish.planUpload(f.root, id)).checks.find((check) => check.id === 'duplicate').status, 'fail');
});

test('timeout becomes unknown and blocks retry until explicit evidence reconciles it', async (t) => {
  const f = fixture(t);
  const publish = createPublisher({ env: f.env, homeDirectory: f.homeDirectory, run: async () => ({ ok: false, reason: 'timeout', output: 'PRIVATE_TOKEN' }) });
  const result = await publish.uploadArtifact(f.root, id, { execute: true });
  assert.equal(result.status, 'unknown');
  assert.equal(result.retryPolicy, 'reconcile-before-retry');
  assert.equal((await publish.planUpload(f.root, id)).status, 'blocked');
  const record = recordUploadReceipt(f.root, result.id, { status: 'not-uploaded', evidence: 'acceptance.md' });
  assert.equal(record.remote.status, 'operator-confirmed-not-uploaded');
  assert.equal((await publish.planUpload(f.root, id)).status, 'ready');
});

test('a process spawn failure can be retried while nonzero remote outcomes stay unknown', async (t) => {
  const f = fixture(t);
  const publish = createPublisher({ env: f.env, homeDirectory: f.homeDirectory, run: async () => ({ ok: false, reason: 'ENOENT', output: '' }) });
  assert.equal((await publish.uploadArtifact(f.root, id, { execute: true })).status, 'failed');
  assert.equal((await publish.planUpload(f.root, id)).status, 'ready');
  const failedRemote = createPublisher({ env: f.env, homeDirectory: f.homeDirectory, run: async () => ({ ok: false, code: 1, reason: 'exit-code', output: 'network disconnected' }) });
  assert.equal((await failedRemote.uploadArtifact(f.root, id, { execute: true })).status, 'unknown');
});

test('Douyin requires its actual success marker, because CLI errors may exit zero', async (t) => {
  const f = fixture(t, 'douyin-cli');
  const publish = createPublisher({ env: f.env, homeDirectory: f.homeDirectory, run: async (_, args) => {
    assert.ok(args.includes('--app-version'));
    assert.ok(args.includes('--app-changelog'));
    assert.ok(!args.includes('--channel'));
    return { ok: true, code: 0, output: 'UploadError: failed' };
  } });
  const result = await publish.uploadArtifact(f.root, id, { execute: true });
  assert.equal(result.status, 'unknown');
  recordUploadReceipt(f.root, result.id, { status: 'not-uploaded', evidence: 'acceptance.md' });
  const success = createPublisher({ env: f.env, homeDirectory: f.homeDirectory, run: async () => ({ ok: true, code: 0, output: '🎉 Upload success' }) });
  assert.equal((await success.uploadArtifact(f.root, id, { execute: true })).status, 'uploaded');
});

test('Poki writes isolated config and needs matching game/remote build receipt', async (t) => {
  const f = fixture(t, 'poki-cli');
  const publish = createPublisher({ env: f.env, homeDirectory: f.homeDirectory, hostPlatform: 'linux', run: async (_, args, options) => {
    const config = JSON.parse(fs.readFileSync(path.join(options.cwd, 'poki.json'), 'utf8'));
    assert.equal(config.game_id, f.spec.applicationId);
    assert.equal(config.build_dir, 'package');
    assert.ok(args.includes('--name'));
    return { ok: true, code: 0, output: `Version uploaded successfully\nPreview: https://poki.com/en/preview/${f.spec.applicationId}/${remoteId}\n` };
  } });
  const result = await publish.uploadArtifact(f.root, id, { execute: true });
  assert.equal(result.status, 'uploaded', JSON.stringify(result));
  assert.equal(result.remote.resourceId, remoteId);
  assert.ok(!fs.existsSync(path.join(f.out, 'poki.json')));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SESSION'));
});

test('Poki zero exit without upload receipt remains unknown', async (t) => {
  const f = fixture(t, 'poki-cli');
  const result = await createPublisher({ env: f.env, homeDirectory: f.homeDirectory, hostPlatform: 'linux', run: async () => ({ ok: true, code: 0, output: 'Error: authentication failed' }) }).uploadArtifact(f.root, id, { execute: true });
  assert.equal(result.status, 'unknown');
});

test('handoff is a useful local result that never executes a platform tool', async (t) => {
  const f = fixture(t, 'poki-cli');
  f.config.targets[f.spec.target].upload = { provider: 'handoff' }; f.save();
  let calls = 0;
  const result = await createPublisher({ env: {}, run: async () => { calls++; } }).uploadArtifact(f.root, id, { execute: true });
  assert.equal(result.status, 'handoff');
  assert.equal(result.canExecute, false);
  assert.ok(result.handoff.steps.length > 0);
  assert.equal(calls, 0);
  assert.deepEqual(listReleases(f.root), []);
});

test('unconfigured upload defaults to handoff even when UI asks for development', async (t) => {
  const f = fixture(t, 'poki-cli');
  delete f.config.targets[f.spec.target].upload; f.save();
  const result = await createPublisher({ env: {}, run: async () => { throw new Error('must not execute'); } }).uploadArtifact(f.root, id, { channel: 'development', execute: true });
  assert.equal(result.status, 'handoff');
  assert.equal(result.provider, 'handoff');
  assert.equal(result.channel, 'handoff');
  assert.equal(result.canExecute, false);
});

test('app identity mismatch in immutable minigame package blocks upload', async (t) => {
  const f = fixture(t);
  f.upload.applicationId = 'wx0000000000000000'; f.save();
  const result = await createPublisher({ env: f.env, homeDirectory: f.homeDirectory }).planUpload(f.root, id);
  assert.equal(result.checks.find((check) => check.id === 'package-application').status, 'fail');
});

test('unfinished lock prevents concurrent execution and manual reconciliation', async (t) => {
  const f = fixture(t);
  write(path.join(f.root, '.local', 'fwb', 'upload.lock'), '{}');
  const publish = createPublisher({ env: f.env, homeDirectory: f.homeDirectory });
  await assert.rejects(publish.uploadArtifact(f.root, id, { execute: true }), { code: 'upload-busy' });
  assert.throws(() => recordUploadReceipt(f.root, 'upload_123456789012', { status: 'not-uploaded', evidence: 'acceptance.md' }), { code: 'upload-busy' });
});

test('malformed historical receipt blocks duplicate detection conservatively', async (t) => {
  const f = fixture(t);
  write(path.join(f.root, '.local', 'fwb', 'releases', 'upload_123456789012_fixture', 'release.json'), '{invalid');
  const result = await createPublisher({ env: f.env, homeDirectory: f.homeDirectory }).planUpload(f.root, id);
  assert.equal(result.checks.find((check) => check.id === 'duplicate').status, 'fail');
});

test('recorded runtime and platform evidence feed upload checks and latest failure blocks',async t=>{
 const {recordEvidence,readArtifact}=await import('../src/core/build.mjs');const f=fixture(t);delete f.upload.acceptance;f.save();
 const publish=createPublisher({env:f.env,homeDirectory:f.homeDirectory,run:async()=>{throw new Error('must not execute');}});
 await recordEvidence(f.root,id,{kind:'runtime',result:'passed',file:'acceptance.md'});assert.equal((await publish.planUpload(f.root,id)).canExecute,false);
 await recordEvidence(f.root,id,{kind:'platform',result:'passed',file:'acceptance.md'});assert.equal((await publish.planUpload(f.root,id)).canExecute,true);
 const artifact=readArtifact(f.root,id);const report=artifact.evidence.at(-1);fs.appendFileSync(path.join(f.directory,report.path),'tamper');assert.equal((await publish.planUpload(f.root,id)).canExecute,false);
 await recordEvidence(f.root,id,{kind:'platform',result:'failed',file:'acceptance.md'});assert.equal((await publish.planUpload(f.root,id)).canExecute,false);
});
