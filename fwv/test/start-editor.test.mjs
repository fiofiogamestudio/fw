import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FwvProject } from '../src/core/project.mjs';
import { inspectStart, launchEditor, parseStartOptions } from '../tools/start-editor.mjs';

const fwePath = fileURLToPath(new URL('../../fwe', import.meta.url));
const launcher = fileURLToPath(new URL('../tools/start-editor.mjs', import.meta.url));

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-start-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('launcher resolves the default project from its package and accepts only valid options', () => {
  const packageRoot = path.resolve('test-package');
  const options = parseStartOptions([], { packageRoot, env: {} });
  assert.equal(options.projectRoot, path.join(packageRoot, '.local', 'demo'));
  assert.equal(options.fwePath, path.resolve(packageRoot, '..', 'fwe'));
  assert.equal(options.port, 0);
  assert.equal(options.open, true);
  assert.equal(parseStartOptions([], { env: { FWE_NO_BROWSER: '1' } }).open, false);
  assert.equal(parseStartOptions(['--no-open']).open, false);
  for (const args of [['--port', '-1'], ['--port', '65536'], ['--port', '2.5'], ['--project'], ['--check', '--check'], ['--other']]) {
    assert.throws(() => parseStartOptions(args));
  }
});

test('check is read-only and first launch creates only an absent default demo', async t => {
  const packageRoot = await temporaryRoot(t);
  const options = parseStartOptions(['--fwe-path', fwePath, '--no-open', '--check'], { packageRoot });
  const checked = await launchEditor(options);
  assert.equal(checked.inspection.createDemoOnStart, true);
  assert.equal(checked.editor, undefined);
  await assert.rejects(fs.stat(options.projectRoot), { code: 'ENOENT' });

  const opened = await launchEditor({ ...options, check: false });
  t.after(() => opened.editor.close());
  const snapshot = await new FwvProject(options.projectRoot).snapshot();
  assert.equal(snapshot.assets.length, 5);
  const response = await fetch(`${opened.editor.url}/api/fwv/snapshot`);
  assert.equal(response.status, 200);
  assert.notEqual(new URL(opened.editor.url).port, '0');
  await opened.editor.close();

  const indexPath = path.join(options.projectRoot, 'fwv.project.json');
  const before = await fs.readFile(indexPath, 'utf8');
  const reopened = await launchEditor({ ...options, check: false });
  t.after(() => reopened.editor.close());
  assert.equal(reopened.inspection.createDemoOnStart, false);
  assert.equal(reopened.inspection.projectId, snapshot.id);
  assert.equal((await fetch(reopened.editor.url)).status, 200);
  await reopened.editor.close();
  assert.equal(await fs.readFile(indexPath, 'utf8'), before);
});

test('explicit missing projects and existing non-project directories are preserved', async t => {
  const root = await temporaryRoot(t);
  const absent = path.join(root, 'absent');
  const options = parseStartOptions(['--project', absent, '--fwe-path', fwePath, '--check']);
  await assert.rejects(inspectStart(options), /does not exist/);
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
  const marker = path.join(root, 'keep.txt');
  await fs.writeFile(marker, 'existing content');
  await assert.rejects(launchEditor({ ...options, projectRoot: root, defaultProject: true, check: false }));
  assert.equal(await fs.readFile(marker, 'utf8'), 'existing content');
  assert.deepEqual(await fs.readdir(root), ['keep.txt']);
});

test('CLI check opens an explicit existing project from another working directory without writes', async t => {
  const root = await temporaryRoot(t);
  const projectRoot = path.join(root, 'project with spaces');
  const snapshot = await new FwvProject(projectRoot).init({ name: 'Existing project' });
  const indexPath = path.join(projectRoot, 'fwv.project.json');
  const before = await fs.readFile(indexPath, 'utf8');
  const output = execFileSync(process.execPath, [launcher, '--project', projectRoot, '--fwe-path', fwePath, '--check'], { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true });
  const checked = JSON.parse(output);
  assert.equal(checked.projectId, snapshot.id);
  assert.equal(checked.createDemoOnStart, false);
  assert.equal(await fs.readFile(indexPath, 'utf8'), before);
});

test('default demo checks reject junctions in .local and package ancestors before creation', async t => {
  const root = await temporaryRoot(t);
  const external = path.join(root, 'external');
  const localPackage = path.join(root, 'local-package');
  const physicalPackage = path.join(root, 'physical-package');
  const aliasPackage = path.join(root, 'alias-package');
  for (const directory of [external, localPackage, physicalPackage]) await fs.mkdir(directory);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(external, path.join(localPackage, '.local'), linkType);
  await fs.symlink(physicalPackage, aliasPackage, linkType);
  for (const packageRoot of [localPackage, aliasPackage]) {
    const options = parseStartOptions(['--fwe-path', fwePath, '--no-open', '--check'], { packageRoot });
    await assert.rejects(launchEditor(options), /symbolic link or junction/);
    await assert.rejects(launchEditor({ ...options, check: false }), /symbolic link or junction/);
  }
  assert.deepEqual(await fs.readdir(external), []);
  assert.deepEqual(await fs.readdir(physicalPackage), []);
});

test('help prints usage without inspecting or creating a default project', async t => {
  const packageRoot = await temporaryRoot(t);
  const result = await launchEditor(parseStartOptions(['--help'], { packageRoot }));
  assert.match(result.help, /--project.*--check.*--help/);
  assert.deepEqual(await fs.readdir(packageRoot), []);
  const output = execFileSync(process.execPath, [launcher, '--help'], { cwd: packageRoot, encoding: 'utf8', windowsHide: true });
  assert.match(output, /start\.bat/);
  assert.deepEqual(await fs.readdir(packageRoot), []);
});
