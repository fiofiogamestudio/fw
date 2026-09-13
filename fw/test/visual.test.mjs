import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { visualCommand } from '../src/visual.mjs';
import { parseArgs } from '../src/cli.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-visual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['art project', 'components/art/bin', 'components/editor']) fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, 'art project/fwv.project.json'), JSON.stringify({ schemaVersion: 1 }));
  fs.writeFileSync(path.join(root, 'components/art/package.json'), JSON.stringify({ name: 'fwv' }));
  fs.writeFileSync(path.join(root, 'components/art/bin/fwv.mjs'), '');
  fs.writeFileSync(path.join(root, 'components/editor/package.json'), JSON.stringify({ name: 'fwe' }));
  return { root, project: path.join(root, 'art project'), options: { 'fwv-path': path.join(root, 'components/art'), 'fwe-path': path.join(root, 'components/editor'), port: '3230' } };
}

test('visual entry passes exact project and selected sibling editor without workspace mutation', t => {
  const { root, project, options } = setup(t);
  const before = fs.readFileSync(path.join(project, 'fwv.project.json'), 'utf8');
  const command = visualCommand(project, options, root);
  assert.equal(command.executable, process.execPath);
  assert.deepEqual(command.args, [path.join(options['fwv-path'], 'bin/fwv.mjs'), 'editor', '--project', fs.realpathSync.native(project), '--fwe-path', fs.realpathSync.native(options['fwe-path']), '--port', '3230']);
  assert.equal(fs.readFileSync(path.join(project, 'fwv.project.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(project, '.git')), false);
  assert.equal(parseArgs(['visual', '--fwv-path', options['fwv-path']]).options['fwv-path'], options['fwv-path']);
});

test('visual entry rejects identity, schema, port and junction mistakes before launch', t => {
  const { root, project, options } = setup(t);
  assert.throws(() => visualCommand(project, { ...options, port: '0' }, root), /port/);
  assert.throws(() => visualCommand(project, { ...options, 'fwv-path': options['fwe-path'] }, root), /fwv/);
  fs.writeFileSync(path.join(project, 'fwv.project.json'), JSON.stringify({ schemaVersion: 2 }));
  assert.throws(() => visualCommand(project, options, root), /schema/);
  const link = path.join(root, 'linked');
  fs.symlinkSync(project, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => visualCommand(link, options, root), /link/);
});
