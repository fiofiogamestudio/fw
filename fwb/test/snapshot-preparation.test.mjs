import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initProject, validateConfig } from '../src/core/project.mjs';
import { prepareSnapshot } from '../src/core/build.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-preparation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'project.godot'), '[application]\nconfig/name="Preparation test"\n');
  return initProject(root);
}

test('snapshot preparation executes the frozen script with isolated cwd and explicit arguments', async t => {
  const project = fixture(t);
  project.config.targets.web.prepareScript = 'prepare.mjs';
  fs.writeFileSync(path.join(project.root, 'prepare.mjs'), 'throw new Error("Never run the live source");');
  const stage = path.join(project.root, 'snapshot with spaces'); fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'prepare.mjs'), 'import fs from "node:fs"; fs.writeFileSync("result.json", JSON.stringify({cwd:process.cwd(),root:process.env.FWB_SNAPSHOT_ROOT,args:process.argv.slice(2)}));');
  const result = await prepareSnapshot(project, stage, 'web', 'release');
  const actual = JSON.parse(fs.readFileSync(path.join(stage, 'result.json')));
  assert.equal(actual.cwd, stage); assert.equal(actual.root, stage);
  assert.deepEqual(actual.args, ['--project', stage, '--target', 'web', '--profile', 'release']);
  assert.equal(result.status, 'passed'); assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert(!fs.existsSync(path.join(project.root, 'result.json')));
});

test('preparation rejects live-source execution, missing scripts and unsafe configuration', async t => {
  const project = fixture(t); project.config.targets.web.prepareScript = 'prepare.mjs';
  await assert.rejects(prepareSnapshot(project, project.root, 'web', 'release'), {code:'unsafe-stage'});
  const stage = path.join(project.root, 'snapshot'); fs.mkdirSync(stage);
  await assert.rejects(prepareSnapshot(project, stage, 'web', 'release'), {code:'prepare-script-missing'});
  for (const script of ['../escape.mjs', 'dir/../escape.mjs', '/tmp/run.mjs', 'C:/run.mjs', 'dir\\run.mjs', 'script.sh', '']) {
    project.config.targets.web.prepareScript = script;
    assert.throws(() => validateConfig(project.config), {code:'invalid-config'});
  }
});

test('preparation failure stops the build path and an undeclared hook does nothing', async t => {
  const project = fixture(t);
  assert.equal(await prepareSnapshot(project, project.root, 'web', 'release'), null);
  project.config.targets.web.prepareScript = 'prepare.mjs';
  const stage = path.join(project.root, 'snapshot'); fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'prepare.mjs'), 'process.exit(7);');
  await assert.rejects(prepareSnapshot(project, stage, 'web', 'release'), /code 7/);
});
