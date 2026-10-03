import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/project.mjs';
import { configureExport, prepareSnapshot, validateArtifact } from '../src/core/build.mjs';
import { convertMinigame, usesWebConversion, validateMinigameOutputs } from '../src/core/minigame-export.mjs';
import { fileDigest, sectionValue, walk } from '../src/core/files.mjs';

const appid = 'wx0123456789abcdef';
const target = 'wechat-minigame';
const profile = 'release';
const adapter = `import fs from 'node:fs';
import path from 'node:path';
const out = process.env.FWB_OUTPUT_ROOT;
fs.writeFileSync(path.join(out, 'game.js'), 'console.log("fixture adapter");');
fs.writeFileSync(path.join(out, 'game.json'), JSON.stringify({deviceOrientation:'portrait'}));
fs.writeFileSync(path.join(out, 'project.config.json'), JSON.stringify({appid:'${appid}',compileType:'game',miniprogramRoot:'./'}));
fs.copyFileSync(path.join(process.env.FWB_WEB_INPUT_ROOT, 'index.pck'), path.join(out, 'resources.pck'));
fs.writeFileSync(path.join(out, 'process.json'), JSON.stringify({cwd:process.cwd(),snapshot:process.env.FWB_SNAPSHOT_ROOT,input:process.env.FWB_WEB_INPUT_ROOT,output:out,args:process.argv.slice(2)}));
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-wechat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'project.godot'), '[application]\nconfig/name="WeChat test"\n');
  const project = initProject(root);
  project.config.targets[target] = { enabled: true, applicationId: appid, convertScript: 'adapter.mjs' };
  const id = 'build_wechat_fixture_0001';
  const directory = path.join(root, '.local/fwb/artifacts', id);
  const stage = path.join(directory, 'project');
  const input = path.join(directory, 'web');
  const out = path.join(directory, 'out');
  for (const folder of [stage, input, out]) fs.mkdirSync(folder, { recursive: true });
  const manifest = { schemaVersion: 1, id, target, profile, status: 'building', applicationId: appid, outputs: [], validation: { package: 'not-tested', runtime: 'not-tested', platform: 'not-tested' } };
  fs.writeFileSync(path.join(root, 'adapter.mjs'), 'throw new Error("The live adapter must never run.");');
  fs.writeFileSync(path.join(stage, 'adapter.mjs'), adapter);
  fs.copyFileSync(path.join(root, 'project.godot'), path.join(stage, 'project.godot'));
  fs.writeFileSync(path.join(input, 'index.html'), '<!doctype html><title>Raw Godot fixture</title>');
  fs.writeFileSync(path.join(input, 'index.js'), '// fixture engine');
  fs.writeFileSync(path.join(input, 'index.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  fs.writeFileSync(path.join(input, 'index.pck'), 'GDPC fixture resource pack');
  const save = () => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  save();
  return {
    project, root, directory, id, stage, input, out, manifest, save,
    run(options) { return convertMinigame(project, stage, input, out, target, profile, options); },
    artifact() {
      return { ...manifest, directory, outputs: walk(out).map(file => ({ path: 'out/' + file, size: fs.statSync(path.join(out, file)).size, sha256: fileDigest(path.join(out, file)) })) };
    },
  };
}

const failed = checks => checks.filter(check => check.status === 'fail');

test('WeChat conversion executes the frozen adapter with isolated paths and preserves raw Web inputs', async t => {
  const f = fixture(t);
  const liveHash = fileDigest(path.join(f.root, 'adapter.mjs'));
  const rawHash = fileDigest(path.join(f.input, 'index.pck'));
  const result = await f.run();
  const actual = JSON.parse(fs.readFileSync(path.join(f.out, 'process.json')));
  assert.deepEqual(actual, {
    cwd: f.stage, snapshot: f.stage, input: f.input, output: f.out,
    args: ['--project', f.stage, '--input', f.input, '--output', f.out, '--target', target, '--profile', profile],
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.script, 'adapter.mjs');
  assert.equal(result.sha256, fileDigest(path.join(f.stage, 'adapter.mjs')));
  assert.equal(result.input.directory, 'web');
  assert.equal(result.input.files.length, 4);
  assert.match(result.input.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.outputSha256, /^[a-f0-9]{64}$/);
  assert.equal(fileDigest(path.join(f.root, 'adapter.mjs')), liveHash);
  assert.equal(fileDigest(path.join(f.input, 'index.pck')), rawHash);
  assert.equal(fileDigest(path.join(f.out, 'resources.pck')), rawHash);
  assert(!fs.existsSync(path.join(f.root, 'process.json')));
  assert.deepEqual(failed(validateMinigameOutputs(f.artifact())), []);
});

test('converted developer-tools output passes package validation without claiming runtime or platform acceptance', async t => {
  const f = fixture(t); await f.run();
  Object.assign(f.manifest, f.artifact(), { status: 'built', entry: 'out/game.js' });
  delete f.manifest.directory; f.save();
  const result = await validateArtifact(f.root, f.id);
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'package');
  assert.equal(result.runtimeStatus, 'not-tested');
  const persisted = JSON.parse(fs.readFileSync(path.join(f.directory, 'manifest.json')));
  assert.equal(persisted.validation.package, 'passed');
  assert.equal(persisted.validation.runtime, 'not-tested');
  assert.equal(persisted.validation.platform, 'not-tested');
});

test('plain browser exports never pass mini-game package validation', async t => {
  const f = fixture(t);
  for (const file of walk(f.input)) fs.copyFileSync(path.join(f.input, file), path.join(f.out, file));
  const checks = validateMinigameOutputs(f.artifact());
  assert(failed(checks).some(check => check.id === 'minigame:game.js'));
  assert(failed(checks).some(check => check.id === 'minigame:game.json'));
  Object.assign(f.manifest, f.artifact(), { status: 'built' }); delete f.manifest.directory; f.save();
  assert.equal((await validateArtifact(f.root, f.id)).ok, false);
});

test('WeChat output rejects malformed JSON, mismatched AppIDs, wrong compile type and redirected roots', async t => {
  const cases = [
    ['game.json', '{', 'minigame:game.json'],
    ['game.json', '[]', 'minigame:game-config'],
    ['game.json', 'null', 'minigame:game-config'],
    ['project.config.json', '{', 'wechat:project-config'],
    ['project.config.json', JSON.stringify({ appid, compileType: 'miniprogram' }), 'wechat:project-config'],
    ['project.config.json', JSON.stringify({ appid: 'wxabcdef0123456789', compileType: 'game' }), 'wechat:appid'],
    ['project.config.json', JSON.stringify({ appid: 'touristappid', compileType: 'game' }), 'wechat:appid'],
    ['project.config.json', JSON.stringify({ appid, compileType: 'game', miniprogramRoot: '../elsewhere' }), 'wechat:project-root'],
    ['project.config.json', JSON.stringify({ appid, compileType: 'game', miniprogramRoot: 'nested/' }), 'wechat:project-root'],
    ['game.js', '', 'minigame:game.js'],
  ];
  const f = fixture(t); await f.run();
  for (const [name, content, expected] of cases) {
    const file = path.join(f.out, name); const original = fs.readFileSync(file);
    fs.writeFileSync(file, content);
    assert(failed(validateMinigameOutputs(f.artifact())).some(check => check.id === expected), `${name}: ${content}`);
    fs.writeFileSync(file, original);
  }
});

test('conversion rejects live-source paths, aliased or misplaced output directories, and mismatched build markers', async t => {
  const f = fixture(t);
  for (const [stage, input, out] of [[f.root, f.input, f.out], [f.stage, f.input, f.stage], [f.stage, f.input, f.root], [f.stage, f.out, f.input]]) {
    await assert.rejects(convertMinigame(f.project, stage, input, out, target, profile), { code: 'unsafe-stage' });
  }
  for (const [key, value] of [['status', 'built'], ['target', 'web'], ['profile', 'debug'], ['id', 'build_other_artifact']]) {
    const previous = f.manifest[key]; f.manifest[key] = value; f.save();
    await assert.rejects(f.run(), { code: 'unsafe-stage' });
    f.manifest[key] = previous; f.save();
  }
  f.project.config.targets[target].convertScript = '../adapter.mjs';
  await assert.rejects(f.run(), { code: 'unsafe-path' });
});

test('conversion rejects missing adapters, incomplete Web inputs and nonempty output', async t => {
  const f = fixture(t); const script = path.join(f.stage, 'adapter.mjs');
  fs.renameSync(script, script + '.backup');
  await assert.rejects(f.run(), { code: 'convert-script-missing' });
  fs.renameSync(script + '.backup', script);
  const wasm = path.join(f.input, 'index.wasm'); fs.renameSync(wasm, wasm + '.backup');
  await assert.rejects(f.run(), { code: 'conversion-input-missing' });
  fs.renameSync(wasm + '.backup', wasm);
  fs.writeFileSync(path.join(f.out, 'leftover.txt'), 'previous output');
  await assert.rejects(f.run(), { code: 'conversion-output-not-empty' });
});

test('adapter failures, empty results, cancellation and raw-input mutations terminate conversion', async t => {
  for (const [script, error] of [
    ['process.exit(7);', /code 7/],
    ['// no output', { code: 'empty-conversion' }],
    [adapter + '\nfs.writeFileSync(path.join(process.env.FWB_WEB_INPUT_ROOT,"index.pck"),"changed");', { code: 'conversion-input-changed' }],
  ]) {
    const f = fixture(t); fs.writeFileSync(path.join(f.stage, 'adapter.mjs'), script);
    await assert.rejects(f.run(), error);
  }
  const f = fixture(t); const controller = new AbortController();
  fs.writeFileSync(path.join(f.stage, 'adapter.mjs'), 'console.log("adapter-ready");setInterval(()=>{},1000);');
  await assert.rejects(f.run({ signal: controller.signal, onOutput(chunk) { if (chunk.includes('adapter-ready')) controller.abort(); }, timeoutSeconds: 5 }), /cancelled/);
  assert.equal(walk(f.out).length, 0);
});

test('shared Web preparation keeps the actual WeChat target and reports its selected pipeline', async t => {
  const f = fixture(t);
  f.project.config.resourcePipelines = { web: { prepareScript: 'prepare.mjs' } };
  fs.writeFileSync(path.join(f.root, 'prepare.mjs'), 'throw new Error("Live preparation must never run");');
  fs.writeFileSync(path.join(f.stage, 'prepare.mjs'), 'import fs from "node:fs";fs.writeFileSync("prepared.json",JSON.stringify({args:process.argv.slice(2),pipeline:process.env.FWB_RESOURCE_PIPELINE,snapshot:process.env.FWB_SNAPSHOT_ROOT}));');
  const result = await prepareSnapshot(f.project, f.stage, target, profile);
  const report = JSON.parse(fs.readFileSync(path.join(f.stage, 'prepared.json')));
  assert.deepEqual(report, { args: ['--project', f.stage, '--target', target, '--profile', profile], pipeline: 'web', snapshot: f.stage });
  assert.equal(result.pipeline, 'web'); assert.equal(result.source, 'pipeline');
  assert.equal(result.script, 'prepare.mjs'); assert.equal(result.status, 'passed');
  assert(!fs.existsSync(path.join(f.root, 'prepared.json')));
});

test('WeChat conversion selects standard Web raw output while a custom exporter retains its ZIP contract', t => {
  const f = fixture(t); const presets = path.join(f.stage, 'export_presets.cfg');
  const original = '[preset.0]\nname="Web"\nplatform="Web"\nexport_path=""\n[preset.0.options]\nvariant/thread_support=true\nprogressive_web_app/enabled=true\n[preset.1]\nname="Verified SDK"\nplatform="WeChat SDK"\nexport_path=""\n[preset.1.options]\n';
  fs.writeFileSync(presets, original);
  const converted = configureExport(f.project, f.stage, target, { release: true }, {});
  assert.deepEqual(converted, { filename: 'index.html', preset: 'Web', web: true });
  let text = fs.readFileSync(presets, 'utf8');
  assert.equal(sectionValue(text, 'preset.0', 'export_path'), '../web/index.html');
  assert.equal(sectionValue(text, 'preset.0.options', 'variant/thread_support'), 'false');
  assert.equal(sectionValue(text, 'preset.0.options', 'progressive_web_app/enabled'), 'false');
  assert.equal(sectionValue(text, 'preset.1', 'export_path'), '');
  delete f.project.config.targets[target].convertScript;
  f.project.config.targets[target].preset = 'Verified SDK';
  f.project.config.targets[target].exportPlatform = 'WeChat SDK';
  fs.writeFileSync(presets, original);
  const legacy = configureExport(f.project, f.stage, target, { release: true }, {});
  assert.deepEqual(legacy, { filename: 'game.zip', preset: 'Verified SDK', web: false });
  text = fs.readFileSync(presets, 'utf8');
  assert.equal(sectionValue(text, 'preset.1', 'export_path'), '../out/game.zip');
  assert.equal(sectionValue(text, 'preset.0', 'export_path'), '');
  assert.equal(usesWebConversion(target, f.project.config.targets[target]), false);
  assert.equal(usesWebConversion('douyin-minigame', { convertScript: 'convert.mjs' }), false);
});
