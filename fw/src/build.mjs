import fs from 'node:fs';
import path from 'node:path';
import { fail } from './process.mjs';
import { assertPhysicalDirectory, readJson, safeChild } from './workspace.mjs';

// Local development entry. Publication and Git component registration are separate.
export function buildCommand(projectRoot, options, sourceRoot) {
  const project = path.resolve(projectRoot);
  const selected = {
    fwb: path.resolve(options['fwb-path'] ?? path.join(sourceRoot, 'fwb')),
    fwe: path.resolve(options['fwe-path'] ?? path.join(sourceRoot, 'fwe')),
  };
  assertPhysicalDirectory(project);
  if (!fs.existsSync(project)) fail('missing-build-project', 'Select an existing Godot game and run fwb init --project <directory> first.');
  const manifest = readJson(safeChild(project, 'fwb.project.json'));
  if (manifest.schemaVersion !== 1) fail('invalid-build-project', 'Unsupported FWB project schema.');
  for (const [id, root] of Object.entries(selected)) {
    assertPhysicalDirectory(root);
    if (!fs.existsSync(root) || readJson(safeChild(root, 'package.json')).name !== id) fail('identity-mismatch', `Select a real ${id} package using --${id}-path.`);
  }
  const entry = safeChild(selected.fwb, 'bin/fwb.mjs');
  if (!fs.existsSync(entry)) fail('missing-build-entry', 'Selected FWB has no CLI entry.');
  if (options.port !== undefined && (!/^\d+$/.test(options.port) || Number(options.port) > 65535)) fail('invalid-port', '--port must be 0..65535.');
  return { executable: process.execPath,
    args: [entry, 'editor', '--project', fs.realpathSync.native(project), '--fwe-path', fs.realpathSync.native(selected.fwe),
      ...(options.port !== undefined ? ['--port', options.port] : []), ...(options['no-open'] ? ['--no-open'] : [])], project };
}
