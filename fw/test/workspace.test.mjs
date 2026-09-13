import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindings, gitlink, makeManifest, moduleDefinitions, releaseCatalog, relativePath, safeChild, validateManifest, findWorkspace, assertGitRoot, assertPhysicalDirectory, physicalProjectPath, canonicalRepository, fwRepositoryRoot } from '../src/workspace.mjs';
import { parseArgs, planCreation, editorCommand, validateRuntimeReport, validateGodotVersion } from '../src/cli.mjs';
import { git, run, powershell } from '../src/process.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-workspace-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, name, content) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
}
function repository(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'fw-test@example.invalid']);
  git(root, ['config', 'user.name', 'FW Test']);
}
function commit(root) { git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']); }
function component(root, id) {
  repository(root);
  write(root, 'package.json', { name: id });
  if (id === 'fwc') write(root, 'csharp/FwGen/FwGen.csproj', '<Project/>');
  commit(root);
}
function add(root, source, id) {
  git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', id, source, id]);
}

test('presets select only needed components; FWA core needs no editor', () => {
  assert.deepEqual(makeManifest('godot').components, ['fwc']);
  assert.deepEqual(makeManifest('agent').components, ['fwa']);
  assert.equal(makeManifest('agent').editor, undefined);
  assert.deepEqual(makeManifest('agent-ui', ['fws']).components, ['fwe', 'fwa', 'fws']);
  assert.equal(makeManifest('godot-agent').editor.kind, 'fwa');
});

test('manifest rejects unknown fields, duplicate components, versions and incompatible editor selection', () => {
  for (const value of [
    { ...makeManifest('agent'), lock: {} },
    { ...makeManifest('agent'), schemaVersion: 2 },
    { ...makeManifest('agent'), components: ['fwa', 'fwa'] },
    { ...makeManifest('agent'), components: ['fw'] },
    { ...makeManifest('agent'), editor: { kind: 'fwa' } },
    { ...makeManifest('agent-ui'), editor: { kind: 'fwa', app: 'app.json' } },
    { ...makeManifest('editor'), editor: { kind: 'fwe', app: '../outside.json' } },
  ]) assert.throws(() => validateManifest(value));
  assert.throws(() => makeManifest('nonsense'));
  assert.throws(() => makeManifest('agent', ['fw']));
});

test('relative path contract rejects traversal, absolute, ADS and Git metadata', () => {
  for (const value of ['../fwc', '/fwc', 'C:\\fwc', 'fwc/../fwe', '.git/a', 'fwc//a', 'fwc.', 'a:stream', ' fw', 'a\n']) assert.throws(() => relativePath(value), value);
  assert.equal(relativePath('vendor\\framework code'), 'vendor/framework code');
});

test('safe binding rejects a junction escape', t => {
  const root = fixture(t);
  const host = path.join(root, 'host');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(host); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(host, 'fwa'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safeChild(host, 'fwa/package.json'), /link/);
  assert.throws(() => assertPhysicalDirectory(path.join(host, 'fwa', 'new-project')), /link/);
  assert.throws(() => physicalProjectPath(path.join(host, 'fwa', 'new-project')), /link/);
  fs.symlinkSync(path.join(outside, 'missing'), path.join(host, 'broken'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safeChild(host, 'broken/config.json'), /link/);
  assert.throws(() => assertPhysicalDirectory(path.join(host, 'broken', 'new-project')), /link/);
});

test('Git roots and local origins accept physical Windows short-name aliases', { skip: process.platform !== 'win32' }, t => {
  const root = fixture(t); repository(root);
  const short = run(powershell(), ['-NoProfile', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:FW_TEST_LONG_PATH).ShortPath'], { env: { ...process.env, FW_TEST_LONG_PATH: root } }).stdout;
  if (short.toLowerCase() === root.toLowerCase()) return t.skip('8.3 aliases are disabled on this fixture volume.');
  assert.doesNotThrow(() => assertGitRoot(short));
  assert.doesNotThrow(() => assertPhysicalDirectory(path.join(short, 'new-project')));
  assert.equal(canonicalRepository(root), canonicalRepository(short));
  assert.equal(physicalProjectPath(path.join(short, 'new-project')), path.join(fs.realpathSync.native(root), 'new-project'));
  assert.equal(safeChild(short, 'fwa'), path.join(fs.realpathSync.native(root), 'fwa'));
  fs.mkdirSync(path.join(root, 'inside'));
  assert.throws(() => assertGitRoot(path.join(short, 'inside')), /Git root/);
});

test('FW remote is never an FWC identity; explicit FWC remote supports old section name', t => {
  const root = fixture(t); repository(root);
  write(root, '.gitmodules', '[submodule "fw"]\n path = fwc\n url = https://github.com/fiofiogamestudio/fwc.git\n');
  assert.equal(moduleDefinitions(root)[0].id, 'fwc');
  write(root, '.gitmodules', '[submodule "fw"]\n path = fw\n url = https://github.com/fiofiogamestudio/fw.git\n');
  assert.equal(moduleDefinitions(root)[0].id, null);
});

test('all registrations are checked for duplicate identity and overlapping paths', t => {
  const root = fixture(t); repository(root);
  write(root, '.gitmodules', '[submodule "fwe"]\n path = fwe\n url = https://github.com/fiofiogamestudio/fwe.git\n[submodule "other"]\n path = another\n url = git@github.com:fiofiogamestudio/fwe.git\n');
  assert.throws(() => moduleDefinitions(root), /Multiple registrations/);
  write(root, '.gitmodules', '[submodule "fwe"]\n path = fwe\n url = local\n[submodule "other"]\n path = fwe/nested\n url = local2\n');
  assert.throws(() => moduleDefinitions(root), /overlap/);
});

test('release pin comes only from FW committed gitlink, not component HEAD or index', t => {
  const temp = fixture(t);
  const source = path.join(temp, 'source'); component(source, 'fwa');
  const root = path.join(temp, 'bundle'); repository(root);
  write(root, 'package.json', { name: 'fw', fwWorkspace: true });
  add(root, source, 'fwa'); commit(root);
  const pinned = gitlink(root, 'fwa');
  write(source, 'next.txt', 'new revision'); commit(source);
  git(path.join(root, 'fwa'), ['fetch', 'origin']);
  git(path.join(root, 'fwa'), ['checkout', '--detach', 'origin/main']);
  git(root, ['add', 'fwa']);
  assert.notEqual(gitlink(root, 'fwa', 'index'), pinned);
  assert.equal(releaseCatalog(root, ['fwa'])[0].revision, pinned);
  const state = bindings(root, makeManifest('agent'))[0];
  assert.equal(state.committed, pinned);
  assert.notEqual(state.actual, pinned);
  assert.equal(state.index, state.actual);
  const target = path.join(temp, 'NewAgent');
  const plan = planCreation(target, { preset: 'agent' }, root);
  assert.equal(plan.mode, 'preview');
  assert.equal(fs.existsSync(target), false);
  assert.equal(plan.components[0].revision, pinned);
});

test('unborn bundle fails rather than pinning a floating branch', t => {
  const root = fixture(t); repository(root);
  write(root, 'package.json', { name: 'fw', fwWorkspace: true });
  assert.throws(() => releaseCatalog(root, ['fwe']));
});

test('nested FW program reads the outer committed component pins and rejects unrelated nested packages', t => {
  const temp = fixture(t);
  const source = path.join(temp, 'source'); component(source, 'fwa');
  const root = path.join(temp, 'bundle'); repository(root);
  const program = path.join(root, 'fw');
  write(program, 'package.json', { name: 'fw', fwWorkspace: true });
  add(root, source, 'fwa'); commit(root);
  assert.equal(fwRepositoryRoot(program), fs.realpathSync.native(root));
  assert.equal(releaseCatalog(program, ['fwa'])[0].revision, gitlink(root, 'fwa'));
  write(root, 'unrelated/package.json', { name: 'fw', fwWorkspace: true });
  assert.throws(() => fwRepositoryRoot(path.join(root, 'unrelated')), /direct fw/);
});

test('binding cannot treat a host subdirectory as a component repository', t => {
  const root = fixture(t); repository(root);
  write(root, '.gitmodules', '[submodule "fwa"]\n path = fwa\n url = local\n');
  write(root, 'fwa/package.json', { name: 'fwa' });
  assert.throws(() => bindings(root, makeManifest('agent')), /not initialized/);
});

test('nested FW registration is rejected without recursively installing it', t => {
  const root = fixture(t); repository(root);
  const source = path.join(root, 'source'); component(source, 'fwa');
  add(root, source, 'fwa');
  write(path.join(root, 'fwa'), '.gitmodules', '[submodule "fwe"]\n path = fwe\n url = https://github.com/fiofiogamestudio/fwe.git\n');
  assert.throws(() => bindings(root, makeManifest('agent')), /nests/);
});

test('editor routes to sibling components with explicit project and safe options', t => {
  const root = fixture(t); repository(root);
  for (const id of ['fwe', 'fwa']) {
    const source = path.join(root, `source-${id}`); component(source, id); add(root, source, id);
  }
  const alias = process.platform === 'win32' ? run(powershell(), ['-NoProfile', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:FW_TEST_LONG_PATH).ShortPath'], { env: { ...process.env, FW_TEST_LONG_PATH: root } }).stdout : root;
  const invocation = editorCommand(alias, makeManifest('agent-ui'), { port: '3220', 'allow-write': true, 'review-config': 'tools/review.json' });
  const physicalRoot = fs.realpathSync.native(root);
  assert.equal(invocation.args[invocation.args.indexOf('--project') + 1], physicalRoot);
  assert.ok(invocation.args.includes(path.join(physicalRoot, 'fwe')));
  assert.ok(invocation.args.includes('--allow-write'));
  assert.equal(invocation.args[invocation.args.indexOf('--review-config') + 1], path.join(physicalRoot, 'tools/review.json'));
  assert.equal(invocation.args[0], path.join(physicalRoot, 'fwa', 'bin/fwa.js'));
  assert.throws(() => editorCommand(root, makeManifest('agent-ui'), { port: '0' }), /port/);
  assert.throws(() => editorCommand(root, makeManifest('agent-ui'), { port: '3220oops' }), /port/);
});

test('workspace discovery stops at a nested Git boundary', t => {
  const root = fixture(t); repository(root);
  write(root, 'fw.workspace.json', makeManifest('agent'));
  fs.mkdirSync(path.join(root, 'game'));
  assert.equal(findWorkspace(path.join(root, 'game')), fs.realpathSync.native(root));
  repository(path.join(root, 'nested'));
  assert.throws(() => findWorkspace(path.join(root, 'nested')), /No fw.workspace/);
});

test('argument parser rejects typos, duplicated and missing values', () => {
  assert.deepEqual(parseArgs(['deps', 'update', 'fwe', '--to', 'abc', '--apply']).options, { to: 'abc', apply: true });
  assert.equal(parseArgs(['new', 'Game', '--runtime', 'gdscript']).options.runtime, 'gdscript');
  for (const args of [['--unknown'], ['--to'], ['--apply', '--apply'], ['--project', '--apply'], ['--runtime'], ['--runtime', 'gdscript', '--runtime', 'csharp']]) assert.throws(() => parseArgs(args));
});

test('runtime selection is passed only for games and never duplicated into the workspace manifest', t => {
  const temp = fixture(t);
  const source = path.join(temp, 'source'); component(source, 'fwc');
  const root = path.join(temp, 'bundle'); repository(root);
  write(root, 'package.json', { name: 'fw', fwWorkspace: true });
  add(root, source, 'fwc'); commit(root);
  const target = path.join(temp, 'Game');
  const explicit = planCreation(target, { preset: 'godot', runtime: 'gdscript' }, root);
  assert.equal(explicit.requestedRuntime, 'gdscript');
  assert.equal(Object.hasOwn(explicit.manifest, 'runtime'), false);
  assert.deepEqual(explicit.manifest, makeManifest('godot'));
  // An omitted CLI option must reach FWC as omission, including recovery of GD games.
  write(target, 'fw.toml', '[runtime]\ngame = "gdscript"\n');
  assert.equal(planCreation(target, { preset: 'godot' }, root).requestedRuntime, null);
  assert.throws(() => planCreation(target, { preset: 'godot', runtime: 'javascript' }, root), /csharp or gdscript/);
  assert.throws(() => planCreation(target, { preset: 'agent', runtime: 'gdscript' }, root), /FWC game preset/);
  assert.throws(() => planCreation(target, { preset: 'workbench', runtime: 'csharp' }, root), /FWC game preset/);
  assert.equal(fs.readFileSync(path.join(target, 'fw.toml'), 'utf8'), '[runtime]\ngame = "gdscript"\n');
});

test('editor requirements come from the game runtime while GDScript accepts standard Godot', () => {
  const csharp = { game: 'csharp', gameUsesCSharp: true };
  const gdscript = { game: 'gdscript', gameUsesCSharp: false };
  const standard = '4.6.2.stable.official.123456789';
  const mono = '4.6.2.stable.mono.official.123456789';
  assert.throws(() => validateGodotVersion(standard, csharp), /requires Godot .NET/);
  assert.equal(validateGodotVersion(mono, csharp).requiresDotnetEditor, true);
  assert.equal(validateGodotVersion(standard, gdscript).requiresDotnetEditor, false);
  assert.equal(validateGodotVersion(mono, gdscript).game, 'gdscript');
  for (const report of [null, {}, { game: 'gdscript', gameUsesCSharp: true }, { game: 'csharp', gameUsesCSharp: 'true' }]) {
    assert.throws(() => validateRuntimeReport(report), /invalid game runtime/);
  }
});
