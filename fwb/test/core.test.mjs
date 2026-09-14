import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { initProject, readProject, updateProject, validateConfig, inputFiles } from '../src/core/project.mjs';
import { atomicJson, child, fileDigest } from '../src/core/files.mjs';
import { buildProject, listArtifacts, readArtifact, readArtifactLog, validateArtifact, recordEvidence } from '../src/core/build.mjs';
import { startPreview } from '../src/core/preview.mjs';
import { parseArgs } from '../src/cli.mjs';
import { outputsFingerprint } from '../src/core/publish.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-core-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'project.godot'), '[application]\nconfig/name="Test"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  return root;
}

function artifact(t) {
  const root = fixture(t); initProject(root);
  const id = 'build_test123456789';
  const directory = path.join(root, '.local/fwb/artifacts', id);
  fs.mkdirSync(path.join(directory, 'out'), { recursive: true });
  const files = { 'index.html': '<!doctype html><title>FWB</title>', 'index.js': '// engine', 'index.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), 'index.pck': 'fixture-pack' };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, 'out', name), bytes);
  atomicJson(path.join(directory, 'manifest.json'), { schemaVersion: 1, id, target: 'web', profile: 'debug', status: 'built', outputs: Object.keys(files).map(name => ({ path: `out/${name}`, size: fs.statSync(path.join(directory, 'out', name)).size, sha256: fileDigest(path.join(directory, 'out', name)) })), validation: { runtime: 'not-tested', platform: 'not-tested' } });
  return { root, id, directory };
}

test('init preserves existing configuration and runtime comes from the game', t => {
  const root = fixture(t);
  const first = initProject(root);
  assert.equal(first.inspection.runtime, 'gdscript');
  assert.equal(first.created, true);
  assert.deepEqual(Object.keys(first.config.targets).filter(id => id.startsWith('taptap-')), ['taptap-h5']);
  assert.equal(initProject(root, { godot: 'do-not-overwrite' }).created, false);
  assert.equal(readProject(root).config.godot.executable, 'godot');
  fs.appendFileSync(path.join(root, 'project.godot'), '\n[application]\nconfig/features=PackedStringArray("4.6", "C#")\n');
  assert.equal(readProject(root).inspection.runtime, 'csharp');
});

test('retired TapTap configurations require explicit disabling and preserve legacy settings', t => {
  const root = fixture(t); const project = initProject(root);
  const file = path.join(root, 'fwb.project.json');
  const legacy = { preset: 'Legacy TapTap', sdkPath: 'old-sdk', sdkVersion: '1.2.3' };
  project.config.targets['taptap-minigame'] = legacy;
  for (const enabled of [undefined, true]) {
    if (enabled === undefined) delete legacy.enabled; else legacy.enabled = enabled;
    atomicJson(file, project.config);
    const before = fs.readFileSync(file, 'utf8');
    for (const read of [() => validateConfig(project.config), () => readProject(root)]) {
      assert.throws(read, { code: 'retired-target', message: /taptap-h5/ });
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  legacy.enabled = false;
  atomicJson(file, project.config);
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(readProject(root).config.targets['taptap-minigame'], legacy);
  assert.equal(initProject(root).created, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('retired TapTap build stops before creating artifacts or a build lock', async t => {
  const root = fixture(t); const project = initProject(root);
  project.config.targets['taptap-minigame'] = { enabled: false, preset: 'Legacy TapTap' };
  atomicJson(path.join(root, 'fwb.project.json'), project.config);
  await assert.rejects(buildProject(root, { target: 'taptap-minigame' }), { code: 'retired-target', message: /taptap-h5/ });
  assert.deepEqual(listArtifacts(root), []);
  assert(!fs.existsSync(path.join(root, '.local')));
});

test('configuration edits require current revision and reject unsupported values', t => {
  const root = fixture(t); const project = initProject(root);
  const config = structuredClone(project.config); config.version = '0.2.0';
  updateProject(root, config, project.revision);
  assert.throws(() => updateProject(root, config, project.revision), /changed/);
  const latest = readProject(root); latest.config.profiles.debug.release = 'false';
  assert.throws(() => updateProject(root, latest.config, latest.revision), /Invalid profile/);
});

test('paths reject traversal and input enumeration omits build output and keys', t => {
  const root = fixture(t); initProject(root);
  fs.mkdirSync(path.join(root, '.local/generated'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local/generated/secret.txt'), 'hidden');
  fs.writeFileSync(path.join(root, 'upload.keystore'), 'secret');
  fs.writeFileSync(path.join(root, 'content.json'), '{}');
  fs.mkdirSync(path.join(root, 'private'));
  fs.writeFileSync(path.join(root, 'private/config.json'), '{}');
  assert.throws(() => child(root, '../escape'), /relative/);
  assert.throws(() => child(root, 'a/../../escape'), /relative/);
  assert.deepEqual(inputFiles(root, { exclude: ['private\\config.json'] }).filter(file => file.endsWith('.json')), ['content.json', 'fwb.project.json']);
  assert(!inputFiles(root).includes('upload.keystore'));
});

test('failed preflight records an artifact and releases the build lock', async t => {
  const root = fixture(t); initProject(root, { godot: 'fwb-nonexistent-engine-9283' });
  await assert.rejects(buildProject(root), error => Boolean(error.artifactId));
  const items = listArtifacts(root);
  assert.equal(items.length, 1); assert.equal(items[0].status, 'failed');
  assert(!fs.existsSync(path.join(root, '.local/fwb/build.lock')));
  assert(!fs.existsSync(path.join(root, '.godot')));
});

test('artifact directory failure does not leave a permanent build lock', async t => {
  const root = fixture(t); initProject(root);
  fs.mkdirSync(path.join(root, '.local/fwb'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local/fwb/artifacts'), 'not a directory');
  await assert.rejects(buildProject(root));
  assert(!fs.existsSync(path.join(root, '.local/fwb/build.lock')));
});

test('package integrity rejects tampering and preserves untested runtime state', async t => {
  const { root, id, directory } = artifact(t);
  const good = await validateArtifact(root, id);
  assert.equal(good.ok, true); assert.equal(good.runtimeStatus, 'not-tested');
  fs.appendFileSync(path.join(directory, 'out/index.js'), 'tampered');
  assert.equal((await validateArtifact(root, id)).ok, false);
  assert.equal(readArtifact(root, id).validation.runtime, 'not-tested');
});

test('retired TapTap artifact history and logs stay readable but cannot be revalidated', async t => {
  const { root, id, directory } = artifact(t);
  const { directory: ignored, ...stored } = readArtifact(root, id);
  stored.target = 'taptap-minigame';
  stored.validation.package = 'passed';
  atomicJson(path.join(directory, 'manifest.json'), stored);
  fs.writeFileSync(path.join(directory, 'build.log'), 'Historical TapTap build log.\n');
  const before = fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8');
  assert.equal(readArtifact(root, id).target, 'taptap-minigame');
  assert.equal(listArtifacts(root)[0].target, 'taptap-minigame');
  assert.match(readArtifactLog(root, id), /Historical TapTap/);
  await assert.rejects(validateArtifact(root, id), { code: 'retired-target', message: /taptap-h5/ });
  assert.equal(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'), before);
});

test('additional files and escaping manifest entries fail validation', async t => {
  const { root, id, directory } = artifact(t);
  fs.writeFileSync(path.join(directory, 'out/unrecorded.txt'), 'extra');
  assert.equal((await validateArtifact(root, id)).ok, false);
  const value = readArtifact(root, id); value.outputs.push({ path: 'out/../../secret.txt', size: 1, sha256: 'x' });
  delete value.directory; atomicJson(path.join(directory, 'manifest.json'), value);
  assert.equal((await validateArtifact(root, id)).ok, false);
});

test('preview serves only recorded outputs with WebAssembly MIME', async t => {
  const { root, id } = artifact(t);
  const preview = await startPreview(root, id); t.after(preview.close);
  assert.equal((await fetch(preview.url)).status, 200);
  assert.equal((await fetch(preview.url + 'index.wasm')).headers.get('content-type'), 'application/wasm');
  assert.equal((await fetch(preview.url + 'manifest.json')).status, 404);
  assert.equal((await fetch(preview.url + 'index.js', { method: 'POST' })).status, 405);
  const rejected = await new Promise((resolve, reject) => {
    const request = http.get(preview.url, { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(rejected, 403);
});

test('CLI rejects duplicate, unknown, and unscoped positional arguments', () => {
  assert.equal(parseArgs(['editor', '--project', 'game', '--fwe-path', '../fwe', '--no-open']).options['no-open'], true);
  assert.throws(() => parseArgs(['build', '--target', 'web', '--target', 'poki']), /Repeated/);
  assert.throws(() => parseArgs(['build', '--script', 'anything']), /Unknown/);
  assert.throws(() => parseArgs(['build', 'game']), /named/);
});

test('runtime evidence keeps an immutable report copy without granting platform acceptance', async t => {
  const { root, id, directory } = artifact(t);
  const report = path.join(root, 'runtime-report.json');
  fs.writeFileSync(report, '{"observed":"input and reload"}');
  const result = await recordEvidence(root, id, { kind: 'runtime', result: 'passed', file: report });
  const copied = child(directory, result.evidence.path);
  assert.equal(result.evidence.outputsSha256, outputsFingerprint(readArtifact(root, id)));
  assert.equal(fileDigest(copied), fileDigest(report));
  fs.writeFileSync(report, '{"changed":true}');
  assert.notEqual(fileDigest(copied), fileDigest(report));
  assert.equal(readArtifact(root, id).validation.runtime, 'passed');
  assert.equal(readArtifact(root, id).validation.platform, 'not-tested');
  fs.appendFileSync(path.join(directory, 'out/index.js'), 'tampered');
  await assert.rejects(recordEvidence(root, id, { kind: 'platform', result: 'passed', file: report }), /intact/);
});
