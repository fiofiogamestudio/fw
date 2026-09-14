import { spawn } from 'node:child_process';
import { readFile, stat, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getTarget, retiredTargetMessage } from './platforms.mjs';
import { child } from './core/files.mjs';
import { resolveEnvironment } from './core/environment.mjs';

/** Bounded read-only process probe. Its raw output is not included in doctor reports. */
export function probeTool(executable, args, { cwd, env = process.env, timeoutMs = 8000, maxBytes = 32768 } = {}) {
  return new Promise((resolve) => {
    let child;
    let output = '';
    let bytes = 0;
    let done = false;
    let timer;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...result, output });
    };
    try {
      child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ ok: false, reason: error.code || 'spawn-failed' });
      return;
    }
    const collect = (data) => {
      bytes += data.length;
      if (bytes > maxBytes) {
        child.kill('SIGKILL');
        finish({ ok: false, reason: 'output-limit' });
        return;
      }
      output += data.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => finish({ ok: false, reason: error.code || 'spawn-failed' }));
    child.on('close', (code, signal) => finish({ ok: code === 0, code, signal, reason: code === 0 ? undefined : 'exit-code' }));
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
  });
}

const presetKeys = new Set(['name', 'platform', 'custom_template/debug', 'custom_template/release', 'variant/thread_support',
  'variant/extensions_support', 'gradle_build/use_gradle_build', 'gradle_build/gradle_build_directory', 'gradle_build/export_format', 'html/custom_html_shell']);

export const resolvePresetName = (target, config = {}) => config.preset || getTarget(target)?.preset;

/** Godot appends /build to this preset path. Reject paths escaping either source or stage. */
export function resolveAndroidGradleDirectory(root, value = '') {
  if (typeof value !== 'string') throw new Error('Gradle directory must be a project-relative or res:// path.');
  const relative = value === '' ? 'android' : (value.startsWith('res://') ? value.slice(6) : value).replaceAll('\\', '/').replace(/\/$/, '');
  return { relative, directory: child(root, relative), buildDirectory: child(root, `${relative}/build`) };
}

export async function resolveExecutable(root, candidate, env = process.env, platform = process.platform) {
  if (/[/\\]/.test(candidate)) return path.resolve(root, candidate);
  const search = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const suffixes = platform === 'win32' && !path.extname(candidate) ? ['.exe', '.com'] : [''];
  for (const directory of search.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const suffix of suffixes) {
      const file = path.resolve(directory.replace(/^"|"$/g, ''), candidate + suffix);
      try { if ((await stat(file)).isFile()) return await realpath(file); } catch { /* Try the next PATH entry. */ }
    }
  }
  return candidate;
}

async function readSmall(file, limit = 2 * 1024 * 1024) {
  const info = await stat(file);
  if (!info.isFile() || info.size > limit) throw new Error('file-size-or-type');
  return readFile(file, 'utf8');
}

function decodeValue(value) {
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/** Read only required non-secret preset fields. Never open export_credentials.cfg. */
export async function inspectExportPresets(root) {
  const source = await readSmall(path.join(root, 'export_presets.cfg'));
  const records = new Map();
  let current;
  let options = false;
  for (const line of source.split(/\r?\n/)) {
    const section = line.trim().match(/^\[preset\.(\d+)(\.options)?\]$/);
    if (section) {
      if (!records.has(section[1])) records.set(section[1], { index: Number(section[1]), options: {} });
      current = records.get(section[1]);
      options = Boolean(section[2]);
      continue;
    }
    if (line.trim().startsWith('[')) { current = undefined; continue; }
    const match = line.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    if (current && match && presetKeys.has(match[1])) (options ? current.options : current)[match[1]] = decodeValue(match[2]);
  }
  return [...records.values()];
}

export function parseGodotVersion(output) {
  const raw = output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^\d+\.\d+(?:\.\d+)?\.(?:stable|dev\d*|beta\d*|rc\d*)\b/.test(line));
  if (!raw || raw.length > 160) return undefined;
  const match = raw.match(/^(\d+)\.(\d+)(?:\.(\d+))?\.([^.\s]+)(\.mono)?/);
  return { raw: raw.match(/^[\w.-]+/)[0], major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0),
    number: `${match[1]}.${match[2]}.${match[3] || 0}`, channel: match[4], templateVersion: match[0], mono: Boolean(match[5]) };
}

function versionMatches(expected, actual) {
  if (!expected || expected === 'auto') return true;
  if (typeof expected !== 'string' || !actual) return false;
  return expected === actual.raw || expected === actual.templateVersion || expected === actual.number && actual.channel === 'stable';
}

function resolveProjectPath(root, value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return path.resolve(root, value.startsWith('res://') ? value.slice(6) : value);
}

async function exists(file, type = 'file') {
  if (!file) return false;
  try {
    const value = await stat(file);
    return type === 'directory' ? value.isDirectory() : value.isFile() && value.size > 0;
  } catch { return false; }
}

async function templateLocation(root, toolchain, version, executable, env, hostPlatform, homeDirectory) {
  if (toolchain.templatesPath) return resolveProjectPath(root, toolchain.templatesPath);
  if (!version) return undefined;
  const base = hostPlatform === 'win32' ? path.join(env.APPDATA || path.join(homeDirectory, 'AppData', 'Roaming'), 'Godot')
    : hostPlatform === 'darwin' ? path.join(homeDirectory, 'Library', 'Application Support', 'Godot')
      : path.join(env.XDG_DATA_HOME || path.join(homeDirectory, '.local', 'share'), 'godot');
  const normal = path.join(base, 'export_templates', version.templateVersion);
  if (await exists(normal, 'directory')) return normal;
  if (path.isAbsolute(executable)) {
    const portable = path.join(path.dirname(executable), 'editor_data', 'export_templates', version.templateVersion);
    if (await exists(portable, 'directory')) return portable;
  }
  return normal;
}

function templateFiles(platform, selectedPreset) {
  if (platform === 'Web') {
    const threads = selectedPreset?.options['variant/thread_support'] === true;
    const extension = selectedPreset?.options['variant/extensions_support'] === true;
    const suffix = `${extension ? '_dlink' : ''}${threads ? '' : '_nothreads'}`;
    return { debug: `web${suffix}_debug.zip`, release: `web${suffix}_release.zip` };
  }
  // Godot ignores APK templates for Gradle builds and uses the installed source tree.
  if (platform === 'Android') return selectedPreset?.options['gradle_build/use_gradle_build'] === true ? {} : { debug: 'android_debug.apk', release: 'android_release.apk' };
  if (platform === 'iOS') return { debug: 'ios.zip', release: 'ios.zip' };
  return {};
}

async function hasAndroidPackage(directory, child) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) if (entry.isDirectory() && await exists(path.join(directory, entry.name, child))) return true;
  } catch { /* Missing SDK package is reported by the caller. */ }
  return false;
}

/** Factory provides deterministic test seams; the public doctor uses the real host. */
export function createDoctor({ probe = probeTool, env = process.env, hostPlatform = process.platform, homeDirectory = os.homedir() } = {}) {
  return async function doctor(project, { target = 'web', profile = 'debug' } = {}) {
    const checks = [];
    const add = (id, status, message, action) => checks.push({ id, status, message, ...(action ? { action } : {}) });
    const descriptor = getTarget(target);
    const config = project.config || {};
    const inspection = project.inspection || {};
    const targetConfig = config.targets?.[target] || {};
    const resolved = resolveEnvironment(project, target, { env, hostPlatform });
    const toolchain = resolved.godot;
    const candidate = toolchain.executable || env.GODOT_BIN || 'godot';
    const executable = await resolveExecutable(project.root, candidate, env, hostPlatform);
    const engine = { executable, version: null };
    const result = (templates = {}) => {
      const ok = !checks.some((check) => check.status === 'fail');
      return { ok, target, profile, checks, engine, platform: descriptor || null, templates,
        toolchain: { godot: toolchain, androidSdkPath: resolved.androidSdkPath, javaHome: resolved.javaHome },
        compatibility: !ok ? 'blocked' : descriptor?.status === 'supported' && inspection.runtime !== 'csharp' && !inspection.extensions?.length ? 'compatible' : 'experimental' };
    };
    if (!descriptor) {
      add('target', 'fail', retiredTargetMessage(target) || `未知构建目标：${target}`, '运行 fwb targets 查看可用目标。');
      return result();
    }
    add('target-enabled', targetConfig.enabled === false ? 'fail' : 'pass', targetConfig.enabled === false ? '该目标尚未启用。' : '目标已启用。', targetConfig.enabled === false ? `在 fwb.project.json targets.${target}.enabled 中启用目标。` : undefined);
    const selectedProfile = config.profiles?.[profile];
    add('profile', selectedProfile ? 'pass' : 'fail', selectedProfile ? `使用 ${profile} 构建配置。` : `未定义构建配置：${profile}`, selectedProfile ? undefined : '在 profiles 中定义该配置。');
    const release = selectedProfile?.release === true;
    const mode = release ? 'release' : 'debug';

    let version;
    try {
      const response = await probe(executable, ['--version'], { cwd: project.root, env });
      version = response.ok ? parseGodotVersion(response.output || '') : undefined;
      if (!version) add('godot', 'fail', `无法读取 Godot 版本（${response.reason || 'unrecognized-version'}）。`, '配置 godot.executable 为可运行的 Godot 4 可执行文件。');
      else {
        engine.version = version.raw;
        add('godot', version.major === 4 ? 'pass' : 'fail', `检测到 Godot ${version.raw}。`, version.major === 4 ? undefined : '首版 FWB 仅支持 Godot 4。');
        add('godot-version', versionMatches(toolchain.version, version) ? 'pass' : 'fail', versionMatches(toolchain.version, version) ? 'Godot 与目标工具链配置匹配。' : 'Godot 实际版本与配置要求不一致。', versionMatches(toolchain.version, version) ? undefined : '选择匹配版本的引擎，不要仅修改版本声明。');
        if (inspection.fwc?.requiredGodotVersion) add('fwc-godot-version', versionMatches(inspection.fwc.requiredGodotVersion, version) ? 'pass' : 'fail', versionMatches(inspection.fwc.requiredGodotVersion, version) ? 'Godot 符合 FWC 声明版本。' : '目标引擎与 FWC 声明版本冲突。', '使用已验证的相同引擎版本与 FWC 组合。');
      }
    } catch { add('godot', 'fail', 'Godot 版本探测失败。', '检查可执行文件和工程目录是否可访问。'); }

    let selectedPreset;
    try {
      const presets = await inspectExportPresets(project.root);
      const name = resolvePresetName(target, targetConfig);
      const matches = presets.filter((preset) => preset.name === name);
      if (matches.length === 1) {
        selectedPreset = matches[0];
        add('export-preset', 'pass', `找到导出预设：${name}。`);
        const platform = descriptor.platform || targetConfig.exportPlatform;
        add('export-platform', platform && selectedPreset.platform === platform ? 'pass' : 'fail', platform && selectedPreset.platform === platform ? `预设平台为 ${platform}。` : '导出预设的平台与目标配置不匹配或尚未声明。', '设置正确的 preset；小游戏需显式声明 exportPlatform。');
      } else add('export-preset', 'fail', matches.length ? '导出预设名称重复，无法确定目标。' : `未找到导出预设：${name}。`, '在 Godot 中创建并保存对应导出预设。');
    } catch { add('export-preset', 'fail', '无法读取 export_presets.cfg。', '在工程根目录保存 Godot 导出预设。'); }
    // Match configureExport: release always uses Gradle/AAB; debug always writes APK.
    if (descriptor.family === 'android' && selectedPreset) {
      if (release) selectedPreset.options['gradle_build/use_gradle_build'] = true;
      selectedPreset.options['gradle_build/export_format'] = release ? 1 : 0;
    }

    const webRuntime = descriptor.family === 'web' || descriptor.family === 'minigame';
    if (webRuntime) {
      add('engine-flavor', version?.mono ? 'fail' : 'pass', version?.mono ? 'Godot .NET 编辑器本身不能导出 Web；纯 GD 工程也需要标准版编辑器。' : '使用标准 Godot Web 导出工具链。', version?.mono ? '将 godot.executable 指向同版本标准版 Godot。' : undefined);
      add('runtime', inspection.runtime === 'gdscript' ? 'pass' : 'fail', inspection.runtime === 'gdscript' ? '游戏运行时为 GDScript。' : 'Godot 4 Web/小游戏路线不支持 C# 或未知运行时。', inspection.runtime === 'gdscript' ? undefined : '使用经过迁移验证的纯 GDScript 工程。');
      add('renderer', inspection.renderer === 'gl_compatibility' ? 'pass' : 'fail', inspection.renderer === 'gl_compatibility' ? '使用 Compatibility 渲染器。' : 'Web/小游戏需要 Compatibility 渲染器。', '在 Godot 中选择 Compatibility，并重新验证效果。');
      const threads = inspection.usesThreads === true || selectedPreset?.options['variant/thread_support'] === true;
      if (threads) add('threads', 'fail', '检测到线程使用或启用了线程导出。', 'FWB 首版 Web/小游戏构建基线要求单线程；先完成线程依赖迁移及验证。');
      else add('threads', 'pass', '当前检查未发现线程使用。');
      if (inspection.extensions?.length) {
        if (target === 'douyin-minigame' || descriptor.family === 'minigame') add('extensions', 'fail', '当前小游戏路线不支持 GDExtension。', '移除扩展依赖或另行验证专用引擎适配。');
        else {
          add('extensions', selectedPreset?.options['variant/extensions_support'] === true ? 'warning' : 'fail', '工程包含 GDExtension；需要对应 Web 二进制及扩展模板。', '启用扩展导出，并验证所有扩展均有可用的 Web 构建。');
          for (const [index, extension] of inspection.extensions.entries()) {
            let supported = false;
            try {
              const extensionPath = resolveProjectPath(project.root, extension);
              const source = await readSmall(extensionPath, 256 * 1024);
              const libraries = [...source.matchAll(/^\s*(web(?:\.[\w]+)*)\s*=\s*"([^"\r\n]+)"\s*$/gm)];
              for (const library of libraries) {
                if (library[1].split('.').includes(release ? 'debug' : 'release')) continue;
                const file = library[2].startsWith('res://') ? resolveProjectPath(project.root, library[2]) : path.resolve(path.dirname(extensionPath), library[2]);
                if (await exists(file)) supported = true;
              }
            } catch { /* An unreadable extension cannot be declared supported. */ }
            add(`extension-web-${index}`, supported ? 'warning' : 'fail', supported ? '扩展包含 Web 库文件，仍需浏览器加载验收。' : '扩展未找到可访问的 Web 库文件。', '为每个扩展编译并声明 Web 库。');
          }
        }
      } else add('extensions', 'pass', '未发现 GDExtension 依赖。');
    } else if (inspection.runtime === 'csharp') {
      add('runtime', version?.mono ? 'warning' : 'fail', version?.mono ? 'C# 移动导出为实验支持，需要真机验收。' : 'C# 工程需要 Godot .NET 引擎。', '安装对应版本 Godot .NET 和移动构建依赖。');
    }

    if (target === 'douyin-minigame') {
      const supported = version?.major === 4 && version?.minor === 5 && version?.patch === 0 && version?.channel === 'stable';
      add('douyin-version', supported ? 'pass' : 'fail', supported ? '引擎匹配官方当前列出的 Godot 4.5。' : '抖音官方接入页当前仅列出 Godot 4.5。', '使用官方支持版本；其他版本须等待对应 SDK 明确支持。');
    }
    if (descriptor.family === 'minigame') {
      const sdk = resolveProjectPath(project.root, targetConfig.sdkPath);
      add('platform-sdk', await exists(sdk, 'directory') ? 'pass' : 'fail', await exists(sdk, 'directory') ? '已配置本地适配 SDK 目录。' : '缺少平台适配 SDK。', '配置 targets.<id>.sdkPath 指向已审查 SDK。');
      const proof = targetConfig.validation;
      const proofFile = resolveProjectPath(project.root, proof?.evidence);
      const verified = proof?.status === 'verified' && Boolean(proof?.godotVersion) && Boolean(proof?.sdkVersion) && Boolean(targetConfig.sdkVersion)
        && proof.sdkVersion === targetConfig.sdkVersion && versionMatches(proof.godotVersion, version) && await exists(proofFile);
      add('platform-validation', verified ? 'warning' : 'fail', verified ? '使用本地人工验证证据开放实验导出；本次产物仍需检查。' : 'Godot 小游戏适配尚未验证，禁止用普通 Web 包代替。', '提供 validation.status=verified、evidence 文件及匹配的 godotVersion、sdkVersion，并配置经过验证的 preset/exportPlatform。');
    }
    if (target === 'poki') add('poki-sdk', config.runtimeAddon === true || await exists(resolveProjectPath(project.root, targetConfig.sdkPath), 'directory') ? 'warning' : 'fail', config.runtimeAddon === true ? '将装配 FWB Poki 运行时桥接；需要 Inspector 和真实 SDK 验收。' : 'Poki 需要 SDK 初始化和生命周期接入。', '启用 runtimeAddon，或配置并接入自有 sdkPath。');
    if (target === 'taptap-h5') add('platform-validation', 'warning', '当前生成 TapTap H5 候选包；手机 TapTap App 内运行仍待平台验收。', '在手机 TapTap App 内验证启动、触控、存档、音频、前后台及使用到的平台 API；浏览器预览不代表客户端验收。');

    engine.templatesPath = await templateLocation(project.root, toolchain, version, executable, env, hostPlatform, homeDirectory);
    const names = templateFiles(selectedPreset?.platform || descriptor.platform, selectedPreset);
    const templates = {};
    for (const variant of ['debug', 'release']) {
      const custom = selectedPreset?.options[`custom_template/${variant}`];
      const file = custom ? resolveProjectPath(project.root, custom) : engine.templatesPath && names[variant] ? path.join(engine.templatesPath, names[variant]) : undefined;
      if (file) templates[variant] = file;
      if (variant === mode && names[variant]) add('export-template', await exists(file) ? 'pass' : 'fail', await exists(file) ? `已找到 ${variant} 导出模板。` : `缺少匹配的 ${variant} 导出模板。`, '安装与引擎一致的模板，或配置 godot.templatesPath / preset custom_template。');
    }
    if (toolchain.templatesPath && version) {
      try {
        const text = (await readSmall(path.join(engine.templatesPath, 'version.txt'), 256)).trim();
        add('template-version', versionMatches(text, version) ? 'pass' : 'fail', versionMatches(text, version) ? '模板版本标记与引擎匹配。' : '模板版本标记与引擎不一致。', '选择与当前引擎相同版本的导出模板。');
      } catch { add('template-version', 'warning', '自定义模板目录没有可读取的 version.txt，版本需通过构建验证。'); }
    }

    if (descriptor.family === 'android') {
      let gradleDirectory;
      try {
        gradleDirectory = resolveAndroidGradleDirectory(project.root, selectedPreset?.options['gradle_build/gradle_build_directory']);
        add('android-gradle-path', 'pass', `Gradle 工程目录：res://${gradleDirectory.relative}。`);
      } catch {
        add('android-gradle-path', 'fail', 'Gradle 目录必须位于工程内，禁止绝对路径、目录穿越或符号链接。', '使用空值、android 或安全的 res:// 工程内路径。');
      }
      if (release || selectedPreset?.options['gradle_build/use_gradle_build'] === true) {
        let gradleInstalled = false;
        try { gradleInstalled = Boolean(gradleDirectory) && (await exists(child(gradleDirectory.buildDirectory, 'build.gradle')) || await exists(child(gradleDirectory.buildDirectory, 'build.gradle.kts'))); }
        catch { /* A linked or inaccessible build file is not an installed safe template. */ }
        add('android-gradle-template', gradleInstalled ? 'pass' : 'fail', gradleInstalled ? '已在所选 Gradle 目录找到 Android 构建模板。' : '所选 Gradle 目录缺少 Android 构建模板。', '在 Godot 中为该预设执行 Project > Install Android Build Template 后重试。');
      }
      const sdk = resolved.androidSdkPath;
      const exeSuffix = hostPlatform === 'win32' ? '.exe' : '';
      add('android-sdk', await exists(sdk && path.join(sdk, 'platform-tools', `adb${exeSuffix}`)) ? 'pass' : 'fail', `Android SDK：${sdk || '未配置'}。`, '在本机环境或平台设置中选择 Android SDK。FWB 会应用到隔离的 Godot 编辑器设置。');
      add('android-build-tools', sdk && await hasAndroidPackage(path.join(sdk, 'build-tools'), `aapt2${exeSuffix}`) ? 'pass' : 'fail', 'Android 构建需要已安装的 Build Tools。', '按所用 Godot 版本的 Android 导出文档安装 Build Tools。');
      add('android-platform', sdk && await hasAndroidPackage(path.join(sdk, 'platforms'), 'android.jar') ? 'pass' : 'fail', 'Android 构建需要已安装的 SDK Platform。', '安装 preset 指定的 Android SDK Platform。');
      const javaHome = resolved.javaHome;
      const java = javaHome ? path.join(javaHome, 'bin', `javac${exeSuffix}`) : await resolveExecutable(project.root, 'javac', env, hostPlatform);
      if (!javaHome && path.isAbsolute(java)) resolved.javaHome = path.dirname(path.dirname(java));
      try {
        const javaResult = await probe(java, ['-version'], { cwd: project.root, env });
        const javaVersion = javaResult.output?.match(/javac\s+(\d+)(?:\.(\d+))?/);
        const major = Number(javaVersion?.[1]) === 1 ? Number(javaVersion[2]) : Number(javaVersion?.[1]);
        add('jdk', javaResult.ok && major >= 17 ? 'pass' : 'fail', javaResult.ok && major >= 17 ? `找到 JDK ${major}：${resolved.javaHome || java}。` : '未找到 JDK 17 或更新版本的编译器。', '在本机环境或平台设置中选择 JDK 目录。');
      } catch { add('jdk', 'fail', 'JDK 探测失败。'); }
      if (release) {
        add('android-aab', selectedPreset ? 'pass' : 'fail', 'FWB 会在隔离预设中设置 Gradle AAB 发布包。', '先补全 Android 导出预设和 Gradle 构建模板。');
        const keystore = resolveProjectPath(project.root, resolved.processEnv.GODOT_ANDROID_KEYSTORE_RELEASE_PATH);
        const signed = await exists(keystore) && Boolean(resolved.processEnv.GODOT_ANDROID_KEYSTORE_RELEASE_USER) && Boolean(resolved.processEnv.GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD);
        add('android-signing', signed ? 'pass' : 'fail', signed ? '已提供发布签名环境变量和可访问的证书文件。' : '缺少发布签名环境变量或证书文件。', '在当前进程环境设置 GODOT_ANDROID_KEYSTORE_RELEASE_PATH / USER / PASSWORD；FWB 不读取凭据文件。');
      }
    }
    if (descriptor.family === 'ios') {
      add('macos', hostPlatform === 'darwin' ? 'pass' : 'fail', hostPlatform === 'darwin' ? '当前构建机为 macOS。' : 'iOS 导出需要 macOS 构建机。', hostPlatform === 'darwin' ? undefined : '在安装 Xcode 的 Mac 上运行 FWB；本机不能完成 iOS 导出。');
      if (hostPlatform === 'darwin') {
        const responses = await Promise.allSettled([probe('xcodebuild', ['-version'], { cwd: project.root, env }), probe('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version'], { cwd: project.root, env })]);
        for (const [index, response] of responses.entries()) add(index === 0 ? 'xcode' : 'iphoneos-sdk', response.status === 'fulfilled' && response.value.ok ? 'pass' : 'fail', index === 0 ? '检查 Xcode 命令行工具。' : '检查 iPhoneOS SDK。', '安装并初始化 Xcode，选择正确的开发者目录。');
      }
      add('ios-archive', 'warning', 'Godot 导出得到 Xcode 工程；签名、archive、上传和 TestFlight 需要后续验收。');
    }
    return result(templates);
  };
}

export const doctor = createDoctor();
