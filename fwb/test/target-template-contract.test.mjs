import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, inputFiles } from '../src/core/project.mjs';
import { createDoctor, resolvePresetName } from '../src/doctor.mjs';
import { buildProject, configureExport, exportTemplatePaths, readArtifact } from '../src/core/build.mjs';
import { ensureExportPreset } from '../src/core/setup.mjs';
import { fileDigest, sectionValue } from '../src/core/files.mjs';

const target = 'wechat-minigame';
const check = (report, id) => report.checks.find(item => item.id === id);
const preset = '[preset.0]\nname="Web"\nplatform="Web"\n[preset.0.options]\nvariant/thread_support=false\nvariant/extensions_support=false\n';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-target-template-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'game');
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
  };
  write('project.godot', '[application]\nconfig/name="Target and template fixture"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  write('export_presets.cfg', preset);
  write('sdk/convert.mjs', '// Synthetic fixture; no engine conversion.\n');
  write('sdk/release.zip', 'frozen-sdk-template');
  write('proof.txt', 'Synthetic proof gate fixture, not runtime acceptance.\n');
  const templates = path.join(directory, 'system-templates'); fs.mkdirSync(templates);
  fs.writeFileSync(path.join(templates, 'version.txt'), '4.6.2.stable');
  for (const mode of ['debug', 'release']) fs.writeFileSync(path.join(templates, `web_nothreads_${mode}.zip`), 'external-template-' + mode);
  const project = initProject(root, { godotVersion: '4.6.2' });
  project.config.godot.templatesPath = templates;
  const config = project.config.targets[target];
  Object.assign(config, { sdkPath: 'sdk', sdkVersion: 'fixture-1',
    validation: { status: 'verified', godotVersion: '4.6.2', sdkVersion: 'fixture-1', evidence: 'proof.txt' } });
  const doctor = createDoctor({ probe: async () => ({ ok: true, output: '4.6.2.stable.official.fixture\n' }), env: { FWB_HOME: path.join(directory, 'machine') } });
  const snapshot = () => {
    const stage = path.join(directory, 'snapshot'); fs.mkdirSync(stage);
    for (const relative of inputFiles(root, project.config)) {
      const output = path.join(stage, relative); fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(path.join(root, relative), output);
    }
    return stage;
  };
  return { root, project, config, templates, doctor, write, snapshot };
}

test('init uses route defaults for mini-games and adding a converter reuses the existing Web preset', async t => {
  const f = fixture(t);
  assert.equal(f.config.preset, undefined);
  assert.equal(resolvePresetName(target, f.config), 'WeChat');
  assert.equal(f.project.config.targets['douyin-minigame'].preset, undefined);
  assert.equal(resolvePresetName('douyin-minigame', f.project.config.targets['douyin-minigame']), 'Douyin');
  f.config.convertScript = 'sdk/convert.mjs';
  assert.equal(resolvePresetName(target, f.config), 'Web');
  const before = fs.readFileSync(path.join(f.root, 'export_presets.cfg'), 'utf8');
  assert.equal((await ensureExportPreset(f.project, target)).created, false);
  assert.equal(fs.readFileSync(path.join(f.root, 'export_presets.cfg'), 'utf8'), before);
  const report = await f.doctor(f.project, { target, profile: 'release' });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
});

test('existing explicit presets remain authoritative across init and route changes', t => {
  const f = fixture(t);
  f.config.preset = 'User reviewed preset';
  f.config.convertScript = 'sdk/convert.mjs';
  f.write('fwb.project.json', JSON.stringify(f.project.config));
  const initialized = initProject(f.root);
  assert.equal(initialized.created, false);
  assert.equal(resolvePresetName(target, initialized.config.targets[target]), 'User reviewed preset');
});

test('doctor distinguishes unknown, unconfigured and disabled targets without enabling omitted entries', async t => {
  const f = fixture(t); f.project.config.targets = { web: { preset: 'Web' } };
  const missing = await f.doctor(f.project, { target: 'taptap-h5' });
  assert.equal(missing.ok, false); assert.equal(check(missing, 'target-configured').status, 'fail');
  assert.equal(check(missing, 'target-enabled'), undefined);
  const unknown = await f.doctor(f.project, { target: 'does-not-exist' });
  assert.equal(unknown.ok, false); assert.equal(check(unknown, 'target').status, 'fail');
  const configured = await f.doctor(f.project, { target: 'web' });
  assert.equal(configured.ok, true, JSON.stringify(configured.checks));
  f.project.config.targets.web.enabled = false;
  const disabled = await f.doctor(f.project, { target: 'web' });
  assert.equal(disabled.ok, false); assert.equal(check(disabled, 'target-enabled').status, 'fail');
});

test('the build entry stops unknown and unconfigured targets at preflight before importing or exporting', async t => {
  const f = fixture(t); f.project.config.targets = { web: { preset: 'Web' } };
  f.write('fwb.project.json', JSON.stringify(f.project.config));
  for (const [requested, expected] of [['taptap-h5', 'target-configured'], ['does-not-exist', 'target']]) {
    await assert.rejects(buildProject(f.root, { target: requested }), error => {
      assert.equal(error.code, 'preflight-failed');
      const artifact = readArtifact(f.root, error.artifactId);
      assert.equal(artifact.status, 'failed');
      assert.equal(check(artifact.diagnosis, expected).status, 'fail');
      assert.equal(artifact.source, undefined);
      assert.equal(artifact.outputs.length, 0);
      return true;
    });
  }
});

test('project SDK templates use frozen bytes and the toolchain resolves the same path as the staged preset', async t => {
  const f = fixture(t); f.config.convertScript = 'sdk/convert.mjs';
  f.write('export_presets.cfg', preset + 'custom_template/release="res://sdk/release.zip"\n');
  const report = await f.doctor(f.project, { target, profile: 'release' });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(check(report, 'export-template-snapshot').status, 'pass');
  const stage = f.snapshot();
  const frozenHash = fileDigest(path.join(stage, 'sdk/release.zip'));
  f.write('sdk/release.zip', 'changed-live-template');
  configureExport(f.project, stage, target, { release: true }, report);
  const configuredPath = sectionValue(fs.readFileSync(path.join(stage, 'export_presets.cfg'), 'utf8'), 'preset.0.options', 'custom_template/release');
  const toolchainPath = exportTemplatePaths(f.project, stage, report.templates).release;
  assert.equal(path.resolve(configuredPath), path.join(stage, 'sdk/release.zip'));
  assert.equal(path.resolve(configuredPath), toolchainPath);
  assert.equal(fileDigest(toolchainPath), frozenHash);
  assert.notEqual(fileDigest(toolchainPath), fileDigest(path.join(f.root, 'sdk/release.zip')));
  assert.equal(report.templates.release, path.join(f.root, 'sdk/release.zip'));
});

test('external system templates retain their existing paths while project defaults are staged', async t => {
  const f = fixture(t);
  let report = await f.doctor(f.project, { target: 'web', profile: 'release' });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  const stage = f.snapshot();
  configureExport(f.project, stage, 'web', { release: true }, report);
  const actual = sectionValue(fs.readFileSync(path.join(stage, 'export_presets.cfg'), 'utf8'), 'preset.0.options', 'custom_template/release');
  assert.equal(path.resolve(actual), path.join(f.templates, 'web_nothreads_release.zip'));
  assert.equal(check(report, 'export-template-snapshot'), undefined);
  f.write('local-templates/version.txt', '4.6.2.stable');
  f.write('local-templates/web_nothreads_release.zip', 'local-release-template');
  f.project.config.godot.templatesPath = 'local-templates';
  report = await f.doctor(f.project, { target: 'web', profile: 'release' });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(check(report, 'export-template-snapshot').status, 'pass');
  assert.equal(exportTemplatePaths(f.project, stage, report.templates).release, path.join(stage, 'local-templates/web_nothreads_release.zip'));
});

test('active project templates excluded from the snapshot cannot pass doctor', async t => {
  for (const [template, exclude] of [['sdk/release.zip', ['sdk/release.zip']], ['.local/release.zip', undefined], ['node_modules/adapter/release.zip', undefined]]) {
    await t.test(template, async t => {
      const f = fixture(t);
      f.write(template, 'excluded-template');
      f.write('export_presets.cfg', preset + `custom_template/release=${JSON.stringify('res://' + template)}\n`);
      if (exclude) f.project.config.exclude = exclude;
      const report = await f.doctor(f.project, { target: 'web', profile: 'release' });
      assert.equal(check(report, 'export-template').status, 'pass');
      assert.equal(report.ok, false); assert.equal(check(report, 'export-template-snapshot').status, 'fail');
    });
  }
});
