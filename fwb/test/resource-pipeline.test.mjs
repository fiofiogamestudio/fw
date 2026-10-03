import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/core/project.mjs';
import { resolveResourcePreparation } from '../src/core/resource-pipeline.mjs';

const webTargets = ['web', 'poki', 'taptap-h5', 'wechat-minigame', 'douyin-minigame'];
const nativeTargets = ['google-play', 'app-store'];
function config() {
  return {
    schemaVersion: 1, name: 'Shared resources', version: '1.0.0', buildNumber: 1, godot: {},
    targets: Object.fromEntries([...webTargets, ...nativeTargets].map(id => [id, { enabled: true }])),
    profiles: { release: { release: true } },
    resourcePipelines: { web: { prepareScript: 'tools/prepare-web.mjs' }, compact: { prepareScript: 'tools/compact.mjs' } },
  };
}

test('web technology targets inherit the same configured resource pipeline regardless of export family', () => {
  const project = config(); const before = structuredClone(project);
  assert.equal(validateConfig(project), project);
  for (const id of webTargets) {
    assert.deepEqual(resolveResourcePreparation(project, id), { script: 'tools/prepare-web.mjs', pipeline: 'web', source: 'pipeline' }, id);
  }
  for (const id of nativeTargets) assert.equal(resolveResourcePreparation(project, id), null, id);
  assert.deepEqual(project, before, 'validation and resolution must not rewrite target configuration');
});

test('explicit resource pipeline selection also works for native targets without implicit inheritance', () => {
  const project = config();
  for (const id of ['wechat-minigame', 'google-play']) {
    project.targets[id].resourcePipeline = 'compact';
    assert.deepEqual(resolveResourcePreparation(project, id), { script: 'tools/compact.mjs', pipeline: 'compact', source: 'pipeline' });
  }
  assert.equal(validateConfig(project), project);
});

test('target hooks retain precedence and opting out disables inheritance without disabling explicit hooks', () => {
  const project = config(); const target = project.targets.web;
  target.resourcePipeline = 'compact'; target.prepareScript = 'legacy/prepare.mjs';
  const expected = { script: 'legacy/prepare.mjs', pipeline: null, source: 'target' };
  assert.deepEqual(resolveResourcePreparation(project, 'web'), expected);
  target.resourcePipeline = false;
  assert.deepEqual(resolveResourcePreparation(project, 'web'), expected);
  delete target.prepareScript;
  assert.equal(resolveResourcePreparation(project, 'web'), null);
  assert.equal(validateConfig(project), project);
});

test('legacy configuration has no implicit preparation and keeps existing target hooks and finalizers', () => {
  const project = config(); delete project.resourcePipelines;
  for (const id of [...webTargets, ...nativeTargets]) assert.equal(resolveResourcePreparation(project, id), null);
  project.targets.web.prepareScript = 'tools/legacy.mjs';
  project.targets.web.finalizeScript = 'tools/finalize.mjs';
  assert.deepEqual(resolveResourcePreparation(project, 'web'), { script: 'tools/legacy.mjs', pipeline: null, source: 'target' });
  assert.equal(validateConfig(project), project);
  project.resourcePipelines = { compact: { prepareScript: 'tools/compact.mjs' } };
  assert.equal(resolveResourcePreparation(project, 'wechat-minigame'), null, 'a non-web pipeline never becomes an implicit default');
});

test('resource pipelines reject malformed definitions, unsafe names, and missing or unsafe scripts', () => {
  const unsafePaths = ['../escape.mjs', 'dir/../escape.mjs', '/tmp/run.mjs', 'C:/run.mjs', 'dir\\run.mjs', 'dir//run.mjs', './run.mjs', 'run.mjs\n', 'script.sh', '', false, null];
  const malformed = [null, [], 'web', { web: null }, { web: [] }, { web: {} }, { web: { prepareScript: 'ok.mjs', finalizeScript: 'also.mjs' } }];
  for (const id of ['Web', '../web', '', 'a'.repeat(41), '__proto__']) malformed.push({ [id]: { prepareScript: 'ok.mjs' } });
  for (const script of unsafePaths) malformed.push({ web: { prepareScript: script } });
  for (const pipelines of malformed) {
    const project = config(); project.resourcePipelines = pipelines;
    assert.throws(() => validateConfig(project), { code: 'invalid-config' }, JSON.stringify(pipelines));
  }
  for (const hook of ['prepareScript', 'finalizeScript', 'convertScript']) {
    for (const script of unsafePaths) {
      const project = config(); project.targets['wechat-minigame'][hook] = script;
      assert.throws(() => validateConfig(project), { code: 'invalid-config' }, `${hook}: ${script}`);
    }
  }
});

test('explicit selections reject unknown pipelines and invalid types even when an override hook exists', () => {
  for (const selected of ['missing', 'constructor', '../web', 'Web', '', null, true, 1, {}]) {
    const project = config(); project.targets.web.resourcePipeline = selected;
    for (const override of [false, true]) {
      if (override) project.targets.web.prepareScript = 'tools/override.mjs';
      assert.throws(() => validateConfig(project), { code: 'invalid-config' }, JSON.stringify(selected));
      assert.throws(() => resolveResourcePreparation(project, 'web'), { code: 'invalid-config' });
    }
  }
});

test('WeChat conversion is an optional target-specific hook, independent of shared preparation', () => {
  const project = config(); project.targets['wechat-minigame'].convertScript = 'tools/wechat/convert.mjs';
  assert.equal(validateConfig(project), project);
  assert.deepEqual(resolveResourcePreparation(project, 'wechat-minigame'), { script: 'tools/prepare-web.mjs', pipeline: 'web', source: 'pipeline' });
  for (const id of [...webTargets, ...nativeTargets].filter(id => id !== 'wechat-minigame')) {
    const invalid = config(); invalid.targets[id].convertScript = 'tools/convert.mjs';
    assert.throws(() => validateConfig(invalid), { code: 'invalid-config', message: /only supported for wechat-minigame/ });
  }
});
