import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDoctor, inspectExportPresets, resolvePresetName } from '../src/doctor.mjs';
import { configureExport } from '../src/core/build.mjs';
import { ensureExportPreset } from '../src/core/setup.mjs';

const target = 'wechat-minigame';
const status = (report, id) => report.checks.find(check => check.id === id)?.status;
const doctor = createDoctor({ probe: async () => ({ ok: true, output: '4.6.2.stable.official.test\n' }), env: {} });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwb-wechat-doctor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'sdk'));
  await fs.mkdir(path.join(root, 'templates'));
  await fs.writeFile(path.join(root, 'sdk/convert.mjs'), '// Test fixture only, not an engine adapter.\n');
  await fs.writeFile(path.join(root, 'validation.txt'), 'Synthetic test fixture for the proof gate; no runtime or platform acceptance.\n');
  await fs.writeFile(path.join(root, 'templates/version.txt'), '4.6.2.stable');
  for (const mode of ['debug', 'release']) await fs.writeFile(path.join(root, `templates/web_nothreads_${mode}.zip`), 'Synthetic template fixture');
  await fs.writeFile(path.join(root, 'project.godot'), '[application]\nconfig/name="WeChat test fixture"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  await fs.writeFile(path.join(root, 'export_presets.cfg'), '[preset.0]\nname="Web"\nplatform="Web"\n[preset.0.options]\nvariant/thread_support=false\nvariant/extensions_support=false\n');
  return { root, config: { schemaVersion: 1, name: 'Fixture', version: '0.1.0', buildNumber: 1,
    godot: { executable: 'godot', version: '4.6.2', templatesPath: path.join(root, 'templates') },
    targets: { [target]: { enabled: true, convertScript: 'sdk/convert.mjs', sdkPath: 'sdk', sdkVersion: 'fixture-1',
      validation: { status: 'verified', evidence: 'validation.txt', godotVersion: '4.6.2', sdkVersion: 'fixture-1' } } },
    profiles: { debug: { release: false }, release: { release: true } } },
    inspection: { runtime: 'gdscript', renderer: 'gl_compatibility', extensions: [], usesThreads: false } };
}

test('WeChat conversion preflight defaults to Web while retaining version-bound experimental acceptance', async t => {
  const project = await fixture(t), cfg = project.config.targets[target];
  assert.equal(resolvePresetName(target, cfg), 'Web');
  const report = await doctor(project, { target, profile: 'release' });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.compatibility, 'experimental');
  for (const id of ['wechat-converter', 'wechat-sdk-snapshot', 'wechat-export-platform', 'export-platform', 'export-template']) assert.equal(status(report, id), 'pass', id);
  assert.equal(status(report, 'platform-validation'), 'warning');
  cfg.validation.godotVersion = '4.5.0';
  assert.equal(status(await doctor(project, { target }), 'platform-validation'), 'fail');
  cfg.validation.godotVersion = '4.6.2'; cfg.validation.sdkVersion = 'other';
  assert.equal(status(await doctor(project, { target }), 'platform-validation'), 'fail');
  cfg.validation.sdkVersion = 'fixture-1'; cfg.validation.evidence = 'missing.txt';
  assert.equal(status(await doctor(project, { target }), 'platform-validation'), 'fail');
});

test('WeChat conversion rejects missing scripts, native presets, conflicting export platforms and external SDKs', async t => {
  const project = await fixture(t), cfg = project.config.targets[target];
  cfg.convertScript = 'sdk/missing.mjs';
  let report = await doctor(project, { target }); assert.equal(report.ok, false); assert.equal(status(report, 'wechat-converter'), 'fail');
  cfg.convertScript = 'sdk/convert.mjs'; cfg.exportPlatform = 'Custom WeChat';
  report = await doctor(project, { target }); assert.equal(report.ok, false); assert.equal(status(report, 'wechat-export-platform'), 'fail');
  delete cfg.exportPlatform; cfg.sdkPath = path.dirname(project.root);
  report = await doctor(project, { target }); assert.equal(report.ok, false); assert.equal(status(report, 'wechat-sdk-snapshot'), 'fail');
  cfg.sdkPath = 'sdk';
  await fs.writeFile(path.join(project.root, 'export_presets.cfg'), '[preset.0]\nname="Web"\nplatform="Windows Desktop"\n[preset.0.options]\n');
  report = await doctor(project, { target }); assert.equal(report.ok, false); assert.equal(status(report, 'export-platform'), 'fail');
});

test('WeChat conversion forbids linked script and SDK inputs before snapshotting', async t => {
  const project = await fixture(t), cfg = project.config.targets[target];
  await fs.mkdir(path.join(project.root, 'linked-parent'));
  try { await fs.symlink(path.join(project.root, 'sdk'), path.join(project.root, 'linked-parent/sdk'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host cannot create a test directory link.'); return; } throw error; }
  cfg.sdkPath = 'linked-parent/sdk'; cfg.convertScript = 'linked-parent/sdk/convert.mjs';
  const report = await doctor(project, { target });
  assert.equal(report.ok, false); assert.equal(status(report, 'wechat-converter'), 'fail'); assert.equal(status(report, 'wechat-sdk-snapshot'), 'fail');
});

test('existing conversion scripts excluded by snapshot rules cannot pass preflight', async t => {
  for (const [script, exclude] of [
    ['.local/convert.mjs', undefined], ['node_modules/adapter/convert.mjs', undefined],
    ['sdk/convert.mjs', ['sdk/convert.mjs']], ['tools/conversion/convert.mjs', ['tools/conversion']],
  ]) await t.test(script, async t => {
    const project = await fixture(t); project.config.targets[target].convertScript = script;
    if (exclude) project.config.exclude = exclude;
    await fs.mkdir(path.dirname(path.join(project.root, script)), { recursive: true });
    await fs.writeFile(path.join(project.root, script), '// Existing but excluded test fixture.\n');
    const report = await doctor(project, { target });
    assert.equal(report.ok, false); assert.equal(status(report, 'wechat-converter'), 'fail');
    assert.match(report.checks.find(check => check.id === 'wechat-converter').message, /被源码快照排除/);
  });
});

test('shared resource preparation uses the same real snapshot inclusion rules', async t => {
  for (const [script, exclude] of [
    ['tools/prepare.mjs', undefined], ['.local/prepare.mjs', undefined],
    ['node_modules/pipeline/prepare.mjs', undefined], ['tools/prepare.mjs', ['tools/prepare.mjs']],
  ]) await t.test(script + (exclude ? ' excluded' : ''), async t => {
    const project = await fixture(t);
    project.config.resourcePipelines = { web: { prepareScript: script } };
    if (exclude) project.config.exclude = exclude;
    await fs.mkdir(path.dirname(path.join(project.root, script)), { recursive: true });
    await fs.writeFile(path.join(project.root, script), '// Shared preparation test fixture.\n');
    const included = script === 'tools/prepare.mjs' && !exclude;
    const report = await doctor(project, { target });
    assert.equal(report.ok, included); assert.equal(status(report, 'resource-preparation'), included ? 'pass' : 'fail');
    assert.equal(status(report, 'wechat-converter'), 'pass'); assert.equal(status(report, 'wechat-sdk-snapshot'), 'pass');
    if (!included) assert.match(report.checks.find(check => check.id === 'resource-preparation').message, /被源码快照排除/);
  });
});

test('SDK preflight requires a nonempty fully included directory including nested dependencies', async t => {
  for (const [sdkPath, dependency, exclude, expectedReason] of [
    ['empty-sdk', null, undefined, /目录为空/],
    ['.local/sdk', 'engine.js', undefined, /被源码快照排除/],
    ['node_modules/sdk', 'engine.js', undefined, /被源码快照排除/],
    ['vendored-sdk', 'engine.js', ['vendored-sdk'], /被源码快照排除/],
    ['sdk', 'runtime/engine.js', ['sdk/runtime/engine.js'], /runtime\/engine\.js/],
    ['sdk', 'node_modules/dependency/loader.js', undefined, /node_modules\/dependency\/loader\.js/],
  ]) await t.test(sdkPath + '/' + dependency, async t => {
    const project = await fixture(t); project.config.targets[target].sdkPath = sdkPath;
    if (exclude) project.config.exclude = exclude;
    await fs.mkdir(path.join(project.root, sdkPath), { recursive: true });
    if (dependency) {
      await fs.mkdir(path.dirname(path.join(project.root, sdkPath, dependency)), { recursive: true });
      await fs.writeFile(path.join(project.root, sdkPath, dependency), '// SDK dependency fixture.\n');
    }
    const report = await doctor(project, { target });
    assert.equal(report.ok, false); assert.equal(status(report, 'wechat-sdk-snapshot'), 'fail');
    assert.equal(status(report, 'wechat-converter'), 'pass'); assert.equal(status(report, 'platform-sdk'), 'pass');
    assert.match(report.checks.find(check => check.id === 'wechat-sdk-snapshot').message, expectedReason);
  });
});

test('conversion setup adds one Web preset and staged export records web/index.html without changing source', async t => {
  const project = await fixture(t);
  const source = '[preset.0]\nname="Other native"\nplatform="Windows Desktop"\n[preset.0.options]\n';
  await fs.writeFile(path.join(project.root, 'export_presets.cfg'), source);
  const setup = await ensureExportPreset(project, target);
  assert.equal(setup.created, true); assert.equal(setup.name, 'Web');
  const before = await fs.readFile(path.join(project.root, 'export_presets.cfg'), 'utf8'); assert.ok(before.startsWith(source));
  assert.equal((await ensureExportPreset(project, target)).created, false);
  assert.equal(await fs.readFile(path.join(project.root, 'export_presets.cfg'), 'utf8'), before);
  const presets = await inspectExportPresets(project.root); assert.deepEqual(presets.map(preset => [preset.name, preset.platform]), [['Other native', 'Windows Desktop'], ['Web', 'Web']]);
  const stage = path.join(project.root, 'stage'); await fs.mkdir(stage);
  for (const file of ['project.godot', 'export_presets.cfg']) await fs.copyFile(path.join(project.root, file), path.join(stage, file));
  const exported = configureExport(project, stage, target, { release: true }, { templates: {} });
  assert.deepEqual(exported, { filename: 'index.html', preset: 'Web', web: true });
  assert.match(await fs.readFile(path.join(stage, 'export_presets.cfg'), 'utf8'), /export_path="\.\.\/web\/index.html"/);
  assert.equal(await fs.readFile(path.join(project.root, 'export_presets.cfg'), 'utf8'), before);
});

test('custom WeChat preset route remains distinct and never auto-creates a fake native adapter preset', async t => {
  const project = await fixture(t), cfg = project.config.targets[target]; delete cfg.convertScript;
  assert.equal(resolvePresetName(target, cfg), 'WeChat');
  await assert.rejects(ensureExportPreset(project, target), { code: 'adapter-required' });
  cfg.preset = 'Reviewed adapter'; cfg.exportPlatform = 'Custom WeChat';
  await fs.writeFile(path.join(project.root, 'export_presets.cfg'), '[preset.0]\nname="Reviewed adapter"\nplatform="Custom WeChat"\n[preset.0.options]\n');
  const report = await doctor(project, { target }); assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(status(report, 'wechat-converter'), undefined); assert.equal(status(report, 'platform-validation'), 'warning');
  const stage = path.join(project.root, 'stage'); await fs.mkdir(stage);
  await fs.copyFile(path.join(project.root, 'export_presets.cfg'), path.join(stage, 'export_presets.cfg'));
  assert.deepEqual(configureExport(project, stage, target, { release: true }, { templates: {} }), { filename: 'game.zip', preset: 'Reviewed adapter', web: false });
});
