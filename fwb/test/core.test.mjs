import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { initProject, readProject, updateProject, validateConfig, inputFiles } from '../src/core/project.mjs';
import { atomicJson, child, fileDigest } from '../src/core/files.mjs';
import { buildProject, fwcPrepareCommand, listArtifacts, readArtifact, readArtifactLog, validateArtifact, recordEvidence } from '../src/core/build.mjs';
import { startPreview } from '../src/core/preview.mjs';
import { parseArgs } from '../src/cli.mjs';
import { outputsFingerprint } from '../src/core/publish.mjs';
import { pckFixture } from './fixtures/web-output.mjs';

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
  const files = { 'index.html': '<!doctype html><title>FWB</title>', 'index.js': '// engine', 'index.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), 'index.pck': pckFixture() };
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

test('FWC inspection records its documentation version as a regression baseline', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'fw/fwc/docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fw/fwc/csharp/FwGen'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fw/fwc/docs/spec.md'), '- Godot：`4.6.2`；GDScript 可使用标准版。\n');
  fs.writeFileSync(path.join(root, 'fw.toml'), '[runtime]\ngame="gdscript"\n[dotnet]\nfwgen="fw/fwc/csharp/FwGen/FwGen.csproj"\n');
  const project = initProject(root, { godotVersion: '4.7.2' });
  assert.equal(project.inspection.fwc.baselineGodotVersion, '4.6.2');
  assert.equal(project.config.godot.version, '4.7.2');
  assert.equal(Object.hasOwn(project.inspection.fwc, 'requiredGodotVersion'), false);
});

test('FWC preparation forwards explicit host import budgets through both script contracts', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const [configured, expected] of [[undefined, '180'], [10, '10'], [1200, '1200'], [1800, '1800'], [3600, '1800']]) {
      const component = path.join('game with spaces', 'fw', 'fwc');
      const stage = path.join('frozen project', '游戏');
      const engine = path.join('Godot Engine', 'godot');
      const command = fwcPrepareCommand(component, stage, engine, configured, platform);
      const windows = platform === 'win32';
      assert.equal(command.executable, windows ? 'powershell.exe' : 'bash');
      assert(command.args.includes(path.join(component, windows ? 'tools/build.ps1' : 'tools/build.sh')));
      const value = flag => command.args[command.args.indexOf(flag) + 1];
      assert.equal(value(windows ? '-ProjectRoot' : '--project-root'), stage);
      assert.equal(value(windows ? '-Godot' : '--godot'), engine);
      assert.equal(value(windows ? '-GodotImportTimeoutSeconds' : '--godot-import-timeout-seconds'), expected);
      assert(command.args.includes(windows ? '-Release' : '--release'));
    }
  }
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

test('preview rejects same-size changes and missing outputs on every GET and HEAD request', async t => {
  const { root,id,directory }=artifact(t);
  const preview=await startPreview(root,id);t.after(preview.close);
  assert.equal((await fetch(preview.url+'index.js')).status,200);
  const file=path.join(directory,'out/index.js');const original=fs.readFileSync(file);
  fs.writeFileSync(file,Buffer.alloc(original.length,120));
  assert.equal((await fetch(preview.url+'index.js')).status,409);
  assert.equal((await fetch(preview.url+'index.js',{method:'HEAD'})).status,409);
  fs.unlinkSync(path.join(directory,'out/index.wasm'));
  assert.equal((await fetch(preview.url+'index.wasm')).status,409);
  fs.writeFileSync(file,original);
  assert.equal(await (await fetch(preview.url+'index.js')).text(),original.toString());
  assert.equal((await fetch(preview.url)).status,200,'failed reads must leave the preview server running');
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
