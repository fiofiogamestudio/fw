import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync, gzipSync } from 'node:zlib';
import { initProject, validateConfig } from '../src/core/project.mjs';
import { atomicJson, fileDigest, readJson, digest, sectionValue } from '../src/core/files.mjs';
import { copyExternalAssets, resolveExternalAssets } from '../src/core/external-assets.mjs';
import { resourceReport, resourceBudgetChecks, inspectPack } from '../src/core/resource-report.mjs';
import { deliverArtifact, streamZip } from '../src/core/delivery.mjs';
import { zipPolicy, validateZipSize } from '../src/core/zip-policy.mjs';
import { configureExport, readArtifact, validateArtifact } from '../src/core/build.mjs';
import { createDoctor } from '../src/doctor.mjs';
import { main, parseArgs } from '../src/cli.mjs';
import { startDeliveryPreview } from '../src/core/preview.mjs';
import { pckFixture, wasmFixture } from './fixtures/web-output.mjs';

function fixture(t, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-resource-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'project.godot'), '[application]\nconfig/name="Delivery"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  fs.writeFileSync(path.join(root, 'export_presets.cfg'), '[preset.0]\nname="Web"\nplatform="Web"\n[preset.0.options]\nvariant/thread_support=false\n');
  const project = initProject(root), id = 'build_delivery_fixture123';
  const directory = path.join(root, '.local/fwb/artifacts', id), stage = path.join(directory, 'project'), out = path.join(directory, 'out');
  fs.mkdirSync(stage, { recursive: true }); fs.mkdirSync(out);
  const values = { 'index.html': '<!doctype html><title>Test</title>', 'index.js': '// engine', 'index.wasm': wasmFixture(), 'index.pck': pckFixture(), ...extraFiles };
  for (const [name, bytes] of Object.entries(values)) { fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true }); fs.writeFileSync(path.join(out, name), bytes); }
  const manifest = { schemaVersion: 1, id, name: 'Test', version: '1.2.3', buildNumber: 7, target: 'web', profile: 'release', entry: 'out/index.html', status: 'built',
    outputs: Object.keys(values).map(name => ({ path: `out/${name}`, size: fs.statSync(path.join(out, name)).size, sha256: fileDigest(path.join(out, name)) })), validation: { package: 'passed', runtime: 'not-tested', platform: 'not-tested' } };
  const save = () => atomicJson(path.join(directory, 'manifest.json'), manifest); save();
  return { root, project, id, directory, stage, out, manifest, save, read: () => readArtifact(root, id) };
}

test('external assets inherit only into browsers and reject unsafe paths, duplicates and non-browser declarations', t => {
  const f = fixture(t), config = f.project.config;
  config.externalAssets = [{ source: 'media/clip.mp4', destination: 'media/clip.mp4' }];
  assert.equal(resolveExternalAssets(config, 'web').length, 1);
  assert.deepEqual(resolveExternalAssets(config, 'google-play'), []);
  assert.deepEqual(resolveExternalAssets(config, 'wechat-minigame'), []);
  config.targets.web.externalAssets = false; assert.deepEqual(resolveExternalAssets(config, 'web'), []);
  delete config.targets.web.externalAssets;
  for (const destination of ['../out.mp4', '/out.mp4', 'C:/out.mp4', 'a\\b.mp4', 'a//b.mp4', 'a/./b.mp4', 'a*.mp4']) {
    config.externalAssets[0].destination = destination; assert.throws(() => validateConfig(config), { code: 'invalid-config' });
  }
  config.externalAssets[0].destination = 'media/clip.mp4';
  config.targets.web.externalAssets = [{ source: 'other.mp4', destination: 'MEDIA/CLIP.MP4' }];
  assert.throws(() => validateConfig(config), /Duplicate/);
  delete config.targets.web.externalAssets;
  config.targets['wechat-minigame'].externalAssets = [];
  assert.throws(() => validateConfig(config), /only supported/);
});

test('external asset copying uses only snapshot bytes, reads generated manifests and never overwrites output', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'clip.mp4'), 'live source');
  fs.writeFileSync(path.join(f.stage, 'clip.mp4'), 'frozen snapshot');
  f.project.config.targets.web.externalAssetsManifest = 'external.json';
  atomicJson(path.join(f.stage, 'external.json'), { schemaVersion: 1, files: [{ source: 'clip.mp4', destination: 'media/clip.mp4' }] });
  const records = copyExternalAssets(f.project, f.stage, f.out, 'web');
  assert.equal(fs.readFileSync(path.join(f.out, 'media/clip.mp4'), 'utf8'), 'frozen snapshot');
  assert.equal(records[0].sha256, digest('frozen snapshot'));
  assert.equal(fs.readFileSync(path.join(f.root, 'clip.mp4'), 'utf8'), 'live source');
  assert.throws(() => copyExternalAssets(f.project, f.stage, f.out, 'web'), { code: 'external-asset-collision' });
  assert.throws(() => copyExternalAssets(f.project, f.root, f.out, 'web'));
  atomicJson(path.join(f.stage, 'external.json'), { schemaVersion: 1, files: [{ source: '../clip.mp4', destination: 'clip.mp4' }] });
  assert.throws(() => copyExternalAssets(f.project, f.stage, f.out, 'web'), { code: 'invalid-config' });
});

test('external assets reject linked inputs and destinations before writing output', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'clip.mp4'), 'outside');
  fs.symlinkSync(outside, path.join(f.stage, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  f.project.config.externalAssets = [{ source: 'linked/clip.mp4', destination: 'media/clip.mp4' }];
  assert.throws(() => copyExternalAssets(f.project, f.stage, f.out, 'web'), { code: 'unsafe-path' });
  fs.writeFileSync(path.join(f.stage, 'clip.mp4'), 'inside');
  f.project.config.externalAssets[0].source = 'clip.mp4';
  fs.symlinkSync(outside, path.join(f.out, 'media'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyExternalAssets(f.project, f.stage, f.out, 'web'), { code: 'unsafe-path' });
  assert.equal(fs.readFileSync(path.join(outside, 'clip.mp4'), 'utf8'), 'outside');
});

test('resource reports distinguish complete, declared startup, decoded and maximum file sizes', t => {
  const f = fixture(t, { 'media/a.mp4': Buffer.alloc(800), 'media/b.mp4': Buffer.alloc(800) });
  let report = resourceReport(f.read());
  assert.equal(report.metrics.totalBytes, f.manifest.outputs.reduce((n, file) => n + file.size, 0));
  assert.equal(report.metrics.startupBytes, report.metrics.totalBytes);
  assert.equal(report.startup.basis, 'all-outputs-conservative');
  assert.equal(report.metrics.maxFileBytes, 800);
  assert.deepEqual(report.duplicates[0].files, ['media/a.mp4', 'media/b.mp4']);
  f.manifest.startupFiles = ['index.html', 'index.js', 'index.wasm', 'index.pck']; f.save();
  report = resourceReport(f.read());
  assert.equal(report.metrics.totalBytes - report.metrics.startupBytes, 1600);
  assert.equal(report.packs[0].status, 'reported');
  assert.equal(report.packs[0].files, 0);
  const checks = resourceBudgetChecks({ budgets: { totalBytes: 1, maxFileBytes: 800, startupBytes: report.metrics.startupBytes, decodedBytes: 1 } }, report);
  assert.deepEqual(checks.map(item => item.status), ['fail', 'pass', 'pass', 'fail']);
  assert.throws(() => resourceReport({ ...f.read(), startupFiles: ['missing.file'] }), { code: 'invalid-startup-files' });
});

test('gzip resource report uses encoded download and decoded representation without counting both copies', t => {
  const f = fixture(t), descriptor = {};
  for (const name of ['index.wasm', 'index.pck']) {
    const file = path.join(f.out, name), bytes = fs.readFileSync(file), gzip = gzipSync(bytes);
    fs.unlinkSync(file); fs.writeFileSync(file + '.gz', gzip);
    descriptor[name] = { url: name + '.gz', bytes: bytes.length, compressedBytes: gzip.length, sha256: digest(bytes), gzipSha256: digest(gzip) };
    const record = f.manifest.outputs.find(item => item.path === 'out/' + name);
    Object.assign(record, { path: `out/${name}.gz`, size: gzip.length, sha256: digest(gzip) });
  }
  atomicJson(path.join(f.out, 'web-delivery.json'), { schemaVersion: 1, encoding: 'gzip', files: descriptor });
  const file = path.join(f.out, 'web-delivery.json'); f.manifest.outputs.push({ path: 'out/web-delivery.json', size: fs.statSync(file).size, sha256: fileDigest(file) }); f.save();
  const report = resourceReport(f.read());
  assert.equal(report.metrics.decodedBytes, report.metrics.totalBytes + Object.values(descriptor).reduce((n, item) => n + item.bytes - item.compressedBytes, 0));
});

test('PCK resource index reports payload type and rejects invalid bounds without extracting bytes', t => {
  const f = fixture(t), name = Buffer.from('res://art/hero.ctex\0'), indexSize = 4 + 4 + name.length + 36;
  const data = Buffer.alloc(96 + indexSize + 20); data.write('GDPC'); data.writeUInt32LE(2, 4); data.writeUInt32LE(4, 8); data.writeBigUInt64LE(BigInt(96 + indexSize), 24);
  data.writeUInt32LE(1, 96); data.writeUInt32LE(name.length, 100); name.copy(data, 104); data.writeBigUInt64LE(20n, 104 + name.length + 8);
  const filename = path.join(f.out, 'fixture.pck'); fs.writeFileSync(filename, data);
  const report = inspectPack(filename); assert.equal(report.status, 'reported'); assert.equal(report.payloadBytes, 20); assert.equal(report.byExtension[0].name, '.ctex');
  data.writeBigUInt64LE(9999n, 104 + name.length + 8); fs.writeFileSync(filename, data);
  assert.equal(inspectPack(filename).status, 'unavailable');
});

test('all resource budget dimensions are enforced by artifact validation and delivery', async t => {
  const f = fixture(t), original = readJson(path.join(f.directory, 'manifest.json'));
  f.manifest.budgets = { totalBytes: 1 }; f.save();
  const validation = await validateArtifact(f.root, f.id);
  assert.equal(validation.ok, false); assert(validation.checks.some(item => item.id === 'resource-budget:totalBytes' && item.status === 'fail'));
  await assert.rejects(deliverArtifact(f.root, f.id, { destination: 'deliveries' }), { code: 'invalid-package' });
  const log = console.log; let report;
  try { console.log = () => {}; report = await main(['resources', '--project', f.root, '--artifact', f.id]); }
  finally { console.log = log; }
  assert.equal(report.packageValidationPassed, false); assert(report.metrics.totalBytes > 1);
  atomicJson(path.join(f.directory, 'manifest.json'), original);
  assert.equal((await validateArtifact(f.root, f.id)).ok, true, 'legacy artifacts have no new implicit limit');
  f.project.config.targets.web.budgets = { startupBytes: -1 }; assert.throws(() => validateConfig(f.project.config), { code: 'invalid-config' });
});

test('staged browser configuration wires runtime and shell while excluding build metadata from the PCK', t => {
  const f = fixture(t), original = fs.readFileSync(path.join(f.root, 'export_presets.cfg'), 'utf8');
  for (const name of ['project.godot', 'export_presets.cfg']) fs.copyFileSync(path.join(f.root, name), path.join(f.stage, name));
  f.project.config.runtimeAddon = true;
  f.project.config.webShell = { enabled: true };
  f.project.config.targets.web.externalAssetsManifest = 'generated/media.json';
  const result = configureExport(f.project, f.stage, 'web', { release: true }, {});
  const source = fs.readFileSync(path.join(f.stage, 'export_presets.cfg'), 'utf8');
  assert.equal(result.shell.customShell, 'res://addons/fwb_web/fwb-shell.html');
  assert.match(sectionValue(source, 'preset.0.options', 'html/head_include'), /fwb-web\.js/);
  assert.equal(sectionValue(source, 'preset.0.options', 'html/canvas_resize_policy'), '0');
  const excluded = sectionValue(source, 'preset.0', 'exclude_filter').split(',');
  for (const item of ['.fwb-runtime-install.json', 'fwb.external-assets.json', 'generated/media.json', 'addons/fwb_web/*']) assert(excluded.includes(item), item);
  assert(sectionValue(source, 'preset.0', 'include_filter').includes('fwb.runtime.json'));
  assert.equal(fs.readFileSync(path.join(f.root, 'export_presets.cfg'), 'utf8'), original);
});

function unzip(bytes) {
  const end = bytes.length - 22, count = bytes.readUInt16LE(end + 10); let cursor = bytes.readUInt32LE(end + 16);
  const result = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), length = bytes.readUInt16LE(cursor + 28), local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + length), payload = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const decoded = inflateRawSync(bytes.subarray(payload, payload + compressed)); assert.equal(decoded.length, size);
    result.set(name, decoded); cursor += 46 + length;
  }
  return result;
}

test('streamed delivery preserves hashes and acceptance states, creates a real deflate ZIP and refuses replacement', async t => {
  const f = fixture(t, { 'media/片段.mp4': 'media bytes' });
  fs.writeFileSync(path.join(f.directory, 'build.log'), 'build fixture');
  const result = await deliverArtifact(f.root, f.id, { destination: 'deliveries', zip: true });
  const receipt = readJson(result.receipt), archive = unzip(fs.readFileSync(result.archive));
  assert.equal(receipt.archive.rootDirectory, '');
  assert(archive.has('index.html'));
  assert.equal(receipt.published, false); assert.equal(receipt.validation.runtime, 'not-tested'); assert.equal(receipt.validation.platform, 'not-tested');
  assert.equal(receipt.archive.sha256, fileDigest(result.archive)); assert.equal(receipt.version, '1.2.3');
  assert.equal(archive.get('media/片段.mp4').toString(), 'media bytes');
  assert.equal(archive.size, f.manifest.outputs.length); assert.equal(receipt.evidenceFiles.length, 2);
  assert.equal(readJson(path.join(f.root, 'deliveries/latest.json')).artifactId, f.id);
  const receiptBytes = fs.readFileSync(result.receipt);
  await assert.rejects(deliverArtifact(f.root, f.id, { destination: 'deliveries', zip: true }), { code: 'delivery-exists' });
  assert.deepEqual(fs.readFileSync(result.receipt), receiptBytes);
});

test('TapTap H5 delivery ZIP has one enclosing directory and preserves every output byte', async t => {
  const f = fixture(t, { 'media/片段.mp4': 'media bytes' });
  f.manifest.target = 'taptap-h5'; f.save();
  const result = await deliverArtifact(f.root, f.id, { destination: 'deliveries', zip: true });
  const receipt = readJson(result.receipt), archive = unzip(fs.readFileSync(result.archive));
  assert.equal(receipt.archive.rootDirectory, 'game');
  assert.equal(receipt.archive.entry, 'game/index.html');
  assert.equal(receipt.archive.maxBytes, 314572800);
  assert.equal(archive.size, f.manifest.outputs.length);
  assert.deepEqual([...new Set([...archive.keys()].map(name => name.split('/')[0]))], ['game']);
  for (const output of f.manifest.outputs) {
    assert.deepEqual(archive.get('game/' + output.path.slice(4)), fs.readFileSync(path.join(f.directory, output.path)));
  }
  assert.equal(fs.existsSync(path.join(result.directory, 'game/index.html')), true);
  assert.equal(receipt.validation.platform, 'not-tested');
});

test('TapTap H5 ZIP checks compressed size at the inclusive 300 MiB boundary and requires index.html', () => {
  const artifact = { target: 'taptap-h5', entry: 'out/index.html', outputs: [{ path: 'out/index.html' }] };
  const policy = zipPolicy(artifact);
  assert.doesNotThrow(() => validateZipSize(policy, 314572800));
  assert.throws(() => validateZipSize(policy, 314572801), { code: 'package-too-large' });
  assert.doesNotThrow(() => validateZipSize(zipPolicy({ ...artifact, target: 'web' }), 314572801));
  assert.throws(() => zipPolicy({ ...artifact, entry: 'out/play.html' }), { code: 'invalid-package' });
  assert.throws(() => zipPolicy({ ...artifact, outputs: [] }), { code: 'invalid-package' });
});

test('standalone delivery preview works without the original artifact and rejects receipt or output drift', async t => {
  const f = fixture(t, { 'clip.mp4': '0123456789' });
  const result = await deliverArtifact(f.root, f.id, { destination: 'deliveries' });
  const game = path.join(result.directory, 'game');
  fs.rmSync(f.directory, { recursive: true });
  const preview = await startDeliveryPreview(game); t.after(preview.close);
  const response = await fetch(preview.url + 'clip.mp4', { headers: { Range: 'bytes=1-3' } });
  assert.equal(response.status, 206); assert.equal(await response.text(), '123');
  const receipt = readJson(result.receipt); receipt.outputsSha256 = '0'.repeat(64); atomicJson(result.receipt, receipt);
  await assert.rejects(startDeliveryPreview(game), { code: 'invalid-delivery' });
  delete receipt.outputsSha256; atomicJson(result.receipt, receipt);
  const legacy = await startDeliveryPreview(game); await legacy.close();
  fs.writeFileSync(path.join(game, 'clip.mp4'), 'xxxxxxxxxx');
  assert.equal((await fetch(preview.url + 'clip.mp4')).status, 409);
  await assert.rejects(startDeliveryPreview(game), { code: 'changed-delivery' });
});

test('delivery hook requires structured success, records evidence and rejects output mutation before latest promotion', async t => {
  for (const mode of ['passed', 'empty', 'failed', 'mutation']) {
    const f = fixture(t);
    const script = path.join(f.stage, 'validate.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path'; const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
      ${mode === 'mutation' ? "fs.writeFileSync(path.join(args['--output'],'index.js'),'changed');" : ''}
      ${mode === 'empty' ? '' : `fs.writeFileSync(args['--report'],JSON.stringify({schemaVersion:1,ok:${mode !== 'failed'},checks:[{id:'host-package',status:'${mode === 'failed' ? 'fail' : 'pass'}'}]}));`}`);
    f.manifest.deliveryValidation = { script: 'validate.mjs', sha256: fileDigest(script) }; f.save();
    fs.mkdirSync(path.join(f.root, 'deliveries')); atomicJson(path.join(f.root, 'deliveries/latest.json'), { preserved: true });
    if (mode === 'passed') {
      const result = await deliverArtifact(f.root, f.id, { destination: 'deliveries' });
      const receipt = readJson(result.receipt); assert.equal(receipt.hostValidation.result, 'passed');
      assert(receipt.evidenceFiles.some(file => file.path === 'evidence/host-validation.json'));
    } else {
      await assert.rejects(deliverArtifact(f.root, f.id, { destination: 'deliveries' }));
      assert.deepEqual(readJson(path.join(f.root, 'deliveries/latest.json')), { preserved: true });
      assert.equal(fs.existsSync(path.join(f.root, 'deliveries', f.id)), false);
      assert.equal(fs.existsSync(path.join(f.root, 'deliveries', f.id + '.delivery.lock')), false);
    }
  }
});

test('delivery validates frozen hook dependencies, not only its entry script', async t => {
  const f = fixture(t), script = path.join(f.stage, 'validate.mjs'), helper = path.join(f.stage, 'audit.mjs');
  fs.writeFileSync(script, 'throw new Error("Must not run with changed dependencies");');
  fs.writeFileSync(helper, '// audited helper');
  const index = path.join(f.directory, 'delivery-validation-inputs.json');
  atomicJson(index, { schemaVersion: 1, exclude: [], files: ['validate.mjs', 'audit.mjs'].map(name => ({ path: name, size: fs.statSync(path.join(f.stage, name)).size, sha256: fileDigest(path.join(f.stage, name)) })) });
  f.manifest.deliveryValidation = { script: 'validate.mjs', sha256: fileDigest(script), inputs: { path: 'delivery-validation-inputs.json', sha256: fileDigest(index) } }; f.save();
  fs.writeFileSync(helper, '// changed helper');
  await assert.rejects(deliverArtifact(f.root, f.id, { destination: 'deliveries' }), { code: 'changed-validation-inputs' });
  assert.equal(fs.existsSync(path.join(f.root, 'deliveries/latest.json')), false);
});

test('streaming ZIP supports a package larger than the legacy 256 MiB memory limit', async t => {
  const f = fixture(t), filename = path.join(f.out, 'large.bin');
  const fd = fs.openSync(filename, 'w'); fs.ftruncateSync(fd, 257 * 1024 * 1024); fs.closeSync(fd);
  const archive = path.join(f.directory, 'large.zip');
  const result = await streamZip(archive, f.out, [{ path: 'large.bin', size: fs.statSync(filename).size, sha256: fileDigest(filename) }]);
  assert(result.size < 1024 * 1024, 'sparse zeros should be deflated without holding their payload in memory');
  const bytes = fs.readFileSync(archive), central = bytes.readUInt32LE(bytes.length - 6);
  assert.equal(bytes.readUInt32LE(central + 24), 257 * 1024 * 1024);
});

test('streamed ZIP writes standard CRC and refuses changed input identity', async t => {
  const f = fixture(t), filename = path.join(f.out, 'crc.txt'); fs.writeFileSync(filename, '123456789');
  const record = { path: 'crc.txt', size: 9, sha256: fileDigest(filename) };
  const zip = path.join(f.directory, 'crc.zip'); await streamZip(zip, f.out, [record]);
  const bytes = fs.readFileSync(zip), central = bytes.readUInt32LE(bytes.length - 6);
  assert.equal(bytes.readUInt32LE(central + 16), 0xcbf43926);
  fs.writeFileSync(filename, '987654321');
  await assert.rejects(streamZip(path.join(f.directory, 'changed.zip'), f.out, [record]), { code: 'changed-output' });
});

test('doctor catches excluded finalizers and delivery validators before build starts', async t => {
  const f = fixture(t), templates = path.join(f.root, 'templates'); fs.mkdirSync(templates);
  fs.writeFileSync(path.join(templates, 'version.txt'), '4.6.2.stable');
  for (const mode of ['debug', 'release']) fs.writeFileSync(path.join(templates, `web_nothreads_${mode}.zip`), 'template fixture');
  f.project.config.godot.templatesPath = templates;
  f.project.config.targets.web.finalizeScript = 'excluded/final.mjs'; f.project.config.targets.web.deliveryValidationScript = 'missing.mjs'; f.project.config.exclude = ['excluded'];
  fs.mkdirSync(path.join(f.root, 'excluded')); fs.writeFileSync(path.join(f.root, 'excluded/final.mjs'), '// existing but excluded');
  const run = createDoctor({ probe: async () => ({ ok: true, output: '4.6.2.stable.official.fixture' }), env: { FWB_HOME: path.join(f.root, 'machine') } });
  const result = await run(f.project, { target: 'web' });
  assert.equal(result.checks.find(item => item.id === 'export-finalization').status, 'fail');
  assert.equal(result.checks.find(item => item.id === 'delivery-validation').status, 'fail');
});

test('runtimeAddon false cannot silently keep an installed Godot autoload running', async t => {
  const f = fixture(t), file = path.join(f.root, 'project.godot');
  fs.appendFileSync(file, '\n[autoload]\nFwbPlatform="*res://addons/fwb/platform.gd"\n');
  const before = fs.readFileSync(file);
  f.project.config.runtimeAddon = false;
  const doctor = createDoctor({ probe: async () => ({ ok: true, output: '4.6.2.stable.official.fixture' }), env: { FWB_HOME: path.join(f.root, 'machine') } });
  const blocked = await doctor(f.project, { target: 'web' });
  assert.equal(blocked.checks.find(item => item.id === 'runtime-addon-conflict').status, 'fail');
  assert.deepEqual(fs.readFileSync(file), before, 'preflight must not uninstall or edit host files');
  f.project.config.runtimeAddon = true;
  const enabled = await doctor(f.project, { target: 'web' });
  assert.equal(enabled.checks.find(item => item.id === 'runtime-addon-conflict'), undefined);
});

test('CLI exposes delivery with explicit parent directory and optional ZIP/latest behavior', () => {
  assert.deepEqual(parseArgs(['deliver', '--project', 'game', '--artifact', 'build_fixture', '--destination', 'output', '--zip', '--no-latest']).options,
    { project: 'game', artifact: 'build_fixture', destination: 'output', zip: true, 'no-latest': true });
});
