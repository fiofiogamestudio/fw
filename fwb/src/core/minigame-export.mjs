import fs from 'node:fs';
import path from 'node:path';
import { child, digest, fail, fileDigest, physicalPath, readJson, walk } from './files.mjs';
import { runProcess } from './process.mjs';

export const usesWebConversion = (target, config = {}) => target === 'wechat-minigame' && typeof config.convertScript === 'string';

function fileRecords(directory) {
  return walk(directory).map(relative => ({ path: relative, bytes: fs.statSync(child(directory, relative)).size, sha256: fileDigest(child(directory, relative)) }));
}

// Resource preparation is shared; the adapter owns platform engine glue and
// loader semantics. Raw browser files never become the player output by rename.
export async function convertMinigame(project, stage, input, out, target, profile, options = {}) {
  const config = project.config.targets[target] ?? {};
  if (!usesWebConversion(target, config)) return null;
  const paths = [stage, input, out].map(physicalPath);
  const directory = path.dirname(paths[0]);
  if (new Set(paths).size !== 3 || paths.some(value => value === physicalPath(project.root) || path.dirname(value) !== directory)
    || paths[0] !== child(directory, 'project') || paths[1] !== child(directory, 'web') || paths[2] !== child(directory, 'out')) {
    fail('unsafe-stage', 'Conversion requires separate project/web/out directories in one isolated artifact.');
  }
  const marker = readJson(child(directory, 'manifest.json'));
  if (marker.status !== 'building' || marker.target !== target || marker.profile !== profile || marker.id !== path.basename(directory)) fail('unsafe-stage', 'Conversion requires the active matching build manifest.');
  const script = child(stage, config.convertScript);
  if (!fs.existsSync(script) || !fs.statSync(script).isFile()) fail('convert-script-missing', `Conversion script missing from snapshot: ${config.convertScript}`);
  if (walk(out).length) fail('conversion-output-not-empty', 'Conversion output must be empty.');
  const before = fileRecords(input);
  if (!before.some(file => file.path === 'index.html') || !before.some(file => file.path.endsWith('.wasm')) || !before.some(file => file.path.endsWith('.pck'))) fail('conversion-input-missing', 'Conversion requires the raw Godot Web export.');
  const sha256 = fileDigest(script);
  await runProcess(process.execPath, [script, '--project', stage, '--input', input, '--output', out, '--target', target, '--profile', profile], {
    ...options, cwd: stage, env: { ...(options.env ?? process.env), FWB_SNAPSHOT_ROOT: stage, FWB_WEB_INPUT_ROOT: input, FWB_OUTPUT_ROOT: out },
  });
  if (JSON.stringify(before) !== JSON.stringify(fileRecords(input))) fail('conversion-input-changed', 'The conversion script modified the recorded Web input; copy before patching.');
  const outputs = fileRecords(out);
  if (!outputs.length) fail('empty-conversion', 'The WeChat adapter produced no files.');
  return { script: config.convertScript, sha256, status: 'passed', input: { directory: 'web', files: before, sha256: digest(JSON.stringify(before)) }, outputSha256: digest(JSON.stringify(outputs)) };
}

export function validateMinigameOutputs(artifact) {
  if (!['wechat-minigame', 'douyin-minigame'].includes(artifact.target)) return [];
  const checks = [];
  const add = (id, passed, message) => checks.push({ id, status: passed ? 'pass' : 'fail', message });
  const names = new Set(artifact.outputs.map(output => output.path));
  for (const name of ['game.js', 'game.json']) {
    try {
      const file = child(artifact.directory, 'out/' + name);
      const present = names.has('out/' + name) && fs.statSync(file).size > 0;
      add('minigame:' + name, present, `Mini-game output requires nonempty ${name}; a plain Web archive is insufficient.`);
      if (name.endsWith('.json') && present) {
        const value = readJson(file);
        add('minigame:game-config', value !== null && typeof value === 'object' && !Array.isArray(value), 'game.json must be a JSON object.');
      }
    } catch (error) { add('minigame:' + name, false, error.message); }
  }
  if (artifact.target === 'wechat-minigame') {
    try {
      const config = readJson(child(artifact.directory, 'out/project.config.json'));
      add('wechat:project-config', names.has('out/project.config.json') && config?.compileType === 'game', 'WeChat developer tools require project.config.json with compileType=game.');
      add('wechat:appid', /^wx[a-zA-Z0-9]{16}$/.test(config?.appid ?? '') && (!artifact.applicationId || config.appid === artifact.applicationId), 'WeChat AppID must be configured and match the build target when specified.');
      add('wechat:project-root', config?.miniprogramRoot === undefined || ['', '.', './'].includes(config.miniprogramRoot), 'The delivered game.js and game.json must be the developer-tools project root.');
    } catch (error) { add('wechat:project-config', false, error.message); }
  }
  return checks;
}
