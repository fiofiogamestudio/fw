import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, run } from '../src/process.mjs';
import { gitlink, moduleDefinitions } from '../src/workspace.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function write(root, filename, value) {
  fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
  fs.writeFileSync(path.join(root, filename), value);
}
function init(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'FW Fixture']);
  git(root, ['config', 'user.email', 'fw-fixture@example.invalid']);
}
function commit(root) { git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']); }

test('real CLI new preview/apply/resume and pinned sync use one direct component, no global install', { timeout: 180_000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-init-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const remote = path.join(temp, 'fwa-source');
  init(remote);
  write(remote, 'package.json', '{"name":"fwa","type":"module"}\n');
  write(remote, 'bin/fwa.js', "import fs from 'node:fs'; import path from 'node:path'; const root=process.argv[process.argv.indexOf('--project')+1]; if(process.argv[2] !== 'init') process.exit(2); fs.mkdirSync(path.join(root,'.fwa'),{recursive:true}); if(!fs.existsSync(path.join(root,'.fwa','project.json'))) fs.writeFileSync(path.join(root,'.fwa','project.json'), '{}'); console.log(JSON.stringify({ok:true,initialized:true}));\n");
  commit(remote);
  const bundle = path.join(temp, 'fw-bundle');
  init(bundle);
  for (const entry of ['package.json', 'bin', 'src', 'tools']) fs.cpSync(path.join(sourceRoot, entry), path.join(bundle, entry), { recursive: true });
  git(bundle, ['submodule', 'add', '--name', 'fwa', remote, 'fwa']);
  commit(bundle);
  const cli = path.join(bundle, 'bin/fw.mjs');
  const target = path.join(temp, 'Agent Project');
  const before = gitlink(bundle, 'fwa');
  let result = run(process.execPath, [cli, 'new', target, '--preset', 'agent'], { allowFailure: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(target), false);
  assert.equal(JSON.parse(result.stdout).components[0].revision, before);
  result = run(process.execPath, [cli, 'new', target, '--preset', 'agent', '--apply'], { allowFailure: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(moduleDefinitions(target).map(item => item.id), ['fwa']);
  assert.equal(fs.existsSync(path.join(target, 'fwe')), false);
  assert.equal(fs.existsSync(path.join(target, '.codex')), false);
  assert.equal(fs.existsSync(path.join(target, '.fwa', 'project.json')), true);
  assert.equal(gitlink(target, 'fwa', 'index'), before);
  assert.equal(gitlink(target, 'fwa'), null);
  assert.equal(git(target, ['check-ignore', '.fwa/project.json']).status, 0);
  const trackedState = git(target, ['status', '--porcelain']).stdout;
  result = run(process.execPath, [cli, 'init', '--project', target, '--preset', 'agent', '--apply'], { allowFailure: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(git(target, ['status', '--porcelain']).stdout, trackedState);
  result = run(process.execPath, [cli, 'new', target, '--preset', 'agent', '--apply'], { allowFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nonempty-project/);
  git(target, ['config', 'user.name', 'FW Fixture']);
  git(target, ['config', 'user.email', 'fw-fixture@example.invalid']);
  commit(target);
  result = run(process.execPath, [cli, 'deps', 'sync', '--project', target, '--apply'], { allowFailure: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(gitlink(target, 'fwa'), before);
  assert.equal(git(target, ['status', '--porcelain']).stdout, '');
  write(remote, 'second.txt', 'second revision');
  commit(remote);
  const next = git(remote, ['rev-parse', 'HEAD']).stdout;
  result = run(process.execPath, [cli, 'deps', 'update', 'fwa', '--to', next, '--project', target], { allowFailure: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(path.join(target, 'fwa'), ['rev-parse', 'HEAD']).stdout, before);
  result = run(process.execPath, [cli, 'deps', 'update', 'fwa', '--to', next, '--project', target, '--apply'], { allowFailure: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(git(path.join(target, 'fwa'), ['rev-parse', 'HEAD']).stdout, next);
  result = run(process.execPath, [cli, 'deps', 'install', '--project', target, '--apply'], { allowFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /working-version-change|staged-version-change/);
  assert.equal(git(path.join(target, 'fwa'), ['rev-parse', 'HEAD']).stdout, next);
  git(target, ['add', 'fwa']);
  result = run(process.execPath, [cli, 'deps', 'install', '--project', target, '--apply'], { allowFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /staged-version-change/);
  commit(target);
  result = run(process.execPath, [cli, 'deps', 'install', '--project', target, '--apply'], { allowFailure: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(git(path.join(target, 'fwa'), ['rev-parse', 'HEAD']).stdout, next, 'install preserves the host release, even when bootstrap pins are older');
});
