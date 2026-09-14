import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fwbRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = 'start.bat [--project <Godot project>] [--fwe-path <FWE directory>] [--port <0..65535>] [--no-open] [--check] [--help]';
export function parseStartOptions(argv, { packageRoot = fwbRoot, env = process.env } = {}) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (!['--project', '--fwe-path', '--port', '--no-open', '--check', '--help'].includes(option)) throw new Error(`Unknown option: ${option}. ${usage}`);
    if (Object.hasOwn(values, option)) throw new Error(`Duplicate option: ${option}.`);
    if (['--no-open', '--check', '--help'].includes(option)) values[option] = true;
    else { const value = argv[++index]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`); values[option] = value; }
  }
  const port = values['--port'] ?? '0';
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('--port must be 0..65535.');
  return { projectRoot: path.resolve(values['--project'] ?? path.join(packageRoot, '.local', 'demo')), defaultProject: !values['--project'],
    packageRoot: path.resolve(packageRoot), fwePath: path.resolve(values['--fwe-path'] ?? path.join(packageRoot, '..', 'fwe')),
    port: Number(port), open: !values['--no-open'] && env.FWE_NO_BROWSER !== '1', check: Boolean(values['--check']), help: Boolean(values['--help']) };
}
async function assertDefaultProjectPath(projectRoot) {
  let ancestor = path.parse(projectRoot).root;
  for (const part of path.relative(ancestor, projectRoot).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    try { const stat = await fs.lstat(ancestor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Default demo path must contain physical directories: ${ancestor}`); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
}
export async function inspectStart(options) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error('Node.js 22 or newer is required.');
  const [{ readProject }, { loadEditorRuntime }] = await Promise.all([import('../src/core/project.mjs'), import('../src/editor/server.mjs')]);
  if (options.defaultProject) await assertDefaultProjectPath(options.projectRoot);
  const { selectedFwePath } = await loadEditorRuntime(options.fwePath);
  let missing = false;
  try { await fs.lstat(options.projectRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; }
  if (missing && !options.defaultProject) throw new Error(`The selected project does not exist: ${options.projectRoot}. Run fwb init for an existing Godot game first.`);
  const project = await readProject(missing ? path.join(options.packageRoot || fwbRoot, 'examples', 'demo') : options.projectRoot);
  return { ok: true, projectRoot: options.projectRoot, fwePath: selectedFwePath, createDemoOnStart: missing, name: project.config.name };
}
export async function launchEditor(options) {
  if (options.help) return { help: usage };
  const inspection = await inspectStart(options);
  if (options.check) return { inspection };
  if (inspection.createDemoOnStart) {
    await assertDefaultProjectPath(options.projectRoot);
    await fs.mkdir(path.dirname(options.projectRoot), { recursive: true });
    // mkdir without recursive prevents an intervening directory from being overwritten.
    await fs.mkdir(options.projectRoot);
    const demoSource = path.join(options.packageRoot || fwbRoot, 'examples', 'demo');
    for (const entry of await fs.readdir(demoSource)) {
      await fs.cp(path.join(demoSource, entry), path.join(options.projectRoot, entry), {
        recursive: true, force: false, errorOnExist: true,
        filter: source => !['.godot', '.fwb', '.git', '.local'].includes(path.basename(source)),
      });
    }
  }
  const { startEditor } = await import('../src/editor/server.mjs');
  const editor = await startEditor({ projectRoot: options.projectRoot, fwePath: inspection.fwePath, port: options.port, open: options.open });
  return { inspection, editor };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { inspection, editor, help } = await launchEditor(parseStartOptions(process.argv.slice(2)));
    if (help) console.log(help);
    else if (!editor) console.log(JSON.stringify(inspection, null, 2));
    else {
      console.log(`[FWB] ${editor.url}`); console.log(`[FWB] Project: ${editor.projectRoot}`);
      console.log('[FWB] Keep this window open while using the workbench. Press Ctrl+C to stop.');
      const stop = () => { void editor.close(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      editor.closed.then(() => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
    }
  } catch (error) { console.error(`[FWB] ${error.message}`); process.exitCode = 1; }
}
