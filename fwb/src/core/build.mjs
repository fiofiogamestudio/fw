import fs from 'node:fs';
import path from 'node:path';
import { resolveEnvironment } from './environment.mjs';
import { prepareAndroidTools } from './android-tools.mjs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readProject, inputFiles } from './project.mjs';
import { atomicJson, child, digest, fail, fileDigest, outputsFingerprint, physicalPath, readJson, sectionValue, walk } from './files.mjs';
import { runProcess } from './process.mjs';
import { doctor, resolveAndroidGradleDirectory, resolvePresetName } from '../doctor.mjs';
import { validateNativeOutputs } from './native-validation.mjs';
import { getTarget, retiredTargetMessage } from '../platforms.mjs';
import { validateWebDelivery } from './web-delivery.mjs';
import { resolveResourcePreparation } from './resource-pipeline.mjs';
import { convertMinigame, usesWebConversion, validateMinigameOutputs } from './minigame-export.mjs';
import { runGodotProcess } from './godot-process.mjs';
import { fwcExportFilters, readFwcLayout } from './fw-layout.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const artifactRoot = root => child(root, '.local/fwb/artifacts');
const artifactDirectory = (root, id) => {
  if (!/^build_[a-zA-Z0-9_-]{10,100}$/.test(id)) fail('invalid-artifact-id', 'Invalid build artifact ID.');
  return child(artifactRoot(root), id);
};
const store = (directory, manifest) => atomicJson(path.join(directory, 'manifest.json'), manifest);

export function readArtifact(root, id) {
  const directory = artifactDirectory(root, id);
  const manifest = readJson(child(directory, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.id !== id || !Array.isArray(manifest.outputs)) fail('invalid-artifact', 'Invalid artifact manifest.');
  return { ...manifest, directory };
}

export function listArtifacts(root) {
  const directory = artifactRoot(root);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory() && !item.isSymbolicLink() && /^build_/.test(item.name)).slice(-1000).map(item => {
    try { return readArtifact(root, item.name); }
    catch { return { id: item.name, status: 'invalid', error: 'Artifact manifest is unreadable.' }; }
  }).sort((a, b) => String(b.createdAt ?? b.id).localeCompare(String(a.createdAt ?? a.id)));
}

export function readArtifactLog(root, id) {
  const artifact = readArtifact(root, id);
  const file = child(artifact.directory, 'build.log');
  if (!fs.existsSync(file)) return '';
  const fd = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(fd).size; const buffer = Buffer.alloc(Math.min(size, 128 * 1024)); fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length)); return buffer.toString('utf8'); }
  finally { fs.closeSync(fd); }
}

function lockBuild(root) {
  const file = child(root, '.local/fwb/build.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') fail('build-busy', `A build lock exists: ${file}. If its process has exited, inspect and remove this one lock file before retrying.`);
    throw error;
  }
  return () => { if (fs.existsSync(file) && readJson(file).token === token) fs.unlinkSync(file); };
}

export function setSetting(source, section, key, value) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(line => line.trim() === `[${section}]`);
  const setting = `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`;
  if (start < 0) return `${source.trimEnd()}\n\n[${section}]\n${setting}\n`;
  let end = lines.findIndex((line, index) => index > start && /^\[/.test(line.trim()));
  if (end < 0) end = lines.length;
  const found = lines.findIndex((line, index) => index > start && index < end && line.slice(0, line.indexOf('=')).trim() === key);
  if (found >= 0) lines[found] = setting; else lines.splice(end, 0, setting);
  return lines.join('\n');
}

function presetSection(source, name) {
  const ids = [...source.matchAll(/^\[preset\.(\d+)\]\s*$/gm)].map(match => `preset.${match[1]}`);
  const found = ids.filter(id => sectionValue(source, id, 'name') === name);
  if (found.length !== 1) fail('invalid-preset', `Expected exactly one export preset named ${name}.`);
  return found[0];
}

function copySnapshot(project, stage) {
  const files = inputFiles(project.root, project.config);
  const records = [];
  for (const relative of files) {
    const source = child(project.root, relative);
    const destination = child(stage, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    const sha256 = fileDigest(destination);
    if (fileDigest(source) !== sha256) fail('source-changed', `Source changed while snapshotting: ${relative}`);
    records.push({ path: relative, sha256, size: fs.statSync(destination).size });
  }
  if (JSON.stringify(files) !== JSON.stringify(inputFiles(project.root, project.config))) fail('source-changed', 'Project files changed while snapshotting; retry the build.');
  const configRecord = records.find(file => file.path === 'fwb.project.json');
  if (configRecord?.sha256 !== project.revision) fail('source-changed', 'Build configuration changed; retry the build.');
  const git = spawnSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  return { sha256: digest(JSON.stringify(records)), files: records, gitRevision: git.status === 0 ? git.stdout.trim() : null };
}

function installAddon(stage, target) {
  const source = path.join(packageRoot, 'runtime/addons/fwb');
  if (!fs.existsSync(source)) fail('missing-runtime-addon', 'FWB runtime addon is missing.');
  const files = walk(source);
  const hashes = [];
  for (const relative of files) {
    const destination = child(stage, `addons/fwb/${relative}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, relative), destination);
    hashes.push({ path: `addons/fwb/${relative}`, sha256: fileDigest(destination) });
  }
  atomicJson(path.join(stage, 'fwb.runtime.json'), { platform: target });
  let project = fs.readFileSync(path.join(stage, 'project.godot'), 'utf8');
  project = setSetting(project, 'autoload', 'FwbPlatform', '*res://addons/fwb/platform.gd');
  fs.writeFileSync(path.join(stage, 'project.godot'), project);
  return { sha256: digest(JSON.stringify(hashes)), files: hashes };
}

export function exportTemplatePaths(project, stage, templates = {}) {
  return Object.fromEntries(Object.entries(templates).map(([kind, file]) => {
    const relative = path.relative(project.root, file);
    const internal = relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
    return [kind, internal ? child(stage, relative) : file];
  }));
}

export function configureExport(project, stage, target, profile, diagnosis, fwcLayout) {
  const retired = retiredTargetMessage(target);
  if (retired) fail('retired-target', retired);
  const targetConfig = project.config.targets[target] ?? {};
  const preset = resolvePresetName(target, targetConfig);
  const file = path.join(stage, 'export_presets.cfg');
  let source = fs.readFileSync(file, 'utf8');
  const section = presetSection(source, preset);
  const options = `${section}.options`;
  const web = getTarget(target)?.family === 'web' || usesWebConversion(target, targetConfig);
  const extension = web ? '.html' : target === 'google-play' ? (profile.release ? '.aab' : '.apk') : target === 'app-store' ? '.zip' : '.zip';
  const filename = web ? 'index.html' : `game${extension}`;
  source = setSetting(source, section, 'export_path', `../${usesWebConversion(target, targetConfig) ? 'web' : 'out'}/${filename}`);
  const fwcFilters = project.inspection.fwc ? fwcExportFilters(stage, fwcLayout) : { include: ['pack/config/*.bin'], exclude: [] };
  const mergeFilters = (...values) => [...new Set(values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean))].join(',');
  const includes = sectionValue(source, section, 'include_filter') ?? '';
  source = setSetting(source, section, 'include_filter', mergeFilters(includes, 'fwb.runtime.json', ...fwcFilters.include));
  const excludes = sectionValue(source, section, 'exclude_filter') ?? '';
  source = setSetting(source, section, 'exclude_filter', mergeFilters(excludes, 'fwb/*', 'fwe/*', 'fwa/*', 'fws/*', 'fwv/*', 'tools/*', 'tests/*', 'docs/*', 'fwb.project.json', 'fwb.toolchain.lock.json', ...(project.inspection.fwc ? [`${project.inspection.fwc.path}/*`, ...fwcFilters.exclude] : [])));
  if (diagnosis.templates) {
    for (const [kind, template] of Object.entries(exportTemplatePaths(project, stage, diagnosis.templates))) source = setSetting(source, options, `custom_template/${kind}`, template.replaceAll('\\', '/'));
  }
  if (web) {
    source = setSetting(source, options, 'variant/thread_support', false);
    source = setSetting(source, options, 'progressive_web_app/enabled', false);
    source = setSetting(source, options, 'vram_texture_compression/for_desktop', true);
    source = setSetting(source, options, 'vram_texture_compression/for_mobile', true);
    const projectFile = path.join(stage, 'project.godot');
    let projectSettings = fs.readFileSync(projectFile, 'utf8');
    projectSettings = setSetting(projectSettings, 'rendering', 'textures/vram_compression/import_s3tc_bptc', true);
    projectSettings = setSetting(projectSettings, 'rendering', 'textures/vram_compression/import_etc2_astc', true);
    fs.writeFileSync(projectFile, projectSettings);
  }
  if (target === 'poki' && project.config.runtimeAddon) {
    const include = sectionValue(source, options, 'html/head_include') ?? '';
    source = setSetting(source, options, 'html/head_include', `${include}\n<script src="https://game-cdn.poki.com/scripts/v2/poki-sdk.js"></script>\n<script src="fwb-poki.js"></script>`);
  }
  if (target === 'google-play') {
    const gradleDirectory = resolveAndroidGradleDirectory(stage, sectionValue(source, options, 'gradle_build/gradle_build_directory'));
    source = setSetting(source, options, 'gradle_build/gradle_build_directory', `res://${gradleDirectory.relative}`);
    source = setSetting(source, options, 'version/code', project.config.buildNumber);
    source = setSetting(source, options, 'version/name', project.config.version);
    if (targetConfig.applicationId) source = setSetting(source, options, 'package/unique_name', targetConfig.applicationId);
    if (profile.release) source = setSetting(source, options, 'gradle_build/use_gradle_build', true);
    source = setSetting(source, options, 'gradle_build/export_format', profile.release ? 1 : 0);
  }
  if (target === 'app-store') {
    if (targetConfig.applicationId) source = setSetting(source, options, 'application/bundle_identifier', targetConfig.applicationId);
    if (targetConfig.teamId) source = setSetting(source, options, 'application/app_store_team_id', targetConfig.teamId);
    source = setSetting(source, options, 'application/short_version', project.config.version);
    source = setSetting(source, options, 'application/version', String(project.config.buildNumber));
  }
  fs.writeFileSync(file, source);
  return { filename, preset, web };
}

export function fwcPrepareCommand(component, stage, engine, timeoutSeconds, platform = process.platform) {
  // FWC keeps its 180-second default; explicit host budgets use its existing 1800-second cap.
  const importTimeout = String(Math.min(timeoutSeconds ?? 180, 1800));
  return platform === 'win32'
    ? { executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(component, 'tools/build.ps1'), '-ProjectRoot', stage, '-Godot', engine, '-Release', '-GodotImportTimeoutSeconds', importTimeout] }
    : { executable: 'bash', args: [path.join(component, 'tools/build.sh'), '--project-root', stage, '--godot', engine, '--release', '--godot-import-timeout-seconds', importTimeout] };
}

export async function prepareSnapshot(project, stage, target, profile, options = {}) {
  const preparation = resolveResourcePreparation(project.config, target);
  if (!preparation) return null;
  const { script } = preparation;
  if (physicalPath(stage) === physicalPath(project.root)) fail('unsafe-stage', 'Preparation must run in an isolated snapshot.');
  const filename = child(stage, script);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) fail('prepare-script-missing', `Snapshot preparation script is missing: ${script}`);
  const sha256 = fileDigest(filename);
  await runProcess(process.execPath, [filename, '--project', stage, '--target', target, '--profile', profile], {
    ...options, cwd: stage, env: { ...(options.env ?? process.env), FWB_SNAPSHOT_ROOT: stage, FWB_RESOURCE_PIPELINE: preparation.pipeline ?? '' },
  });
  return { ...preparation, sha256, status: 'passed' };
}

export async function finalizeExport(project, stage, out, target, profile, options = {}) {
  const script = project.config.targets[target]?.finalizeScript;
  if (script === undefined) return null;
  if (physicalPath(stage) === physicalPath(project.root) || physicalPath(out) === physicalPath(project.root) || path.dirname(physicalPath(stage)) !== path.dirname(physicalPath(out)) || physicalPath(stage) === physicalPath(out)) fail('unsafe-stage', 'Finalization requires separate snapshot and output directories in the same artifact.');
  const filename = child(stage, script);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) fail('finalize-script-missing', `Export finalization script is missing: ${script}`);
  const sha256 = fileDigest(filename);
  await runProcess(process.execPath, [filename, '--project', stage, '--output', out, '--target', target, '--profile', profile], {
    ...options, cwd: stage, env: { ...(options.env ?? process.env), FWB_SNAPSHOT_ROOT: stage, FWB_OUTPUT_ROOT: out },
  });
  return { script, sha256, status: 'passed' };
}

export async function buildProject(root, { target = 'web', profile = 'debug', signal, onEvent, onOutput } = {}) {
  const retired = retiredTargetMessage(target);
  if (retired) fail('retired-target', retired);
  const project = readProject(root);
  const releaseProfile = project.config.profiles[profile];
  if (!releaseProfile) fail('unknown-profile', `Unknown profile: ${profile}`);
  const id = `build_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
  const directory = artifactDirectory(project.root, id);
  const stage = child(directory, 'project');
  const out = child(directory, 'out');
  const converting = usesWebConversion(target, project.config.targets[target]);
  const exportOut = converting ? child(directory, 'web') : out;
  const manifest = { schemaVersion: 1, id, target, profile, status: 'building', createdAt: new Date().toISOString(), name: project.config.name, version: project.config.version, buildNumber: project.config.buildNumber, logs: ['build.log'], outputs: [], validation: { package: 'not-tested', runtime: 'not-tested', platform: 'not-tested' }, remote: { status: 'not-uploaded' } };
  const logFile = path.join(directory, 'build.log');
  const emit = (phase, message) => { fs.appendFileSync(logFile, `[${phase}] ${message}\n`); onEvent?.({ artifactId: id, phase, message }); };
  const unlock = lockBuild(project.root);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(stage); fs.mkdirSync(out);
    if (converting) fs.mkdirSync(exportOut);
    manifest.classification = { technology: getTarget(target)?.technology, category: getTarget(target)?.category, family: getTarget(target)?.family };
    if (project.config.targets[target]?.applicationId) manifest.applicationId = project.config.targets[target].applicationId;
    store(directory, manifest);
    emit('doctor', 'Checking target compatibility and build tools.');
    const diagnosis = await doctor(project, { target, profile });
    manifest.diagnosis = diagnosis;
    if (!diagnosis.ok) fail('preflight-failed', diagnosis.checks.filter(check => check.status === 'fail').map(check => check.message).join('\n'));
    emit('snapshot', 'Freezing the build inputs in an isolated project.');
    manifest.source = copySnapshot(project, stage);
    if (project.config.runtimeAddon) manifest.runtimeAddon = installAddon(stage, target);
    const engine = target === 'google-play' ? prepareAndroidTools(directory, diagnosis).executable : diagnosis.engine.executable;
    const resolved = resolveEnvironment(project, target);
    if (diagnosis.toolchain?.javaHome) resolved.processEnv.JAVA_HOME = diagnosis.toolchain.javaHome;
    if (diagnosis.toolchain?.androidSdkPath) Object.assign(resolved.processEnv, { ANDROID_HOME: diagnosis.toolchain.androidSdkPath, ANDROID_SDK_ROOT: diagnosis.toolchain.androidSdkPath });
    const runOptions = { cwd: stage, logFile, timeoutSeconds: project.config.timeoutSeconds ?? 600, signal, onOutput, env: resolved.processEnv };
    if (resolveResourcePreparation(project.config, target)) {
      emit('prepare-snapshot', 'Running the host preparation script inside the frozen snapshot.');
      manifest.preparation = await prepareSnapshot(project, stage, target, profile, runOptions);
    }
    if (project.inspection.fwc) {
      emit('prepare', 'Preparing FWC using its own build and generation contracts.');
      const component = child(stage, project.inspection.fwc.path);
      const prepare = fwcPrepareCommand(component, stage, engine, project.config.timeoutSeconds);
      await runProcess(prepare.executable, prepare.args, runOptions);
      manifest.fwcLayout = await readFwcLayout(project, stage, runOptions);
    }
    const exported = configureExport(project, stage, target, releaseProfile, diagnosis, manifest.fwcLayout);
    const lock = { schemaVersion: 1, engine: { version: diagnosis.engine.version, executable: engine, sha256: fs.existsSync(engine) ? fileDigest(engine) : null }, templates: Object.fromEntries(Object.entries(exportTemplatePaths(project, stage, diagnosis.templates)).filter(([, value]) => fs.existsSync(value)).map(([key, value]) => [key, { path: value, sha256: fileDigest(value) }])), target, profile, fwbVersion: '0.1.0' };
    const companion = engine.replace(/_console\.exe$/i, '.exe');
    if (companion !== engine && fs.existsSync(companion)) lock.engine.companion = { path: companion, sha256: fileDigest(companion) };
    lock.fwbSourceSha256 = digest(JSON.stringify(['src', 'runtime'].flatMap(folder => walk(path.join(packageRoot, folder)).map(file => ({ path: `${folder}/${file}`, sha256: fileDigest(path.join(packageRoot, folder, file)) })))));
    manifest.toolchain = lock;
    atomicJson(path.join(directory, 'toolchain.json'), lock);
    emit('import', 'Importing the frozen Godot project.');
    await runGodotProcess(engine, ['--headless', '--path', stage, '--editor', '--import'], { ...runOptions, phase: 'import' });
    emit('export', `Exporting ${target} with preset ${exported.preset}.`);
    await runGodotProcess(engine, ['--headless', '--path', stage, releaseProfile.release ? '--export-release' : '--export-debug', exported.preset, path.join(exportOut, exported.filename)], { ...runOptions, phase: 'export' });
    if (target === 'poki' && project.config.runtimeAddon) fs.copyFileSync(path.join(packageRoot, 'runtime/web/fwb-poki.js'), path.join(out, 'fwb-poki.js'));
    if (converting) {
      emit('convert-minigame', 'Converting the raw Web export with the frozen WeChat adapter.');
      manifest.conversion = await convertMinigame(project, stage, exportOut, out, target, profile, runOptions);
    }
    if (project.config.targets[target]?.finalizeScript) {
      emit('finalize-export', 'Finalizing the exported files with the frozen host script.');
      manifest.finalization = await finalizeExport(project, stage, out, target, profile, runOptions);
    }
    manifest.outputs = walk(out).map(relative => ({ path: `out/${relative}`, size: fs.statSync(child(out, relative)).size, sha256: fileDigest(child(out, relative)) }));
    if (!manifest.outputs.length) fail('empty-export', 'Godot produced no output.');
    manifest.entry = converting ? 'out/game.js' : `out/${exported.filename}`;
    manifest.maxBytes = project.config.targets[target]?.maxBytes ?? null;
    manifest.status = 'built'; manifest.completedAt = new Date().toISOString();
    store(directory, manifest);
    const validation = await validateArtifact(project.root, id);
    if (!validation.ok) fail('invalid-package', 'Exported package failed validation. Inspect the artifact checks.');
    emit('built', 'Package validated. Browser/device and platform acceptance are separate.');
    return readArtifact(project.root, id);
  } catch (error) {
    if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
      try {
        const current = fs.existsSync(path.join(directory, 'manifest.json')) ? readJson(path.join(directory, 'manifest.json')) : manifest;
        store(directory, { ...current, ...manifest, validation: current.validation, status: 'failed', error: { code: error.code ?? 'build-failed', message: error.message }, completedAt: new Date().toISOString() });
        emit('failed', error.message);
        error.artifactId = id;
      } catch { /* Preserve the original error even if the artifact disk is unavailable. */ }
    }
    throw error;
  } finally { unlock(); }
}

export async function validateArtifact(root, id) {
  const artifact = readArtifact(root, id);
  const retired = retiredTargetMessage(artifact.target);
  if (retired) fail('retired-target', retired);
  const checks = [];
  const add = (key, passed, message) => checks.push({ id: key, status: passed ? 'pass' : 'fail', message });
  add('build-status', artifact.status === 'built', `Build status: ${artifact.status}`);
  add('outputs', artifact.outputs.length > 0, `${artifact.outputs.length} output files recorded.`);
  let bytes = 0;
  const names = new Set();
  for (const output of artifact.outputs) {
    try {
      if (!output.path.startsWith('out/') || names.has(output.path)) fail('invalid-output', 'Invalid or duplicate output path.');
      names.add(output.path);
      const file = child(artifact.directory, output.path);
      const size = fs.statSync(file).size;
      bytes += size;
      add(`hash:${output.path}`, size === output.size && fileDigest(file) === output.sha256, output.path);
    } catch (error) { add(`hash:${output.path}`, false, error.message); }
  }
  try {
    const actual = walk(child(artifact.directory, 'out')).map(file => `out/${file}`);
    add('output-set', actual.length === names.size && actual.every(file => names.has(file)), 'Output file set matches the manifest.');
  } catch (error) { add('output-set', false, error.message); }
  if (artifact.maxBytes) add('package-budget', bytes <= artifact.maxBytes, `${bytes} / ${artifact.maxBytes} bytes.`);
  const web = ['web', 'poki', 'taptap-h5'].includes(artifact.target);
  checks.push(...validateNativeOutputs(artifact));
  if (web) {
    checks.push(...validateWebDelivery(artifact, names));
    if (artifact.target === 'poki') {
      const html = child(artifact.directory, 'out/index.html');
      add('poki-sdk', fs.existsSync(html) && fs.readFileSync(html, 'utf8').includes('game-cdn.poki.com/scripts/v2/poki-sdk.js'), 'Poki SDK is referenced; actual SDK events require platform validation.');
    }
  } else checks.push(...validateMinigameOutputs(artifact));
  const ok = checks.every(check => check.status === 'pass');
  const result = { ok, artifactId: id, checkedAt: new Date().toISOString(), checks, scope: 'package', runtimeStatus: artifact.validation?.runtime ?? 'not-tested', bytes };
  const { directory, ...stored } = artifact;
  stored.validation = { ...stored.validation, package: ok ? 'passed' : 'failed', result };
  store(directory, stored);
  return result;
}

export async function recordEvidence(root, id, { kind, result, file, note = '' }) {
  if (!['runtime', 'platform'].includes(kind) || !['passed', 'failed'].includes(result)) fail('invalid-evidence', 'Evidence kind must be runtime/platform and result passed/failed.');
  if (typeof file !== 'string' || !file || typeof note !== 'string' || note.length > 2000) fail('invalid-evidence', 'An evidence report file and an optional short note are required.');
  if (!(await validateArtifact(root, id)).ok) fail('invalid-package', 'Evidence must refer to an intact built artifact.');
  const source = physicalPath(path.resolve(root, file));
  if (!fs.statSync(source).isFile() || fs.statSync(source).size > 4 * 1024 * 1024) fail('invalid-evidence', 'Evidence must be a local report file of at most 4 MiB.');
  const artifact = readArtifact(root, id);
  const relative = `evidence/${kind}_${randomUUID()}.txt`;
  const destination = child(artifact.directory, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const record = { kind, result, note, path: relative, sha256: fileDigest(destination), outputsSha256: outputsFingerprint(artifact), recordedAt: new Date().toISOString(), reportedBy: 'operator' };
  const { directory, ...stored } = artifact;
  stored.evidence = [...(stored.evidence ?? []), record];
  stored.validation[kind] = result;
  store(directory, stored);
  return { ok: true, artifactId: id, evidence: record };
}
