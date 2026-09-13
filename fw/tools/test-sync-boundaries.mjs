import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-sync-boundary-'));
const engine = fileURLToPath(new URL('./sync.ps1', import.meta.url));
const shell = process.env.FW_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
const configIndex = Number(env.GIT_CONFIG_COUNT || 0);
env[`GIT_CONFIG_KEY_${configIndex}`] = 'core.fsmonitor';
env[`GIT_CONFIG_VALUE_${configIndex}`] = 'false';
env.GIT_CONFIG_COUNT = String(configIndex + 1);
function run(exe, args, cwd = root) {
  const result = spawnSync(exe, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  return result;
}
function git(cwd, ...args) {
  const result = run('git', ['-C', cwd, ...args]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function repository(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'fw-boundary@example.invalid');
  git(dir, 'config', 'user.name', 'FW Boundary Test');
  fs.writeFileSync(path.join(dir, 'README.md'), name);
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'fixture');
  return dir;
}
function sync(action, host, args = [], expected = 0) {
  const result = run(shell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', engine, action, '-ProjectRoot', host, ...args, '-Json']);
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}
try {
  const fwc = repository('fwc');
  const fwe = repository('fwe');
  const duplicateHost = repository('duplicate-host');
  git(duplicateHost, 'submodule', 'add', '--name', 'fwc', fwc, 'fwc');
  git(duplicateHost, 'submodule', 'add', '--name', 'copy', fwc, 'framework-copy');
  git(duplicateHost, 'commit', '-am', 'two copies');
  const duplicate = sync('new', duplicateHost, ['-Component', 'fwc', '-FwcPath', 'fwc', '-Apply'], 2);
  assert.match(duplicate.blockers[0].message, /Duplicate fwc/);
  assert.equal(duplicate.applied, false);

  const linkHost = repository('linked-host');
  fs.symlinkSync(fwc, path.join(linkHost, 'fwc'), process.platform === 'win32' ? 'junction' : 'dir');
  const originalSource = git(fwc, 'rev-parse', 'HEAD');
  const linked = sync('pull', linkHost, ['-Component', 'fwc', '-FwcPath', 'fwc', '-Apply'], 2);
  assert.match(linked.blockers[0].message, /link\/junction/);
  assert.equal(git(fwc, 'rev-parse', 'HEAD'), originalSource);

  const mislabeled = repository('mislabeled-fwc');
  fs.writeFileSync(path.join(mislabeled, 'package.json'), JSON.stringify({ name: 'fw', fwWorkspace: true }));
  const identity = sync('status', mislabeled, ['-Component', 'fwc'], 2);
  assert.equal(identity.components.length, 0);

  const offlineHost = repository('offline-host');
  git(offlineHost, 'submodule', 'add', '--name', 'fwc', fwc, 'fwc');
  git(offlineHost, 'commit', '-am', 'pin component');
  fs.appendFileSync(path.join(fwc, 'README.md'), '\nnewer');
  git(fwc, 'commit', '-am', 'newer source');
  const checkout = path.join(offlineHost, 'fwc');
  git(checkout, 'fetch', 'origin');
  git(checkout, 'checkout', '--detach', git(fwc, 'rev-parse', 'HEAD'));
  const unavailable = path.join(root, 'offline-source.git');
  git(offlineHost, 'config', '-f', '.gitmodules', 'submodule.fwc.url', unavailable);
  git(offlineHost, 'add', '.gitmodules');
  git(offlineHost, 'commit', '-m', 'source currently offline');
  git(checkout, 'remote', 'set-url', 'origin', unavailable);
  const restored = sync('sync', offlineHost, ['-Apply']);
  assert.equal(restored.components[0].localHead, originalSource);
  assert.equal(restored.components[0].fetchAttempted, false);

  git(fwc, 'submodule', 'add', '--name', 'fwe', fwe, 'nested/fwe');
  git(fwc, 'commit', '-am', 'nested source fixture');
  const nestedHost = repository('nested-host');
  git(nestedHost, 'submodule', 'add', '--name', 'fwc', fwc, 'fwc');
  git(nestedHost, 'commit', '-am', 'pin nested source');
  const clone = path.join(root, 'nested-clone');
  git(root, 'clone', '--no-recurse-submodules', nestedHost, clone);
  const initialized = sync('sync', clone, ['-Apply']);
  assert.equal(initialized.applied, true);
  assert.equal(fs.existsSync(path.join(clone, 'fwc/nested/fwe/.git')), false);
  console.log(JSON.stringify({ success: true, duplicateRegistrationRejected: true, linkedComponentRejected: true, workspaceMarkerWins: true, pinnedSyncWorksOffline: true, pinnedSyncIsNotRecursive: true, fixture: process.argv.includes('--keep') ? root : null }));
} finally {
  if (!process.argv.includes('--keep')) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('fw-sync-boundary-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
