import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, child, digest, fail, physicalPath, readJson, sectionValue, walk } from './files.mjs';
import { targets, retiredTargetMessage } from '../platforms.mjs';
import { validateToolPaths } from './environment.mjs';

export const PROJECT_FILE = 'fwb.project.json';
const TARGETS = targets.map(target => target.id);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, max = 240) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail('invalid-config', `${label} must be a nonempty string.`); };

export function validateConfig(config) {
  if (!plain(config) || config.schemaVersion !== 1) fail('invalid-config', 'Expected FWB schemaVersion 1.');
  const keys = ['schemaVersion', 'name', 'version', 'buildNumber', 'godot', 'targets', 'profiles', 'runtimeAddon', 'exclude', 'timeoutSeconds'];
  for (const key of Object.keys(config)) if (!keys.includes(key)) fail('invalid-config', `Unknown project setting: ${key}`);
  text(config.name, 'name'); text(config.version, 'version', 80);
  if (!Number.isSafeInteger(config.buildNumber) || config.buildNumber < 1) fail('invalid-config', 'buildNumber must be a positive safe integer.');
  if (!plain(config.godot)) fail('invalid-config', 'godot is required.');
  validateToolPaths(config.godot);
  if (config.godot.version !== undefined && !/^4\.\d+\.\d+$/.test(config.godot.version)) fail('invalid-config', 'godot.version must be an exact Godot 4 version.');
  if (!plain(config.targets) || !Object.keys(config.targets).length) fail('invalid-config', 'At least one target is required.');
  for (const [id, target] of Object.entries(config.targets)) {
    const retired = retiredTargetMessage(id);
    if ((!TARGETS.includes(id) && !retired) || !plain(target)) fail('invalid-config', `Invalid target: ${id}`);
    if (target.enabled !== undefined && typeof target.enabled !== 'boolean') fail('invalid-config', `${id}.enabled must be boolean.`);
    if (retired && target.enabled !== false) fail('retired-target', retired);
    if (target.preset !== undefined) text(target.preset, `${id}.preset`, 100);
    if (target.maxBytes !== undefined && (!Number.isSafeInteger(target.maxBytes) || target.maxBytes < 1)) fail('invalid-config', `${id}.maxBytes must be positive.`);
    if (target.godot !== undefined) validateToolPaths(target.godot);
    for (const key of ['sdkPath', 'sdkVersion', 'androidSdkPath', 'javaHome', 'exportPlatform', 'applicationId', 'teamId']) if (target[key] !== undefined) text(target[key], `${id}.${key}`, 2048);
    if (target.signing !== undefined) {
      if (!plain(target.signing) || Object.keys(target.signing).some(key => !['keystorePath', 'userEnv', 'passwordEnv'].includes(key))) fail('invalid-config', '签名仅支持证书路径和凭据环境变量名称。');
      for (const [key, value] of Object.entries(target.signing)) { text(value, key, 2048); if (key.endsWith('Env') && !/^[A-Z_][A-Z0-9_]*$/.test(value)) fail('invalid-config', '凭据引用必须是环境变量名称。'); }
    }
    if (target.upload !== undefined && (!plain(target.upload) || Object.keys(target.upload).some(key => !['provider', 'packagePath', 'toolVersion', 'applicationId', 'robot', 'privateKeyPathEnv', 'notes', 'timeoutSeconds', 'acceptance'].includes(key)))) fail('invalid-config', '上传配置仅支持工具设置及凭据引用，不接受密码或令牌。');
  }
  if (!plain(config.profiles) || !Object.keys(config.profiles).length) fail('invalid-config', 'profiles is required.');
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || !plain(profile) || typeof profile.release !== 'boolean') fail('invalid-config', `Invalid profile: ${name}`);
    if (Object.keys(profile).some(key => !['release'].includes(key))) fail('invalid-config', `Unknown profile option: ${name}`);
  }
  if (config.runtimeAddon !== undefined && typeof config.runtimeAddon !== 'boolean') fail('invalid-config', 'runtimeAddon must be boolean.');
  if (config.exclude !== undefined && (!Array.isArray(config.exclude) || config.exclude.some(item => typeof item !== 'string' || !item || item.includes('*')))) fail('invalid-config', 'exclude is an array of exact relative paths or directories.');
  if (config.timeoutSeconds !== undefined && (!Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 10 || config.timeoutSeconds > 3600)) fail('invalid-config', 'timeoutSeconds must be 10..3600.');
  return config;
}

export function inputFiles(root, config = {}) {
  const excluded = (config.exclude ?? []).map(value => value.replaceAll('\\', '/'));
  excluded.forEach(value => child(root, value));
  return walk(root, { skip(relative, item) {
    const parts = relative.split('/');
    if (parts.some(part => ['.git', '.godot', '.local', '.fwb', 'node_modules', 'bin', 'obj', '.vs', '.idea'].includes(part))) return true;
    if (parts[0] === 'dist' || parts[0] === 'build') return true;
    if (item.name === '.env' || item.name.startsWith('.env.') || /\.(?:keystore|jks|p12|p8|pem|mobileprovision)$/i.test(item.name) || item.name === 'export_credentials.cfg') return true;
    return excluded.some(value => relative === value || relative.startsWith(value.replaceAll('\\', '/') + '/'));
  }});
}

export function inspectProject(root, config) {
  const projectText = fs.readFileSync(child(root, 'project.godot'), 'utf8');
  const files = inputFiles(root, config);
  const features = sectionValue(projectText, 'application', 'config/features') ?? '';
  let runtime = features.includes('C#') ? 'csharp' : 'gdscript';
  let fwc;
  const fwConfig = child(root, 'fw.toml');
  if (fs.existsSync(fwConfig)) {
    const source = fs.readFileSync(fwConfig, 'utf8');
    runtime = sectionValue(source, 'runtime', 'game') ?? 'csharp';
    const generator = sectionValue(source, 'dotnet', 'fwgen');
    if (!generator) fail('fwc-generator-missing', 'fw.toml must identify [dotnet].fwgen before FWB can prepare this FWC project.');
    const generatorPath = child(root, generator);
    const component = path.resolve(path.dirname(generatorPath), '../..');
    if (!component.startsWith(root + path.sep)) fail('invalid-fwc-path', 'FWC generator must be inside the game project.');
    const spec = path.join(component, 'docs/spec.md');
    const requiredGodotVersion = fs.existsSync(spec) ? fs.readFileSync(spec, 'utf8').match(/Godot[：:]\s*`(4\.\d+\.\d+)`/)?.[1] : undefined;
    fwc = { path: path.relative(root, component).replaceAll('\\', '/'), generator, runtime, requiredGodotVersion };
  }
  if (!['csharp', 'gdscript'].includes(runtime)) fail('invalid-runtime', 'FWC runtime must be csharp or gdscript.');
  return {
    runtime, renderer: sectionValue(projectText, 'rendering', 'renderer/rendering_method') ?? 'forward_plus',
    extensions: files.filter(file => file.endsWith('.gdextension')),
    usesThreads: files.some(file => file.endsWith('.gd') && /\bThread\s*\.\s*new\s*\(/.test(fs.readFileSync(path.join(root, file), 'utf8'))),
    csharpFiles: files.filter(file => file.endsWith('.cs') && !file.startsWith(fwc?.path + '/')),
    fwc,
  };
}

export function readProject(value) {
  const root = physicalPath(value);
  if (!fs.existsSync(child(root, 'project.godot'))) fail('missing-godot-project', 'Select a folder containing project.godot.');
  const configFile = child(root, PROJECT_FILE);
  if (!fs.existsSync(configFile)) fail('missing-fwb-project', 'Run fwb init --project <game> first.');
  const config = validateConfig(readJson(configFile));
  return { root, configFile, config, revision: digest(fs.readFileSync(configFile)), inspection: inspectProject(root, config) };
}

export function initProject(value, options = {}) {
  const root = physicalPath(value);
  if (!fs.existsSync(child(root, 'project.godot'))) fail('missing-godot-project', 'FWB init requires an existing Godot project.');
  const configFile = child(root, PROJECT_FILE);
  if (fs.existsSync(configFile)) return { ...readProject(root), created: false };
  const config = {
    schemaVersion: 1, name: options.name ?? path.basename(root), version: '0.1.0', buildNumber: 1,
    godot: { executable: options.godot ?? process.env.GODOT_BIN ?? 'godot', ...(options.godotVersion ? { version: options.godotVersion } : {}) },
    runtimeAddon: false,
    targets: Object.fromEntries(TARGETS.map(id => [id, { enabled: true, preset: ['web', 'poki', 'taptap-h5'].includes(id) ? 'Web' : id === 'google-play' ? 'Android' : id === 'app-store' ? 'iOS' : id }])),
    profiles: { debug: { release: false }, release: { release: true } },
  };
  validateConfig(config);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  return { ...readProject(root), created: true };
}

export function updateProject(root, config, expectedRevision) {
  const project = readProject(root);
  if (expectedRevision !== project.revision) fail('revision-conflict', 'Project configuration changed; reload before saving.');
  validateConfig(config);
  inspectProject(project.root, config);
  atomicJson(project.configFile, config);
  return readProject(project.root);
}
