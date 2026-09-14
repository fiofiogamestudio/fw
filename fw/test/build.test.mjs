import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCommand } from '../src/build.mjs';
import { parseArgs } from '../src/cli.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['game project', 'components/build/bin', 'components/editor']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'game project/fwb.project.json'), JSON.stringify({ schemaVersion: 1 }));
  fs.writeFileSync(path.join(root, 'components/build/package.json'), JSON.stringify({ name: 'fwb' }));
  fs.writeFileSync(path.join(root, 'components/build/bin/fwb.mjs'), '');
  fs.writeFileSync(path.join(root, 'components/editor/package.json'), JSON.stringify({ name: 'fwe' }));
  return { root, project: path.join(root, 'game project'), options: { 'fwb-path': path.join(root, 'components/build'), 'fwe-path': path.join(root, 'components/editor'), port: '0', 'no-open': true } };
}
test('FW build passes exact project and selected components without Git registration', t => {
  const { root, project, options } = setup(t);
  const command = buildCommand(project, options, root);
  assert.equal(command.executable, process.execPath);
  assert.deepEqual(command.args, [path.join(options['fwb-path'], 'bin/fwb.mjs'), 'editor', '--project', fs.realpathSync.native(project), '--fwe-path', fs.realpathSync.native(options['fwe-path']), '--port', '0', '--no-open']);
  assert.equal(fs.existsSync(path.join(project, '.git')), false);
  assert.equal(parseArgs(['build', '--fwb-path', options['fwb-path'], '--no-open']).options['fwb-path'], options['fwb-path']);
});
test('FW build rejects package identity, schema, port and junction mistakes before launch', t => {
  const { root, project, options } = setup(t);
  assert.throws(() => buildCommand(project, { ...options, port: '-1' }, root), /port/);
  assert.throws(() => buildCommand(project, { ...options, 'fwb-path': options['fwe-path'] }, root), /fwb/);
  fs.writeFileSync(path.join(project, 'fwb.project.json'), JSON.stringify({ schemaVersion: 2 }));
  assert.throws(() => buildCommand(project, options, root), /schema/);
  const link = path.join(root, 'linked'); fs.symlinkSync(project, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildCommand(link, options, root), /link/);
});
