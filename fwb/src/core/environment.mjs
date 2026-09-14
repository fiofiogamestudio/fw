import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, digest, fail, physicalPath, readJson } from './files.mjs';

export const machineFile = (env = process.env) => path.join(env.FWB_HOME || path.join(os.homedir(), '.fwb'), 'environment.json');
export function readEnvironment(file = machineFile()) {
  const config = fs.existsSync(file) ? readJson(file) : { schemaVersion: 1, godot: {}, android: {}, recentProjects: [] };
  return { file, config, revision: fs.existsSync(file) ? digest(fs.readFileSync(file)) : 'new' };
}
export function validateToolPaths(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('invalid-environment', '工具配置必须是对象。');
  for (const [key, value] of Object.entries(config || {})) {
    if (!['executable', 'version', 'templatesPath', 'androidSdkPath', 'javaHome'].includes(key)) fail('invalid-environment', `未知工具设置：${key}`);
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f]/.test(value)) fail('invalid-environment', `无效工具设置：${key}`);
    if (key === 'version' && value && !/^4\.\d+\.\d+$/.test(value)) fail('invalid-environment', 'Godot 版本格式应为 4.x.y。');
  }
}
export function saveEnvironment(config, revision, file = machineFile()) {
  const before = readEnvironment(file);
  if (revision !== before.revision) fail('revision-conflict', '本机环境已变化，请重新读取。');
  if (config?.schemaVersion !== 1 || Object.keys(config).some(key => !['schemaVersion', 'godot', 'android', 'recentProjects'].includes(key))) fail('invalid-environment', '无效本机环境配置。');
  validateToolPaths(config.godot || {}); validateToolPaths(config.android || {});
  const next = { schemaVersion: 1, godot: config.godot || {}, android: config.android || {}, recentProjects: before.config.recentProjects || [] };
  for (const section of [next.godot, next.android]) for (const key of Object.keys(section)) {
    if (!section[key]) delete section[key];
    else if (key !== 'version' && !path.isAbsolute(section[key])) fail('invalid-environment', '共享工具路径请使用绝对路径。');
  }
  atomicJson(file, next); return readEnvironment(file);
}
export function rememberProject(root, file = machineFile()) {
  const current = readEnvironment(file);
  current.config.recentProjects = [root, ...(current.config.recentProjects || []).filter(item => item !== root)].slice(0, 12);
  atomicJson(file, current.config);
}
export function resolveEnvironment(project, target, { env = process.env, hostPlatform = process.platform, settings = readEnvironment(machineFile(env)).config } = {}) {
  const local = project.config.targets?.[target] || {};
  const godot = { ...(settings.godot || {}), ...(project.config.godot || {}), ...(local.godot || {}) };
  const resolve = value => value ? path.resolve(project.root, value.startsWith('res://') ? value.slice(6) : value) : undefined;
  const androidSdkPath = resolve(local.androidSdkPath || settings.android?.androidSdkPath || env.ANDROID_HOME || env.ANDROID_SDK_ROOT || (hostPlatform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Android', 'Sdk') : undefined));
  const javaHome = resolve(local.javaHome || settings.android?.javaHome || env.JAVA_HOME);
  const signing = local.signing || {};
  const processEnv = { ...env };
  if (androidSdkPath) Object.assign(processEnv, { ANDROID_HOME: androidSdkPath, ANDROID_SDK_ROOT: androidSdkPath });
  if (javaHome) processEnv.JAVA_HOME = javaHome;
  if (signing.keystorePath) processEnv.GODOT_ANDROID_KEYSTORE_RELEASE_PATH = resolve(signing.keystorePath);
  if (signing.userEnv) processEnv.GODOT_ANDROID_KEYSTORE_RELEASE_USER = env[signing.userEnv] || '';
  if (signing.passwordEnv) processEnv.GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD = env[signing.passwordEnv] || '';
  return { godot, androidSdkPath, javaHome, processEnv };
}

// Directory browsing exposes names only; selecting a path never reads credential contents.
export function browsePaths(value, { directoriesOnly = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('invalid-path', '请先输入绝对目录路径。');
  const selected = physicalPath(value);
  const directory = fs.statSync(selected).isFile() ? path.dirname(selected) : selected;
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || !directoriesOnly && entry.isFile()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 500)
    .map(entry => ({ name: entry.name, directory: entry.isDirectory(), path: path.join(directory, entry.name) }));
  return { directory, parent: path.dirname(directory), entries };
}
