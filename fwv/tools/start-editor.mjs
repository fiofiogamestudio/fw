import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fwvRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = 'start.bat [--project <existing project>] [--fwe-path <FWE directory>] [--port <0..65535>] [--no-open] [--check] [--help]';

export function parseStartOptions(argv, { packageRoot = fwvRoot, env = process.env } = {}) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (!['--project', '--fwe-path', '--port', '--no-open', '--check', '--help'].includes(option)) throw new Error(`Unknown option: ${option}. ${usage}`);
    if (Object.hasOwn(values, option)) throw new Error(`Duplicate option: ${option}.`);
    if (option === '--no-open' || option === '--check' || option === '--help') values[option] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
      values[option] = value;
    }
  }
  const port = values['--port'] ?? '0';
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('--port must be 0..65535.');
  return {
    projectRoot: path.resolve(values['--project'] ?? path.join(packageRoot, '.local', 'demo')),
    defaultProject: !values['--project'],
    fwePath: path.resolve(values['--fwe-path'] ?? path.join(packageRoot, '..', 'fwe')),
    port: Number(port), open: !values['--no-open'] && env.FWE_NO_BROWSER !== '1', check: Boolean(values['--check']), help: Boolean(values['--help']),
  };
}

async function assertDefaultProjectPath(projectRoot) {
  let ancestor = path.parse(projectRoot).root;
  for (const part of path.relative(ancestor, projectRoot).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    try {
      const stat = await fs.lstat(ancestor);
      if (stat.isSymbolicLink()) throw new Error(`Default demo path must not traverse a symbolic link or junction: ${ancestor}`);
      if (!stat.isDirectory()) throw new Error(`Default demo path must contain only directories: ${ancestor}`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

export async function inspectStart(options) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 10)) throw new Error('Node.js 20.10 or newer is required.');
  try { await import('sharp'); }
  catch (error) { throw new Error(`FWV image dependencies are unavailable. Run npm.cmd ci in ${fwvRoot}. ${error.message}`); }
  const [{ FwvProject }, { loadEditorRuntime }] = await Promise.all([
    import('../src/core/project.mjs'), import('../src/editor/server.mjs'),
  ]);
  if (options.defaultProject) await assertDefaultProjectPath(options.projectRoot);
  const { selectedFwePath } = await loadEditorRuntime(options.fwePath);
  let missing = false;
  try { await fs.lstat(options.projectRoot); }
  catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; }
  if (missing && !options.defaultProject) throw new Error(`The selected project does not exist: ${options.projectRoot}. Initialize it with fwv init first.`);
  if (missing) return { ok: true, projectRoot: options.projectRoot, fwePath: selectedFwePath, createDemoOnStart: true };
  const snapshot = await new FwvProject(options.projectRoot).snapshot();
  return { ok: true, projectRoot: options.projectRoot, fwePath: selectedFwePath, createDemoOnStart: false,
    projectId: snapshot.id, assets: snapshot.assets.length, exports: snapshot.exports.length };
}

export async function launchEditor(options) {
  if (options.help) return { help: usage };
  const inspection = await inspectStart(options);
  if (options.check) return { inspection };
  if (inspection.createDemoOnStart) {
    // Only an absent default directory is initialized; existing data is never recreated.
    execFileSync(process.execPath, [path.join(fwvRoot, 'tools', 'create-demo.mjs'), options.projectRoot], { stdio: 'inherit', windowsHide: true });
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
      console.log(`[FWV] ${editor.url}`);
      console.log(`[FWV] Project: ${editor.projectRoot}`);
      console.log('[FWV] Keep this window open while using the workbench. Press Ctrl+C to stop.');
      const stop = () => { void editor.close(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      editor.closed.then(() => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
    }
  } catch (error) { console.error(`[FWV] ${error.message}`); process.exitCode = 1; }
}
