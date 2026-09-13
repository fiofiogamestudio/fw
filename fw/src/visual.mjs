import fs from 'node:fs';
import path from 'node:path';
import { fail } from './process.mjs';
import { assertPhysicalDirectory, readJson, safeChild } from './workspace.mjs';

// Development entry for the independently packaged FWV. This does not claim a
// published gitlink, register a remote or change the existing workspace editor.
export function visualCommand(projectRoot, options, sourceRoot) {
  const project = path.resolve(projectRoot);
  const selected = {
    fwv: path.resolve(options['fwv-path'] ?? path.join(sourceRoot, 'fwv')),
    fwe: path.resolve(options['fwe-path'] ?? path.join(sourceRoot, 'fwe')),
  };
  assertPhysicalDirectory(project);
  if (!fs.existsSync(project)) fail('missing-visual-project', 'Initialize an asset project with fwv init --project <directory> first.');
  const manifest = readJson(safeChild(project, 'fwv.project.json'));
  if (manifest.schemaVersion !== 1) fail('invalid-visual-project', 'Unsupported FWV asset project schema.');
  for (const [id, root] of Object.entries(selected)) {
    assertPhysicalDirectory(root);
    if (!fs.existsSync(root) || readJson(safeChild(root, 'package.json')).name !== id) {
      fail('identity-mismatch', `Select a real ${id} package using --${id}-path.`);
    }
  }
  const entry = safeChild(selected.fwv, 'bin/fwv.mjs');
  if (!fs.existsSync(entry)) fail('missing-visual-entry', 'Selected FWV has no CLI entry.');
  if (options.port !== undefined && (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535)) {
    fail('invalid-port', '--port must be 1..65535.');
  }
  return {
    executable: process.execPath,
    args: [entry, 'editor', '--project', fs.realpathSync.native(project), '--fwe-path', fs.realpathSync.native(selected.fwe),
      ...(options.port ? ['--port', options.port] : [])],
    project,
  };
}
