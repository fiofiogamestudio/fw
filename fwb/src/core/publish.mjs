import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readProject } from './project.mjs';
import { readArtifact, validateArtifact } from './build.mjs';
import { atomicJson, child, digest, fail, fileDigest, outputsFingerprint, physicalPath, readJson } from './files.mjs';
import { probeTool } from '../doctor.mjs';
import { retiredTargetMessage } from '../platforms.mjs';

const providers = {
  'wechat-ci': { target: 'wechat-minigame', package: 'miniprogram-ci', version: '2.1.31', bin: 'miniprogram-ci', entry: 'bin/miniprogram-ci.js', channel: 'development', source: 'https://www.npmjs.com/package/miniprogram-ci' },
  'douyin-cli': { target: 'douyin-minigame', package: 'tt-minigame-ide-cli', version: '2.1.1', bin: 'tmg', entry: 'bin/tmg.js', channel: 'development', source: 'https://partner.open-douyin.com/docs/resource/zh-CN/mini-game/develop/dev-tools/development-assistance/ide-cli' },
  'poki-cli': { target: 'poki', package: '@poki/cli', version: '0.1.19', bin: 'poki', entry: 'bin/index.js', channel: 'development', source: 'https://github.com/poki/poki-cli' },
};
const allowedKeys = new Set(['provider', 'packagePath', 'toolVersion', 'applicationId', 'robot', 'privateKeyPathEnv', 'notes', 'timeoutSeconds', 'acceptance']);
const releaseRoot = (root) => child(root, '.local/fwb/releases');
const releaseDirectory = (root, id) => {
  if (!/^upload_[a-zA-Z0-9_-]{10,100}$/.test(id)) fail('invalid-release-id', 'Invalid upload record ID.');
  return child(releaseRoot(root), id);
};
const nonemptyFile = (file) => { try { const info = fs.statSync(file); return info.isFile() && info.size > 0; } catch { return false; } };
const localPath = (root, value) => typeof value === 'string' && value && !/[\x00-\x1f]/.test(value) ? physicalPath(path.resolve(root, value)) : undefined;
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validText = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);

export { outputsFingerprint };

export function readRelease(root, id) {
  const directory = releaseDirectory(root, id);
  const record = readJson(child(directory, 'release.json'));
  if (record.schemaVersion !== 1 || record.id !== id) fail('invalid-release', 'Invalid upload record.');
  return { ...record, directory };
}

export function listReleases(root) {
  const directory = releaseRoot(root);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter((item) => item.isDirectory() && !item.isSymbolicLink() && item.name.startsWith('upload_')).map((item) => {
    try { return readRelease(root, item.name); }
    catch { return { id: item.name, status: 'invalid' }; }
  }).sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
}

function handoff(target) {
  switch (target) {
    case 'google-play': return { destination: 'Google Play Console', url: 'https://play.google.com/console/', steps: ['使用通过真机验收的签名 release AAB。', '在 Play Console 测试轨道创建版本，上传 AAB 并检查处理结果。', '记录包名、versionCode、上传版本与测试轨道；上线另行操作。'], sources: ['https://developers.google.com/android-publisher/api-ref/rest/v3/edits.bundles/upload'] };
    case 'app-store': return { destination: 'App Store Connect / Xcode', url: 'https://appstoreconnect.apple.com/', steps: ['在 Mac 上打开导出的 Xcode 工程，完成签名与 Archive。', '使用 Xcode 或 Transporter 上传有效归档；Godot 导出 ZIP 不是可直接上传的 IPA。', '等待 App Store Connect 处理并验证 TestFlight；记录构建号和平台回执。'], sources: ['https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds'] };
    case 'taptap-h5': return { destination: 'TapTap 开发者中心', url: 'https://developer.taptap.cn/', steps: ['核对 H5 平台接纳和客户端真机证据。', '使用已授权的官方 H5 上传入口或 MCP 上传完整 Web 目录。', '记录平台应用及版本 ID，分别跟踪上传、审核和上线。'], sources: ['https://developer.taptap.cn/minigameapidoc/quick-start/mcp-guide/mcp-setup/'] };
    case 'poki': return { destination: 'Poki for Developers', url: 'https://developers.poki.com/', steps: ['核对游戏 ID，完成 Poki Inspector 验收。', '可使用官方 @poki/cli 上传构建；首次登录由用户完成。', '等待上传处理，在平台单独申请 Review。'], sources: ['https://github.com/poki/poki-cli'] };
    case 'wechat-minigame': return { destination: '微信开发者工具 / 公众平台', url: 'https://mp.weixin.qq.com/', steps: ['使用已验证的小游戏工程，核对 appid 和 compileType=game。', '配置代码上传私钥及平台 IP 白名单，使用 miniprogram-ci 上传开发版本。', '在平台核对版本和真机体验；提审与发布分别操作。'], sources: ['https://www.npmjs.com/package/miniprogram-ci'] };
    case 'douyin-minigame': return { destination: '抖音开发者平台', url: 'https://developer.open-douyin.com/', steps: ['使用官方 SDK 导出的已验证小游戏工程。', '先由用户运行 tmg login，再通过 tmg upload 上传开发版本。', '核对平台版本和体验码；审核、发布分别操作。'], sources: [providers['douyin-cli'].source] };
    default: return { destination: 'Web 预览', steps: ['使用 fwb preview 检查当前导出包；选择具体发行目标后再规划上传。'], sources: [] };
  }
}

function resolvePackage(root, config, provider) {
  const directory = localPath(root, config.packagePath);
  if (!directory) return undefined;
  const metadata = readJson(child(directory, 'package.json'));
  const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[provider.bin];
  if (metadata.name !== provider.package || metadata.version !== config.toolVersion || config.toolVersion !== provider.version || bin?.replace(/^\.\//, '') !== provider.entry) return undefined;
  const script = child(directory, provider.entry);
  if (!nonemptyFile(script)) return undefined;
  return { package: metadata.name, version: metadata.version, script, sha256: fileDigest(script) };
}

function verifyAcceptance(root, config, artifact, fingerprint) {
  if (config.acceptance === undefined || artifact.evidence?.some(item => item.outputsSha256 === fingerprint)) {
    const reports = ['runtime', 'platform'].map(kind => [...(artifact.evidence || [])].reverse().find(item => item.kind === kind && item.outputsSha256 === fingerprint));
    if (reports.every(item => item?.result === 'passed' && nonemptyFile(child(artifact.directory, item.path)) && fileDigest(child(artifact.directory, item.path)) === item.sha256)) {
      return { artifactId: artifact.id, outputsSha256: fingerprint, runtime: 'passed', platform: 'passed', reports, basis: 'operator-attestation' };
    }
    return undefined;
  }
  const evidence = config.acceptance;
  if (!plain(evidence) || Object.keys(evidence).some((key) => !['artifactId', 'outputsSha256', 'runtime', 'platform', 'evidence'].includes(key))) return undefined;
  if (evidence.artifactId !== artifact.id || evidence.outputsSha256 !== fingerprint || evidence.runtime !== 'passed' || evidence.platform !== 'passed') return undefined;
  const file = localPath(root, evidence.evidence);
  if (!nonemptyFile(file)) return undefined;
  return { artifactId: artifact.id, outputsSha256: fingerprint, runtime: 'passed', platform: 'passed', evidence: evidence.evidence, evidenceSha256: fileDigest(file), basis: 'operator-attestation' };
}

function providerCommand(providerId, tool, artifact, config, packageDirectory, keyPath) {
  const args = [tool.script];
  if (providerId === 'wechat-ci') args.push('upload', '--pp', packageDirectory, '--pkp', keyPath || `<env:${config.privateKeyPathEnv}>`, '--appid', config.applicationId,
    '--project-type', 'miniGame', '--uv', artifact.version, '-r', String(config.robot || 1), '--use-project-config', 'true', '--ud', config.notes || `FWB ${artifact.id}`);
  else if (providerId === 'douyin-cli') args.push('upload', packageDirectory, '--app-version', artifact.version, '--app-changelog', config.notes || `FWB ${artifact.id}`);
  else if (providerId === 'poki-cli') args.push('upload', '--name', `${artifact.version} (${artifact.buildNumber})`, '--notes', config.notes || `FWB ${artifact.id}`);
  return { executable: process.execPath, args, cwd: providerId === 'poki-cli' ? '<isolated-upload-directory>' : packageDirectory };
}

export function createPublisher({ env = process.env, hostPlatform = process.platform, homeDirectory = os.homedir(), run = probeTool } = {}) {
  async function prepare(root, id, { channel } = {}) {
    const project = readProject(root);
    const artifact = readArtifact(project.root, id);
    const retired = retiredTargetMessage(artifact.target);
    if (retired) fail('retired-target', retired);
    const checks = [];
    const add = (key, passed, message, action) => checks.push({ id: key, status: passed ? 'pass' : 'fail', message, ...(action ? { action } : {}) });
    const configured = project.config.targets?.[artifact.target]?.upload;
    const config = configured === undefined ? { provider: 'handoff' } : configured;
    const provider = plain(config) ? providers[config.provider] : undefined;
    const transfer = handoff(artifact.target);
    const isHandoff = config?.provider === 'handoff';
    const selectedChannel = isHandoff && [undefined, 'development', 'handoff'].includes(channel) ? 'handoff' : channel ?? provider?.channel ?? 'handoff';
    const fingerprint = outputsFingerprint(artifact);
    const validation = await validateArtifact(project.root, id);
    add('package', validation.ok, validation.ok ? '产物清单、文件集合及包结构检查通过。' : '产物不完整、已变化或构建未成功。', '先检查构建产物与 validate 结果。');
    add('target-enabled', project.config.targets?.[artifact.target]?.enabled !== false, '检查目标是否仍启用。', '先确认目标发布配置。');
    add('upload-config', plain(config) && !Object.keys(config).some((key) => !allowedKeys.has(key)), '上传配置必须使用受支持字段，不允许直接保存密码或令牌。', '配置 targets.<id>.upload，凭据仅引用环境变量或官方工具会话。');
    add('provider', isHandoff || Boolean(provider && provider.target === artifact.target), isHandoff ? '该目标使用人工上传交接。' : provider?.target === artifact.target ? `使用官方 ${provider.package}。` : '尚未配置该目标支持的上传工具。', '选择匹配平台的 provider，或显式使用 handoff。');
    add('channel', selectedChannel === (isHandoff || !provider ? 'handoff' : provider.channel), '首版工具上传仅进入开发版本；正式审核及上线不在此命令范围。', `该目标当前可用 channel：${isHandoff || !provider ? 'handoff' : provider.channel}。`);
    if (config?.notes !== undefined) add('notes', validText(config.notes, 500), '上传备注必须为不超过 500 字符的单行文本。');
    if (config?.timeoutSeconds !== undefined) add('timeout', Number.isInteger(config.timeoutSeconds) && config.timeoutSeconds >= 10 && config.timeoutSeconds <= 1800, '上传超时必须为 10..1800 秒。');
    let acceptance;
    try { acceptance = verifyAcceptance(project.root, config || {}, artifact, fingerprint); } catch { /* Invalid evidence is a blocking condition. */ }
    if (!isHandoff) add('acceptance', Boolean(acceptance), acceptance ? '存在绑定当前产物的运行和平台验收声明。' : '缺少绑定当前产物哈希的运行和平台验收证据。', '完成真机/浏览器和平台验收，配置 upload.acceptance；构建成功不等于验收通过。');
    else checks.push({ id: 'acceptance', status: acceptance ? 'pass' : 'warning', message: acceptance ? '验收证据与产物匹配。' : '交接材料可查看，真实上传前仍需运行与平台验收。' });
    let tool;
    let keyPath;
    if (provider && provider.target === artifact.target) {
      const versionValid = validText(artifact.version, 80) && /^[0-9a-z]/i.test(artifact.version) && (config.provider !== 'douyin-cli' || /^\d+\.\d+\.\d+$/.test(artifact.version));
      add('version', versionValid, '检查上传版本格式；抖音要求 major.minor.patch。');
      try { tool = resolvePackage(project.root, config, provider); } catch { /* Do not expose package source or malformed JSON. */ }
      add('official-tool', Boolean(tool), tool ? `已安装 ${tool.package} ${tool.version}，固定入口和版本已核对。` : '缺少匹配名称、版本或入口的官方工具包。', '先安装官方 npm 包，再填写 packagePath 和精确 toolVersion；FWB 不自动执行 npm install。');
      const appPattern = config.provider === 'wechat-ci' ? /^wx[a-zA-Z0-9]{16}$/ : config.provider === 'douyin-cli' ? /^tt[a-zA-Z0-9]{16,64}$/ : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      add('application-id', typeof config.applicationId === 'string' && appPattern.test(config.applicationId), '检查目标平台应用 ID。', '填写真实开发者平台应用 ID。');
      if (config.provider === 'wechat-ci' || config.provider === 'douyin-cli') {
        let matches = false;
        try {
          const builtConfig = readJson(child(artifact.directory, 'out/project.config.json'));
          const builtId = config.provider === 'douyin-cli' ? builtConfig.ttappid || builtConfig.appid : builtConfig.appid;
          matches = builtId === config.applicationId && builtConfig.compileType === 'game' && ['', '.', './', undefined].includes(builtConfig.miniprogramRoot);
        } catch { /* Never rewrite an already-validated package's application identity. */ }
        add('package-application', matches, '产物的 project.config.json 必须声明对应游戏应用和根目录。', '确认 appid/ttappid、compileType=game，小游戏代码位于包根目录；修改后重新构建验收。');
      }
      if (config.provider === 'wechat-ci') {
        const validEnv = typeof config.privateKeyPathEnv === 'string' && /^[A-Z][A-Z0-9_]{2,100}$/.test(config.privateKeyPathEnv);
        try { keyPath = validEnv ? localPath(project.root, env[config.privateKeyPathEnv]) : undefined; } catch { /* Reject linked credential files. */ }
        add('credential', validEnv && nonemptyFile(keyPath), '检查微信上传私钥路径环境变量及文件存在性。', '仅在当前环境设置私钥文件路径；确保微信平台已配置所需 IP 白名单。');
        add('robot', config.robot === undefined || Number.isInteger(config.robot) && config.robot >= 1 && config.robot <= 30, '微信 CI robot 必须为 1..30。');
      } else {
        const auth = config.provider === 'douyin-cli' ? path.join(homeDirectory, '.tmg-cli', '.cookies')
          : hostPlatform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Poki', 'auth.json') : path.join(env.XDG_CONFIG_HOME || path.join(homeDirectory, '.config'), 'poki', 'auth.json');
        add('credential', nonemptyFile(auth), nonemptyFile(auth) ? '找到官方工具的默认登录会话文件；有效期由官方工具验证。' : '未找到官方工具默认登录会话。', config.provider === 'douyin-cli' ? '先在此主机由用户执行 tmg login；首版使用默认 .tmg-cli 会话目录。' : '先由用户完成 Poki CLI 浏览器登录；FWB 不自动登录。');
      }
      const previous = listReleases(project.root).filter((item) => item.status === 'invalid' || ['uploading', 'unknown', 'uploaded'].includes(item.status) && item.outputsSha256 === fingerprint && item.provider === config.provider && item.applicationId === config.applicationId && item.channel === selectedChannel);
      add('duplicate', previous.length === 0, previous.length ? `已有上传记录需要核对：${previous[0].id}。` : '没有相同产物的未决或成功上传记录。', previous.length ? '先查看平台版本并记录对账回执；禁止直接重试以免重复上传。' : undefined);
    }
    const ok = !checks.some((item) => item.status === 'fail');
    const command = tool && provider ? providerCommand(config.provider, tool, artifact, config, child(artifact.directory, 'out')) : undefined;
    const report = { ok, projectRevision: project.revision, canExecute: ok && !isHandoff && Boolean(provider), status: !ok ? 'blocked' : isHandoff ? 'handoff' : 'ready', artifactId: id, target: artifact.target, provider: config?.provider || null,
      channel: selectedChannel, applicationId: validText(config?.applicationId, 100) ? config.applicationId : null, version: artifact.version, buildNumber: artifact.buildNumber, outputsSha256: fingerprint,
      checks, ...(command ? { command } : {}), handoff: transfer, sources: [...new Set([...(provider ? [provider.source] : []), ...transfer.sources])], acceptance: acceptance || null,
      ...(tool ? { tool: { package: tool.package, version: tool.version, sha256: tool.sha256 } } : {}) };
    return { report, project, artifact, config, provider, tool, keyPath };
  }

  async function planUpload(root, id, options = {}) { return (await prepare(root, id, options)).report; }

  async function uploadArtifact(root, id, { channel, execute = false } = {}) {
    if (!execute) return planUpload(root, id, { channel });
    const checkedRoot = physicalPath(root);
    const lock = child(checkedRoot, '.local/fwb/upload.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const token = randomUUID();
    try { fs.writeFileSync(lock, JSON.stringify({ token, pid: process.pid }), { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') fail('upload-busy', 'An upload lock exists. Inspect its process and receipt before retrying.'); throw error; }
    try {
      const prepared = await prepare(checkedRoot, id, { channel });
      const { report, project, artifact, config, tool, keyPath } = prepared;
      if (!report.canExecute) return report;
      const releaseId = `upload_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
      const directory = releaseDirectory(project.root, releaseId);
      const packageDirectory = child(directory, 'package');
      fs.mkdirSync(packageDirectory, { recursive: true });
      for (const output of artifact.outputs) {
        const source = child(artifact.directory, output.path);
        const destination = child(packageDirectory, output.path.slice(4));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
        if (fileDigest(destination) !== output.sha256) fail('upload-input-changed', 'Output changed while preparing the upload snapshot.');
      }
      if (config.provider === 'poki-cli') atomicJson(child(directory, 'poki.json'), { game_id: config.applicationId, build_dir: 'package' });
      const command = providerCommand(config.provider, tool, artifact, config, packageDirectory, keyPath);
      command.cwd = directory;
      const record = { schemaVersion: 1, id: releaseId, artifactId: id, provider: config.provider, target: artifact.target, applicationId: config.applicationId, channel: report.channel,
        version: artifact.version, buildNumber: artifact.buildNumber, outputsSha256: report.outputsSha256, status: 'uploading', createdAt: new Date().toISOString(),
        acceptance: report.acceptance, tool: report.tool, command: report.command, remote: { status: 'unknown', resourceId: null }, retryPolicy: 'reconcile-before-retry' };
      const recordFile = child(directory, 'release.json');
      atomicJson(recordFile, record);
      let result;
      try { result = await run(command.executable, command.args, { cwd: directory, env, timeoutMs: (config.timeoutSeconds || 600) * 1000, maxBytes: 256 * 1024 }); }
      catch { result = { ok: false, reason: 'execution-error', output: '' }; }
      const transcript = (result.output || '').replace(/\x1b\[[0-9;]*m/g, '');
      let confirmed = false;
      let remoteId = null;
      if (result.ok) {
        if (config.provider === 'wechat-ci') confirmed = /(?:^|\n)[^\n]*\bdone\s*$/m.test(transcript);
        else if (config.provider === 'douyin-cli') confirmed = /\bUpload success\b/.test(transcript);
        else {
          const match = transcript.match(/https:\/\/poki\.com\/en\/preview\/([0-9a-f-]{36})\/([0-9a-f-]{36})/i);
          confirmed = /Version uploaded successfully/.test(transcript) && Boolean(match && match[1].toLowerCase() === config.applicationId.toLowerCase());
          remoteId = confirmed ? match[2] : null;
        }
      }
      record.status = confirmed ? 'uploaded' : ['ENOENT', 'EACCES', 'EPERM'].includes(result.reason) ? 'failed' : 'unknown';
      record.completedAt = new Date().toISOString();
      record.remote = { status: confirmed ? 'cli-confirmed-awaiting-platform-check' : 'unknown', resourceId: remoteId };
      record.process = { exitCode: result.code ?? null, reason: result.reason || (confirmed ? 'confirmed' : 'missing-success-receipt'), outputSha256: digest(result.output || '') };
      record.nextAction = confirmed ? '在平台核对处理结果和上传版本；审核、上线仍未执行。' : record.status === 'failed' ? '工具尚未启动；修正本地条件后可重试。' : '远端结果未知。先核对平台版本并记录对账证据，禁止盲目重试。';
      atomicJson(recordFile, record);
      return { ...readRelease(project.root, releaseId), ok: confirmed };
    } finally {
      if (fs.existsSync(lock) && readJson(lock).token === token) fs.unlinkSync(lock);
    }
  }
  return { planUpload, uploadArtifact };
}

const publisher = createPublisher();
export const planUpload = publisher.planUpload;
export const uploadArtifact = publisher.uploadArtifact;

/** Operator-supplied reconciliation only; this does not query the remote service. */
export function recordUploadReceipt(root, id, { status, remoteId, evidence } = {}) {
  if (fs.existsSync(child(root, '.local/fwb/upload.lock'))) fail('upload-busy', 'An active or unresolved upload lock must be inspected before reconciliation.');
  if (!['uploaded', 'not-uploaded'].includes(status)) fail('invalid-receipt', 'Receipt status must be uploaded or not-uploaded.');
  if (status === 'uploaded' && !validText(remoteId, 200)) fail('invalid-receipt', 'A verified remote resource ID is required.');
  const file = localPath(root, evidence);
  if (!nonemptyFile(file)) fail('invalid-receipt', 'A nonempty local reconciliation evidence file is required.');
  const record = readRelease(root, id);
  if (!['unknown', 'uploaded', 'uploading'].includes(record.status)) fail('invalid-receipt', 'Only unresolved or uploaded records can be reconciled.');
  const { directory, ...stored } = record;
  stored.status = status;
  stored.reconciliation = { status, remoteId: remoteId || null, evidence, evidenceSha256: fileDigest(file), recordedAt: new Date().toISOString(), basis: 'operator-attestation' };
  stored.remote = { status: status === 'uploaded' ? 'operator-confirmed-uploaded' : 'operator-confirmed-not-uploaded', resourceId: remoteId || null };
  atomicJson(child(directory, 'release.json'), stored);
  return readRelease(root, id);
}
