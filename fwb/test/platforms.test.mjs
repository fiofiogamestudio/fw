import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { targets, getTarget } from '../src/platforms.mjs';
import { createDoctor, inspectExportPresets, parseGodotVersion, probeTool, resolveAndroidGradleDirectory } from '../src/doctor.mjs';
import { configureExport } from '../src/core/build.mjs';

const versionOutput = '4.6.2.stable.official.012345678\n';
const probe = async (file) => ({ ok: true, output: file.includes('javac') ? 'javac 17.0.12' : versionOutput });

async function fixture(t, { target = 'web', platform = 'Web', options = '', version = '4.6.2.stable', files } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwb-platform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const templatesPath = path.join(root, 'templates');
  await mkdir(templatesPath);
  await writeFile(path.join(root, 'project.godot'), '[application]\nconfig/name="fixture"\n');
  await writeFile(path.join(root, 'export_presets.cfg'), `[preset.0]\nname="Fixture"\nplatform="${platform}"\n[preset.0.options]\nvariant/thread_support=false\nvariant/extensions_support=false\n${options}\n`);
  await writeFile(path.join(templatesPath, 'version.txt'), version);
  for (const file of files || ['web_nothreads_debug.zip', 'web_nothreads_release.zip', 'android_debug.apk', 'android_release.apk', 'ios.zip']) await writeFile(path.join(templatesPath, file), 'nonempty test fixture, not a real export template');
  return { root, config: { schemaVersion: 1, name: 'Fixture', version: '0.1.0', buildNumber: 1,
    godot: { executable: 'godot', version: '4.6.2', templatesPath },
    targets: { [target]: { enabled: true, preset: 'Fixture' } }, profiles: { debug: { release: false }, release: { release: true } } },
  inspection: { runtime: 'gdscript', renderer: 'gl_compatibility', extensions: [], usesThreads: false } };
}

function status(result, id) { return result.checks.find((check) => check.id === id)?.status; }

test('target catalog exposes seven routes with one TapTap route and immutable source records', () => {
  assert.equal(targets.length, 7);
  assert.equal(new Set(targets.map((item) => item.id)).size, 7);
  assert.equal(getTarget('wechat-minigame').status, 'unverified');
  assert.equal(getTarget('taptap-h5').family, 'web');
  assert.equal(getTarget('taptap-h5').label, 'TapTap（App 内即玩）');
  assert.deepEqual(targets.filter(item => item.id.startsWith('taptap-')).map(item => item.id), ['taptap-h5']);
  assert.equal(getTarget('taptap-minigame'), undefined);
  assert.equal(getTarget('unknown'), undefined);
  assert.ok(targets.every((item) => item.sources.every((source) => source.startsWith('https://'))));
  assert.throws(() => { getTarget('web').requirements.push('changed'); }, TypeError);
});

test('TapTap H5 remains an experimental Web candidate with client acceptance pending', async t => {
  const project = await fixture(t, { target: 'taptap-h5' });
  const result = await createDoctor({ probe, env: {} })(project, { target: 'taptap-h5' });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.compatibility, 'experimental');
  assert.equal(status(result, 'platform-validation'), 'warning');
});

test('retired TapTap doctor points to H5 without probing the engine', async t => {
  const project = await fixture(t, { target: 'taptap-minigame' });
  let calls = 0;
  const result = await createDoctor({ probe: async () => { calls++; return probe('godot'); }, env: {} })(project, { target: 'taptap-minigame' });
  assert.equal(result.ok, false);
  assert.equal(status(result, 'target'), 'fail');
  assert.match(result.checks.find(check => check.id === 'target').message, /taptap-h5/);
  assert.equal(calls, 0);
});

test('version parser handles Godot patchless/mono versions but rejects unrelated tools', () => {
  assert.equal(parseGodotVersion('4.5.stable.official.abcdef').number, '4.5.0');
  assert.equal(parseGodotVersion('4.6.2.stable.mono.official.abcdef').templateVersion, '4.6.2.stable.mono');
  assert.equal(parseGodotVersion('v22.3.0'), undefined);
  assert.equal(parseGodotVersion('4.6.2.stable.' + 'a'.repeat(200)), undefined);
});

test('ordinary single-threaded Web reports compatible and returns resolved templates', async (t) => {
  const project = await fixture(t);
  const result = await createDoctor({ probe, env: {} })(project);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.compatibility, 'compatible');
  assert.equal(result.engine.templatesPath, project.config.godot.templatesPath);
  assert.equal(result.templates.debug, path.join(project.config.godot.templatesPath, 'web_nothreads_debug.zip'));
});

test('Web blocks C# and unsupported rendering instead of silently changing project', async (t) => {
  const project = await fixture(t);
  project.inspection.runtime = 'csharp';
  project.inspection.renderer = 'mobile';
  const result = await createDoctor({ probe, env: {} })(project);
  assert.equal(status(result, 'runtime'), 'fail');
  assert.equal(status(result, 'renderer'), 'fail');
  assert.equal(result.compatibility, 'blocked');
});

test('missing template and mismatched FWC engine block export', async (t) => {
  const project = await fixture(t, { files: ['web_nothreads_release.zip'] });
  project.inspection.fwc = { requiredGodotVersion: '4.5.0' };
  const result = await createDoctor({ probe, env: {} })(project);
  assert.equal(status(result, 'export-template'), 'fail');
  assert.equal(status(result, 'fwc-godot-version'), 'fail');
});

test('custom release template is selected independently of debug template', async (t) => {
  const project = await fixture(t, { files: [], options: 'custom_template/release="res://custom-release.zip"' });
  await writeFile(path.join(project.root, 'custom-release.zip'), 'fixture');
  const result = await createDoctor({ probe, env: {} })(project, { profile: 'release' });
  assert.equal(result.ok, true);
  assert.equal(result.templates.release, path.join(project.root, 'custom-release.zip'));
});

test('templates version mismatch blocks even if files exist', async (t) => {
  const project = await fixture(t, { version: '4.5.stable' });
  const result = await createDoctor({ probe, env: {} })(project);
  assert.equal(status(result, 'template-version'), 'fail');
});

test('stable version requirement does not silently accept prerelease engine', async (t) => {
  const project = await fixture(t);
  const result = await createDoctor({ probe: async () => ({ ok: true, output: '4.6.2.rc1.official.abcdef' }), env: {} })(project);
  assert.equal(status(result, 'godot-version'), 'fail');
});

test('built-in target platform cannot be redirected through exportPlatform', async (t) => {
  const project = await fixture(t, { platform: 'Android' });
  project.config.targets.web.exportPlatform = 'Android';
  const result = await createDoctor({ probe, env: {} })(project);
  assert.equal(status(result, 'export-platform'), 'fail');
});

test('Poki requires a bridge and its single-threaded baseline', async (t) => {
  const project = await fixture(t, { target: 'poki' });
  const run = createDoctor({ probe, env: {} });
  assert.equal(status(await run(project, { target: 'poki' }), 'poki-sdk'), 'fail');
  project.config.runtimeAddon = true;
  const result = await run(project, { target: 'poki' });
  assert.equal(result.ok, true);
  assert.equal(result.compatibility, 'experimental');
  assert.equal(status(result, 'poki-sdk'), 'warning');
  project.inspection.usesThreads = true;
  assert.equal(status(await run(project, { target: 'poki' }), 'threads'), 'fail');
});

test('WeChat mini-games remain blocked without version-bound evidence', async (t) => {
  const target = 'wechat-minigame';
  const project = await fixture(t, { target });
  const cfg = project.config.targets[target];
  cfg.exportPlatform = 'Web';
  cfg.sdkPath = 'sdk';
  cfg.sdkVersion = '1.2.3';
  await mkdir(path.join(project.root, 'sdk'));
  await writeFile(path.join(project.root, 'acceptance.md'), 'Human-owned device and exporter evidence.');
  const run = createDoctor({ probe, env: {} });
  assert.equal(status(await run(project, { target }), 'platform-validation'), 'fail');
  cfg.validation = { status: 'verified', evidence: 'acceptance.md', godotVersion: '4.6.2', sdkVersion: '1.2.2' };
  assert.equal(status(await run(project, { target }), 'platform-validation'), 'fail');
  cfg.validation.sdkVersion = '1.2.3';
  const result = await run(project, { target });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.compatibility, 'experimental');
  cfg.validation.evidence = 'missing.md';
  assert.equal(status(await run(project, { target }), 'platform-validation'), 'fail');
});

test('Douyin rejects unsupported engine, extensions and threads', async (t) => {
  const project = await fixture(t, { target: 'douyin-minigame' });
  project.inspection.extensions = ['addon.gdextension'];
  project.inspection.usesThreads = true;
  const result = await createDoctor({ probe, env: {} })(project, { target: 'douyin-minigame' });
  assert.equal(status(result, 'douyin-version'), 'fail');
  assert.equal(status(result, 'extensions'), 'fail');
  assert.equal(status(result, 'threads'), 'fail');
});

test('Web extension chooses dlink_nothreads templates and blocks absent release library', async (t) => {
  const project = await fixture(t, { options: 'variant/extensions_support=true', files: ['web_dlink_nothreads_debug.zip', 'web_dlink_nothreads_release.zip'] });
  project.inspection.extensions = ['example.gdextension'];
  await writeFile(path.join(project.root, 'example.gdextension'), '[libraries]\nweb.debug.wasm32="example.wasm"\n');
  await writeFile(path.join(project.root, 'example.wasm'), 'fixture');
  const run = createDoctor({ probe, env: {} });
  const debug = await run(project);
  assert.equal(debug.ok, true);
  assert.equal(debug.compatibility, 'experimental');
  assert.ok(debug.templates.debug.endsWith('web_dlink_nothreads_debug.zip'));
  assert.equal(status(await run(project, { profile: 'release' }), 'extension-web-0'), 'fail');
});

test('duplicate and mismatched export presets are rejected without revealing credentials', async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.root, 'export_presets.cfg'), '[preset.0]\nname="Fixture"\nplatform="Android"\n[preset.0.options]\nkeystore/release_password="DO_NOT_REPORT"\n');
  const run = createDoctor({ probe, env: {} });
  const result = await run(project);
  assert.equal(status(result, 'export-platform'), 'fail');
  assert.ok(!JSON.stringify(result).includes('DO_NOT_REPORT'));
  const presets = await inspectExportPresets(project.root);
  assert.ok(!JSON.stringify(presets).includes('DO_NOT_REPORT'));
  await writeFile(path.join(project.root, 'export_presets.cfg'), '[preset.0]\nname="Fixture"\nplatform="Web"\n[preset.1]\nname="Fixture"\nplatform="Web"\n');
  assert.equal(status(await run(project), 'export-preset'), 'fail');
});

test('unknown and disabled targets and missing profile fail clearly', async (t) => {
  const project = await fixture(t);
  const run = createDoctor({ probe, env: {} });
  assert.equal(status(await run(project, { target: 'missing' }), 'target'), 'fail');
  project.config.targets.web.enabled = false;
  assert.equal(status(await run(project), 'target-enabled'), 'fail');
  assert.equal(status(await run(project, { profile: 'missing' }), 'profile'), 'fail');
});

test('Android checks SDK packages and JDK, keeps signing values private', async (t) => {
  const project = await fixture(t, { target: 'google-play', platform: 'Android', options: 'gradle_build/use_gradle_build=true\ngradle_build/export_format=1' });
  const sdk = path.join(project.root, 'android-sdk');
  for (const [directory, name] of [['platform-tools', 'adb'], ['build-tools/35.0.1', 'aapt2'], ['platforms/android-35', 'android.jar']]) {
    await mkdir(path.join(sdk, directory), { recursive: true });
    await writeFile(path.join(sdk, directory, name), 'fixture');
  }
  await mkdir(path.join(project.root, 'android', 'build'), { recursive: true });
  await writeFile(path.join(project.root, 'android', 'build', 'build.gradle'), '// fixture');
  const key = path.join(project.root, 'test-signing.fixture');
  await writeFile(key, 'fixture');
  const env = { ANDROID_HOME: sdk, GODOT_ANDROID_KEYSTORE_RELEASE_PATH: key, GODOT_ANDROID_KEYSTORE_RELEASE_USER: 'PRIVATE_ALIAS', GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD: 'PRIVATE_PASSWORD' };
  const result = await createDoctor({ probe, env, hostPlatform: 'linux' })(project, { target: 'google-play', profile: 'release' });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(status(result, 'android-signing'), 'pass');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PASSWORD'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_ALIAS'));
  delete env.GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD;
  const blocked = await createDoctor({ probe, env, hostPlatform: 'linux' })(project, { target: 'google-play', profile: 'release' });
  assert.equal(status(blocked, 'android-signing'), 'fail');
});

test('iOS blocks on non-Mac and checks Xcode plus iPhoneOS SDK on Mac', async (t) => {
  const project = await fixture(t, { target: 'app-store', platform: 'iOS' });
  const blocked = await createDoctor({ probe, env: {}, hostPlatform: 'win32' })(project, { target: 'app-store' });
  assert.equal(status(blocked, 'macos'), 'fail');
  const calls = [];
  const macProbe = async (file, args) => { calls.push([file, args]); return file === 'xcrun' ? { ok: false, output: '' } : probe(file); };
  const mac = await createDoctor({ probe: macProbe, env: {}, hostPlatform: 'darwin' })(project, { target: 'app-store' });
  assert.equal(status(mac, 'macos'), 'pass');
  assert.equal(status(mac, 'xcode'), 'pass');
  assert.equal(status(mac, 'iphoneos-sdk'), 'fail');
  assert.ok(calls.some(([file]) => file === 'xcrun'));
});

test('real process probe handles success, missing executable, output limits and timeout', async () => {
  const success = await probeTool(process.execPath, ['--version']);
  assert.equal(success.ok, true);
  const missing = await probeTool('fwb-nonexistent-tool-130af138', ['--version']);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'ENOENT');
  const large = await probeTool(process.execPath, ['-e', 'process.stdout.write("x".repeat(50000))'], { maxBytes: 128 });
  assert.equal(large.reason, 'output-limit');
  assert.ok(large.output.length <= 128);
  const timed = await probeTool(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 150 });
  assert.equal(timed.reason, 'timeout');
});

test('probe failure never includes arbitrary child output in the report', async (t) => {
  const project = await fixture(t);
  const result = await createDoctor({ probe: async () => ({ ok: false, reason: 'exit-code', output: 'PRIVATE_TOKEN' }), env: {} })(project);
  assert.equal(status(result, 'godot'), 'fail');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
});

test('omitted preset uses the same Web default in doctor and staged export', async t => {
  const project = await fixture(t);
  project.config.targets.web = { enabled: true };
  const presetText = '[preset.0]\nname="Web"\nplatform="Web"\n[preset.0.options]\nvariant/thread_support=false\n';
  await writeFile(path.join(project.root, 'export_presets.cfg'), presetText);
  const diagnosis = await createDoctor({ probe, env: {} })(project);
  assert.equal(diagnosis.ok, true);
  const stage = path.join(project.root, 'isolated-project');
  await mkdir(stage);
  await writeFile(path.join(stage, 'project.godot'), await readFile(path.join(project.root, 'project.godot')));
  await writeFile(path.join(stage, 'export_presets.cfg'), presetText);
  const exported = configureExport(project, stage, 'web', project.config.profiles.debug, diagnosis);
  assert.equal(exported.preset, 'Web');
  assert.match(await readFile(path.join(stage, 'export_presets.cfg'), 'utf8'), /export_path="\.\.\/out\/index\.html"/);
  assert.equal(await readFile(path.join(project.root, 'export_presets.cfg'), 'utf8'), presetText);
});

test('Android Gradle template checks follow the selected directory and do not require unused APK templates', async t => {
  const project = await fixture(t, { target: 'google-play', platform: 'Android', files: [], options: 'gradle_build/use_gradle_build=true\ngradle_build/gradle_build_directory="res://platform/mobile"' });
  await mkdir(path.join(project.root, 'platform/mobile/build'), { recursive: true });
  await writeFile(path.join(project.root, 'platform/mobile/build/build.gradle.kts'), '// selected Gradle template');
  const run = createDoctor({ probe, env: {} });
  const found = await run(project, { target: 'google-play' });
  assert.equal(status(found, 'android-gradle-path'), 'pass');
  assert.equal(status(found, 'android-gradle-template'), 'pass');
  assert.equal(status(found, 'export-template'), undefined);
  assert.deepEqual(found.templates, {});
  await rm(path.join(project.root, 'platform/mobile/build/build.gradle.kts'));
  await mkdir(path.join(project.root, 'android/build'), { recursive: true });
  await writeFile(path.join(project.root, 'android/build/build.gradle'), '// unrelated default directory');
  const missing = await run(project, { target: 'google-play' });
  assert.equal(status(missing, 'android-gradle-template'), 'fail');
});

test('Android Gradle path rejects absolute paths and traversal during preflight', async t => {
  const project = await fixture(t, { target: 'google-play', platform: 'Android' });
  const run = createDoctor({ probe, env: {} });
  for (const value of ['D:/outside/android', '/outside/android', '../android', 'res://../android', 'res://android/../../outside']) {
    await writeFile(path.join(project.root, 'export_presets.cfg'), `[preset.0]\nname="Fixture"\nplatform="Android"\n[preset.0.options]\ngradle_build/use_gradle_build=true\ngradle_build/gradle_build_directory=${JSON.stringify(value)}\n`);
    const result = await run(project, { target: 'google-play' });
    assert.equal(status(result, 'android-gradle-path'), 'fail', value);
    assert.equal(result.ok, false);
  }
});

test('Android Gradle rejects a directory junction including inside the stage', async t => {
  const project = await fixture(t, { target: 'google-play', platform: 'Android', options: 'gradle_build/use_gradle_build=true\ngradle_build/gradle_build_directory="linked"' });
  await mkdir(path.join(project.root, 'real/build'), { recursive: true });
  await symlink(path.join(project.root, 'real'), path.join(project.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await createDoctor({ probe, env: {} })(project, { target: 'google-play' });
  assert.equal(status(result, 'android-gradle-path'), 'fail');
  assert.throws(() => resolveAndroidGradleDirectory(project.root, 'linked'), /links|junctions/i);
});

test('Android staged export normalizes safe Gradle paths and leaves the source preset intact', async t => {
  const project = await fixture(t, { target: 'google-play', platform: 'Android', options: 'gradle_build/use_gradle_build=true\ngradle_build/gradle_build_directory="platform/mobile"' });
  const source = await readFile(path.join(project.root, 'export_presets.cfg'), 'utf8');
  const stage = path.join(project.root, 'isolated-project');
  await mkdir(stage);
  await writeFile(path.join(stage, 'export_presets.cfg'), source);
  configureExport(project, stage, 'google-play', project.config.profiles.debug, {});
  const preset = (await inspectExportPresets(stage))[0];
  assert.equal(preset.options['gradle_build/gradle_build_directory'], 'res://platform/mobile');
  assert.equal(resolveAndroidGradleDirectory(stage, preset.options['gradle_build/gradle_build_directory']).buildDirectory, path.join(stage, 'platform/mobile/build'));
  assert.equal(await readFile(path.join(project.root, 'export_presets.cfg'), 'utf8'), source);
  await writeFile(path.join(stage, 'export_presets.cfg'), source.replace('platform/mobile', '../outside'));
  assert.throws(() => configureExport(project, stage, 'google-play', project.config.profiles.debug, {}), /relative|traversal/i);
});
