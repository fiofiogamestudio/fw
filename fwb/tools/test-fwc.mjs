import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildProject } from '../src/core/build.mjs';
import { initProject, inputFiles, readProject, updateProject } from '../src/core/project.mjs';
import { atomicJson, digest, fileDigest, walk } from '../src/core/files.mjs';
import { runProcess } from '../src/core/process.mjs';

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
fs.mkdirSync(path.join(host, 'fwc'), { recursive: true });
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
    const destination = path.join(host, 'fwc', relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(framework, relative), destination);
  }
  console.log(`Copied ${frameworkFiles.length} current FWC source files.`);
  const logFile = path.join(directory, 'new.log');
  if (process.platform === 'win32') {
    await runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(host, 'fwc/tools/new.ps1'), '-ProjectRoot', host, '-Name', 'FwbFwcProbe', '-Runtime', 'gdscript'], { cwd: host, logFile, timeoutSeconds: 600 });
  } else {
    await runProcess('bash', [path.join(host, 'fwc/tools/new.sh'), '--project-root', host, '--name', 'FwbFwcProbe', '--runtime', 'gdscript'], { cwd: host, logFile, timeoutSeconds: 600 });
  }
  const initialized = initProject(host, { godot, godotVersion: '4.6.2' });
  const config = structuredClone(initialized.config);
  config.godot.templatesPath = path.resolve(templates);
  config.runtimeAddon = false;
  config.targets = { web: { enabled: true, preset: 'Web' } };
  updateProject(host, config, initialized.revision);
  const project = readProject(host);
  report.inspection = project.inspection;
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
  const packFiles = walk(path.join(stage, 'pack/config'));
  const generationManifest = path.join(stage, 'scripts/_gen/_fwgen_manifest.json');
  report.generated = {
    manifest: fs.existsSync(generationManifest),
    packFiles: packFiles.map(file => ({ path: `pack/config/${file}`, bytes: fs.statSync(path.join(stage, 'pack/config', file)).size, sha256: fileDigest(path.join(stage, 'pack/config', file)) })),
    hostHasGodotCache: fs.existsSync(path.join(host, '.godot')),
  };
  if (!report.sourceUnchanged) throw new Error('Source fingerprint changed during isolated build.');
  if (!report.generated.manifest || !report.generated.packFiles.some(file => file.path.endsWith('.bin') && file.bytes > 0)) throw new Error('FWC generation or config pack evidence is missing.');
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
