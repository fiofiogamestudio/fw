import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildProject } from '../src/core/build.mjs';
import { initProject, inputFiles, readProject, updateProject } from '../src/core/project.mjs';
import { atomicJson, child, digest, fileDigest, walk } from '../src/core/files.mjs';
import { runProcess } from '../src/core/process.mjs';
import { ensureExportPreset } from '../src/core/setup.mjs';

// This probe is pinned to Godot 4.6.2's unencrypted PCK v3. Inspect the actual
// directory and payload, rather than treating files left in the stage as export evidence.
function readPack(filename) {
  const bytes = fs.readFileSync(filename);
  if (bytes.toString('ascii', 0, 4) !== 'GDPC' || bytes.readUInt32LE(4) !== 3 || bytes.readUInt32LE(20) !== 2) throw new Error('Expected the Godot 4.6.2 unencrypted PCK v3 format.');
  const base = Number(bytes.readBigUInt64LE(24));
  let position = Number(bytes.readBigUInt64LE(32));
  const count = bytes.readUInt32LE(position); position += 4;
  const entries = [];
  for (let index = 0; index < count; index++) {
    const length = bytes.readUInt32LE(position); position += 4;
    const name = bytes.subarray(position, position + length).toString('utf8').replace(/\0+$/, ''); position += length;
    const offset = base + Number(bytes.readBigUInt64LE(position)); position += 8;
    const size = Number(bytes.readBigUInt64LE(position)); position += 8;
    position += 16; // Godot's per-file MD5; compare our recorded SHA-256 below.
    const flags = bytes.readUInt32LE(position); position += 4;
    if (flags !== 0 || !Number.isSafeInteger(offset + size) || offset < base || offset + size > bytes.length) throw new Error(`Invalid PCK entry: ${name}`);
    entries.push({ path: name, bytes: size, sha256: digest(bytes.subarray(offset, offset + size)) });
  }
  return entries;
}

// A real FWC -> FWB export probe. It creates a fresh host and retains all output.
// Usage: node tools/test-fwc.mjs [--godot <standard-godot>] [--templates <directory>]
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--help')) {
  console.log('node tools/test-fwc.mjs --godot <standard Godot 4.6.2 executable> --templates <matching directory> [--fwc-dir <FWC component>]');
  console.log('Creates a fresh local fixture, runs real generation/export and retains its report in .local/fwc-probe.');
  process.exit(0);
}
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  if (!['--godot', '--templates', '--fwc-dir'].includes(name) || !process.argv[index + 1]) throw new Error('Expected --godot, --templates or --fwc-dir followed by a path.');
  options[name.slice(2)] = process.argv[index + 1];
}
const localDemo = path.join(packageRoot, '.local/demo/fwb.project.json');
const demo = fs.existsSync(localDemo) ? JSON.parse(fs.readFileSync(localDemo, 'utf8')) : {};
const godot = options.godot || process.env.GODOT_GDSCRIPT_BIN || demo.godot?.executable;
const templates = options.templates || demo.godot?.templatesPath;
if (!godot || !templates) throw new Error('Provide a standard Godot 4.6.2 executable and matching templates directory.');
const framework = path.resolve(options['fwc-dir'] || path.join(packageRoot, '../fwc'));
const directory = path.join(packageRoot, '.local/fwc-probe', `${Date.now()}_${randomUUID().slice(0, 8)}`);
const host = path.join(directory, 'game');
const hostFramework = path.join(host, 'fw/fwc');
fs.mkdirSync(hostFramework, { recursive: true });
const skip = relative => relative.split('/').some(part => ['.git', '.local', '.godot', 'bin', 'obj', 'node_modules', '.vs', '.idea'].includes(part));
const fingerprint = (root, files) => digest(JSON.stringify(files.map(file => ({ path: file, hash: fileDigest(path.join(root, file)) }))));
const frameworkFiles = walk(framework, { skip });
const frameworkHash = fingerprint(framework, frameworkFiles);
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), framework, frameworkHash, host, godot, templates, status: 'running' };
const reportFile = path.join(directory, 'report.json');
atomicJson(reportFile, report);
console.log(`FWB_FWC_PROBE ${directory}`);
try {
  for (const relative of frameworkFiles) {
    const destination = path.join(hostFramework, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(framework, relative), destination);
  }
  console.log(`Copied ${frameworkFiles.length} current FWC source files.`);
  const logFile = path.join(directory, 'new.log');
  if (process.platform === 'win32') {
    await runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(hostFramework, 'tools/new.ps1'), '-ProjectRoot', host, '-Name', 'FwbFwcProbe', '-Runtime', 'gdscript', '-FrameworkPath', 'fw/fwc'], { cwd: host, logFile, timeoutSeconds: 600 });
  } else {
    await runProcess('bash', [path.join(hostFramework, 'tools/new.sh'), '--project-root', host, '--name', 'FwbFwcProbe', '--runtime', 'gdscript', '--framework-path', 'fw/fwc'], { cwd: host, logFile, timeoutSeconds: 600 });
  }
  const initialized = initProject(host, { godot, godotVersion: '4.6.2' });
  const config = structuredClone(initialized.config);
  config.godot.templatesPath = path.resolve(templates);
  config.runtimeAddon = false;
  config.targets = { web: { enabled: true, preset: 'Web' } };
  updateProject(host, config, initialized.revision);
  const project = readProject(host);
  report.inspection = project.inspection;
  // Ask the selected FWC for its actual paths; both legacy hosts and the shallow
  // src/assets layout must be verified without hard-coded generated directories.
  const layoutResult = await runProcess('dotnet', ['run', '--project', child(host, project.inspection.fwc.generator), '--', '--root', host, 'layout'], { cwd: host, logFile: path.join(directory, 'layout.log'), timeoutSeconds: 120 });
  const layout = JSON.parse(layoutResult.output.trim());
  report.layout = layout;
  // Remove only this disposable fixture's template preset: FWB must supply all
  // layout-aware filters when the user asks it to add a missing export preset.
  fs.unlinkSync(child(host, 'export_presets.cfg'));
  report.presetCreatedByFwb = (await ensureExportPreset(project, 'web')).created;
  for (const [directory, suffix] of [[layout.tools, 'tool'], [layout.tests, 'test']]) {
    fs.mkdirSync(child(host, directory), { recursive: true });
    fs.writeFileSync(child(host, `${directory}/fwb_export_probe_${suffix}.gd`), 'extends RefCounted\n# Development-only export sentinel.\n');
  }
  report.hostHashBefore = fingerprint(host, inputFiles(host, config));
  console.log(`FWC detected: ${JSON.stringify(project.inspection.fwc)}`);
  const artifact = await buildProject(host, { target: 'web', profile: 'release', onEvent: event => console.log(`[${event.phase}] ${event.message}`) });
  report.artifactId = artifact.id;
  report.artifactDirectory = artifact.directory;
  report.validation = artifact.validation;
  report.toolchain = artifact.toolchain;
  report.outputs = artifact.outputs;
  report.hostHashAfter = fingerprint(host, inputFiles(host, config));
  report.frameworkHashAfter = fingerprint(framework, walk(framework, { skip }));
  report.sourceUnchanged = report.hostHashBefore === report.hostHashAfter && report.frameworkHash === report.frameworkHashAfter;
  const stage = path.join(artifact.directory, 'project');
  const packDirectory = child(stage, layout.configPack);
  const packFiles = walk(packDirectory);
  const generationManifest = child(stage, `${layout.genGdscript}/_fwgen_manifest.json`);
  report.generated = {
    manifest: fs.existsSync(generationManifest),
    packFiles: packFiles.map(file => ({ path: `${layout.configPack}/${file}`, bytes: fs.statSync(path.join(packDirectory, file)).size, sha256: fileDigest(path.join(packDirectory, file)) })),
    hostHasGodotCache: fs.existsSync(path.join(host, '.godot')),
  };
  const entries = readPack(path.join(artifact.directory, 'out/index.pck'));
  const developmentDirectories = [project.inspection.fwc.path, layout.configSchema, layout.configSource, layout.tools, layout.tests, layout.bridgeSchema, layout.genFwe].filter(Boolean);
  report.pack = {
    entryCount: entries.length,
    configs: entries.filter(entry => entry.path.startsWith(`${layout.configPack}/`) && entry.path.endsWith('.bin')),
    developmentEntries: entries.filter(entry => developmentDirectories.some(directory => entry.path.startsWith(`${directory}/`)) || entry.path === layout.systemSchema || /\/(?:_fwgen_manifest|_fw_sync_manifest)\.json$/.test(entry.path)),
  };
  if (!report.sourceUnchanged) throw new Error('Source fingerprint changed during isolated build.');
  if (!report.generated.manifest || !report.generated.packFiles.some(file => file.path.endsWith('.bin') && file.bytes > 0)) throw new Error('FWC generation or config pack evidence is missing.');
  for (const file of report.generated.packFiles.filter(file => file.path.endsWith('.bin'))) {
    if (!report.pack.configs.some(entry => entry.path === file.path && entry.bytes === file.bytes && entry.sha256 === file.sha256)) throw new Error(`Exported config pack is missing or changed: ${file.path}`);
  }
  if (report.pack.developmentEntries.length) throw new Error('Development resources leaked into the exported PCK.');
  report.status = 'passed';
  console.log(`FWB_FWC_PROBE_OK ${artifact.id}`);
} catch (error) {
  report.status = 'failed';
  report.error = { code: error.code, message: error.message, artifactId: error.artifactId };
  if (error.artifactId) report.artifactDirectory = path.join(host, '.local/fwb/artifacts', error.artifactId);
  process.exitCode = 1;
  console.error(error.message);
} finally {
  report.completedAt = new Date().toISOString();
  atomicJson(reportFile, report);
  console.log(`Report: ${reportFile}`);
}
