import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnvironment, saveEnvironment, rememberProject, browsePaths, resolveEnvironment } from '../core/environment.mjs';
import { resolveExecutable, probeTool, parseGodotVersion } from '../doctor.mjs';
import { validateConfig, initProject } from '../core/project.mjs';
import { ensureExportPreset } from '../core/setup.mjs';
import { getTarget } from '../platforms.mjs';
import { listReleases, readRelease, recordUploadReceipt, uploadArtifact } from '../core/publish.mjs';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
export const PLATFORM_LABELS = {
  web: 'Web 浏览器', 'taptap-h5': 'TapTap（App 内即玩）', 'wechat-minigame': '微信小游戏',
  'douyin-minigame': '抖音小游戏', 'google-play': 'Google Play', 'app-store': 'App Store', poki: 'Poki',
};
function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw invalid('操作参数不匹配。');
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(value) || value.includes('..')) throw invalid('标识格式无效。');
  return value;
}
export async function createWorkbenchState(root, services) {
  if (!services) {
    const [project, build, diagnostics, preview] = await Promise.all([
      import('../core/project.mjs'), import('../core/build.mjs'), import('../doctor.mjs'), import('../core/preview.mjs'),
    ]);
    services = { ...project, ...build, ...diagnostics, ...preview,
      planUpload: async (...args) => (await import('../core/publish.mjs')).planUpload(...args) };
  }
  let initial = await services.readProject(root), configSignature = JSON.stringify(initial.config);
  const environmentFile = services.environmentFile;
  let active = null, stopping = false, generation = 0;
  const jobs = new Map(), previews = new Map();
  async function current() {
    const project = await services.readProject(root);
    if (JSON.stringify(project.config) !== configSignature) throw invalid('工程配置已经变化，请重启工作台。', 409);
    return project;
  }
  function jobView(job) {
    const { promise, controller, ...value } = job;
    return value;
  }
  function submit(type, payload) {
    if (stopping) throw invalid('工作台正在关闭。', 503);
    if (active) throw invalid('已有任务正在执行，请等待完成。', 409);
    const job = { id: randomUUID(), type, payload, projectRoot: root, generation, environmentRevision: readEnvironment(environmentFile).revision, status: 'running', createdAt: new Date().toISOString(), controller: new AbortController() };
    active = job; jobs.set(job.id, job);
    if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
    job.promise = Promise.resolve().then(async () => {
      const project = await current();
      if (type === 'doctor') return services.doctor(project, payload);
      if (type === 'build.batch') {
        job.entries = []; job.diagnostics = {};
        for (const target of payload.targets) {
          if (job.controller.signal.aborted) throw new Error('Build cancelled.');
          job.phase = 'doctor'; job.currentTarget = target;
          const report = await services.doctor(project, { target, profile: payload.profile });
          job.diagnostics[target] = report;
          if (!report.ok) { job.entries.push({ target, status: 'blocked', reasons: report.checks.filter(check => check.status === 'fail').map(check => check.message) }); continue; }
          try {
            const artifact = await services.buildProject(root, { target, profile: payload.profile, signal: job.controller.signal,
              onEvent: event => { job.phase = event.phase; job.artifactId = event.artifactId; job.output = ((job.output || '') + '[' + target + '] ' + event.message + '\n').slice(-24000); },
              onOutput: text => { job.output = ((job.output || '') + text).slice(-24000); } });
            job.entries.push({ target, status: 'built', artifactId: artifact.id });
          } catch (error) {
            job.entries.push({ target, status: 'failed', error: error.message, artifactId: error.artifactId });
            if (job.controller.signal.aborted) throw error;
          }
        }
        return { ok: job.entries.every(entry => entry.status === 'built'), profile: payload.profile, entries: job.entries };
      }
      if (type === 'build') return services.buildProject(root, { ...payload, signal: job.controller.signal,
        onEvent: event => { job.phase = event.phase; job.artifactId = event.artifactId; job.output = ((job.output || '') + event.message + '\n').slice(-24000); },
        onOutput: text => { job.output = ((job.output || '') + text).slice(-24000); } });
      if (type === 'validate') return services.validateArtifact(root, payload.artifactId);
      if (type === 'upload-plan') return services.planUpload(root, payload.artifactId, { channel: 'development' });
      if (type === 'config.save' || type === 'settings.save') {
        initial = await services.updateProject(root, payload.config, payload.revision);
        configSignature = JSON.stringify(initial.config);
        generation++;
        return { revision: initial.revision };
      }
      if (type === 'environment.save') { const result = saveEnvironment(payload.config, payload.revision, environmentFile); generation++; return result; }
      if (type === 'environment.detect') {
        const resolved = resolveEnvironment(project, payload.target, { settings: readEnvironment(environmentFile).config });
        const executable = await resolveExecutable(root, resolved.godot.executable || process.env.GODOT_BIN || 'godot');
        const version = parseGodotVersion((await probeTool(executable, ['--version'], { cwd: root })).output || '');
        return { godot: { ...(path.isAbsolute(executable) && fs.existsSync(executable) ? { executable } : {}), ...(version ? { version: version.number } : {}), ...(resolved.godot.templatesPath ? { templatesPath: path.resolve(root, resolved.godot.templatesPath) } : {}) }, android: { ...(resolved.androidSdkPath && fs.existsSync(resolved.androidSdkPath) ? { androidSdkPath: resolved.androidSdkPath } : {}), ...(resolved.javaHome && fs.existsSync(resolved.javaHome) ? { javaHome: resolved.javaHome } : {}) } };
      }
      if (type === 'project.open') {
        let next;
        if (payload.initialize) {
          next = initProject(payload.path);
          if (next.created) { next.config.godot = {}; next = await services.updateProject(next.root, next.config, next.revision); }
        } else next = await services.readProject(payload.path);
        await Promise.all([...previews.values()].map(preview => preview.close())); previews.clear();
        root = next.root; initial = next; configSignature = JSON.stringify(next.config); generation++; jobs.clear(); jobs.set(job.id, job);
        rememberProject(root, environmentFile); return { root, name: next.config.name };
      }
      if (type === 'preset.create') { const result = await ensureExportPreset(project, payload.target); generation++; return result; }
      if (type === 'evidence') return services.recordEvidence(root, payload.artifactId, payload);
      if (type === 'artifact.open') {
        const artifact = await services.readArtifact(root, payload.artifactId);
        const directory = path.join(artifact.directory, 'out');
        if (!fs.statSync(directory).isDirectory()) throw invalid('产物目录不存在。');
        const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        await new Promise((resolve, reject) => { const process = spawn(command, [directory], { shell: false, windowsHide: true, stdio: 'ignore' }); process.once('error', reject); process.once('spawn', () => { process.unref(); resolve(); }); });
        return { directory };
      }
      if (type === 'upload.execute') {
        if (payload.revision !== project.revision) throw invalid('工程设置已变化，请重新检查上传条件。');
        const plan = await services.planUpload(root, payload.artifactId, { channel: 'development' });
        if (!plan.canExecute || plan.outputsSha256 !== payload.outputsSha256) throw invalid('上传条件或产物已变化，请重新检查。');
        return (services.uploadArtifact || uploadArtifact)(root, payload.artifactId, { channel: 'development', execute: true });
      }
      if (type === 'receipt.record') return recordUploadReceipt(root, payload.releaseId, payload);
      if (type === 'preview') {
        let preview = previews.get(payload.artifactId);
        if (!preview) { preview = await services.startPreview(root, payload.artifactId); previews.set(payload.artifactId, preview); }
        return { url: preview.url, artifactId: payload.artifactId };
      }
      throw invalid('该操作尚未接入。');
    }).then(result => { job.result = result; job.status = 'completed'; }, error => {
      job.status = 'failed'; job.error = error.message;
      if (error.artifactId) job.artifactId = error.artifactId;
    }).finally(() => { job.finishedAt = new Date().toISOString(); active = null; });
    return jobView(job);
  }
  return {
    get projectRoot() { return root; },
    async snapshot() {
      const project = await current();
      const environment = readEnvironment(environmentFile);
      return { generation, project: { name: project.config.name, root, revision: project.revision, inspection: project.inspection }, environmentRevision: environment.revision,
        recentProjects: environment.config.recentProjects || [],
        platforms: Object.entries(PLATFORM_LABELS).map(([target, label]) => ({ target, label, configured: Object.hasOwn(project.config.targets, target), enabled: Object.hasOwn(project.config.targets, target) && project.config.targets[target].enabled !== false, family: getTarget(target).family, support: getTarget(target).status, requirements: getTarget(target).requirements, upload: project.config.targets[target]?.upload?.provider || 'handoff' })),
        profiles: Object.keys(project.config.profiles), artifacts: await services.listArtifacts(root),
        jobs: [...jobs.values()].reverse().map(jobView), activeJobId: active?.id ?? null,
        publication: { status: 'development-only', message: '先检查上传条件，再确认上传开发版本；审核与上线在平台操作。' } };
    },
    async artifact(artifactId) {
      await current(); id(artifactId);
      return { ...await services.readArtifact(root, artifactId), logText: await services.readArtifactLog(root, artifactId) };
    },
    async configuration() { const project = await current(); return { config: project.config, revision: project.revision }; },
    async environment() { return readEnvironment(environmentFile); },
    async releases() { await current(); return listReleases(root); },
    async release(releaseId) { await current(); id(releaseId); return readRelease(root, releaseId); },
    async job(jobId) { await current(); const job = jobs.get(id(jobId)); if (!job) throw invalid('任务不存在。', 404); return jobView(job); },
    async command(body) {
      await current(); fields(body, ['type', 'payload']);
      const { type, payload } = body;
      if (type === 'build.cancel') { fields(payload, ['jobId']); if (!active || active.id !== payload.jobId || !['build', 'build.batch'].includes(active.type)) throw invalid('当前没有可取消的构建。'); active.controller.abort(); active.phase = 'cancelling'; return jobView(active); }
      if (type === 'build.batch') {
        fields(payload, ['targets', 'profile']);
        if (!Array.isArray(payload.targets) || !payload.targets.length || payload.targets.length > 7 || new Set(payload.targets).size !== payload.targets.length || payload.targets.some(target => !getTarget(target) || !initial.config.targets[target] || initial.config.targets[target].enabled === false) || !initial.config.profiles[payload.profile]) throw invalid('批量构建只接受已启用的平台和已配置的构建模式。');
        return submit(type, payload);
      }
      if (type === 'paths.browse') { fields(payload, ['path'], ['directoriesOnly']); return { id: randomUUID(), type, status: 'completed', result: browsePaths(payload.path, payload) }; }
      if (type === 'project.open') { fields(payload, ['path', 'initialize']); if (typeof payload.path !== 'string' || !path.isAbsolute(payload.path) || typeof payload.initialize !== 'boolean') throw invalid('请选择包含 project.godot 的绝对路径。'); return submit(type, payload); }
      if (type === 'environment.save') { fields(payload, ['config', 'revision']); return submit(type, payload); }
      if (type === 'environment.detect') { fields(payload, ['target']); if (!getTarget(payload.target)) throw invalid('未知平台。'); return submit(type, payload); }
      if (type === 'settings.save') { fields(payload, ['config', 'revision']); validateConfig(payload.config); if (payload.revision !== initial.revision) throw invalid('工程配置已变化，请重新读取。', 409); return submit(type, payload); }
      if (type === 'preset.create') { fields(payload, ['target']); if (!Object.hasOwn(initial.config.targets, payload.target)) throw invalid('请先保存平台设置。'); return submit(type, payload); }
      if (type === 'evidence') { fields(payload, ['artifactId', 'kind', 'result', 'file'], ['note']); id(payload.artifactId); return submit(type, payload); }
      if (type === 'artifact.open') { fields(payload, ['artifactId']); id(payload.artifactId); return submit(type, payload); }
      if (type === 'upload.execute') { fields(payload, ['artifactId', 'revision', 'outputsSha256', 'confirmed']); if (payload.confirmed !== true) throw invalid('请先核对上传计划并确认上传开发版本。'); id(payload.artifactId); return submit(type, payload); }
      if (type === 'receipt.record') { fields(payload, ['releaseId', 'status', 'evidence'], ['remoteId']); id(payload.releaseId); return submit(type, payload); }
      if (type === 'config.save') {
        fields(payload, ['config', 'revision']);
        // Only non-executable publishing settings are editable from the browser.
        // Every other field, including all tool/SDK paths, must match the trusted launch configuration.
        const locked = config => {
          const value = structuredClone(config);
          for (const key of ['name', 'version', 'buildNumber', 'runtimeAddon', 'profiles']) delete value[key];
          if (value.targets && typeof value.targets === 'object') for (const target of Object.values(value.targets)) {
            if (target && typeof target === 'object') for (const key of ['enabled', 'preset', 'maxBytes']) delete target[key];
          }
          return value;
        };
        if (!payload.config || typeof payload.config !== 'object' || JSON.stringify(locked(payload.config)) !== JSON.stringify(locked(initial.config))) {
          throw invalid('工具、SDK 和证据路径只能在本机配置文件中修改，然后重启工作台。');
        }
        if (payload.revision !== initial.revision) throw invalid('工程配置版本已变化，请重新读取。', 409);
        return submit(type, payload);
      }
      if (type === 'doctor' || type === 'build') {
        fields(payload, ['target', 'profile']);
        if (!Object.hasOwn(initial.config.targets, payload.target) || !Object.hasOwn(PLATFORM_LABELS, payload.target)) throw invalid('该平台未配置。');
        if (type === 'build' && initial.config.targets[payload.target].enabled === false) throw invalid('该平台已停用，请先在平台设置中启用。');
        if (!Object.hasOwn(initial.config.profiles, payload.profile)) throw invalid('构建配置不存在。');
        return submit(type, { target: payload.target, profile: payload.profile });
      }
      if (['validate', 'preview', 'upload-plan'].includes(type)) { fields(payload, ['artifactId']); id(payload.artifactId); return submit(type, payload); }
      throw invalid('该操作尚未接入。');
    },
    async close() {
      stopping = true;
      if (['build', 'build.batch'].includes(active?.type)) active.controller.abort();
      await active?.promise;
      await Promise.all([...previews.values()].map(preview => preview.close()));
    },
  };
}
