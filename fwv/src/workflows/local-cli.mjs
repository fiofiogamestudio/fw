import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ReskinWorkflows } from './reskin.mjs';

const required = (options, key) => { if (!options[key]) throw new Error(`--${key} is required.`); return options[key]; };
async function readJson(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Local task input must be a JSON file of at most 1 MiB.');
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
const hash = buffer => createHash('sha256').update(buffer).digest('hex');

/** This CLI hands work to an agent. It never starts a model or reads provider keys. */
export async function runLocalCommand(project, command, options) {
  const workflows = new ReskinWorkflows({ project });
  try {
    const snapshot = await project.snapshot();
    if (command === 'local-claim' || command === 'local-task') {
      const args = { workflowId: required(options, 'workflow'), attemptId: required(options, 'attempt') };
      const result = command === 'local-claim'
        ? await workflows.localClaim({ ...args, workerId: required(options, 'worker') })
        : await workflows.localTask(args);
      if (!options.out) return result;
      const directory = path.resolve(options.out);
      await fs.mkdir(directory, { recursive: true });
      // Each export gets a fresh directory, including idempotent claim retries.
      const bundle = await fs.mkdtemp(path.join(directory, 'fwv-task-'));
      const reference = await project.readArtifact(result.task.reference);
      const task = { schemaVersion: 1, projectId: snapshot.id, projectRoot: project.root, ...result.task,
        referencePath: path.join(bundle, 'reference.png'), referenceSha256: hash(reference.buffer),
        promptPath: path.join(bundle, 'prompt.txt') };
      await fs.writeFile(task.referencePath, reference.buffer, { flag: 'wx' });
      await fs.writeFile(task.promptPath, `${task.prompt}\n`, { flag: 'wx' });
      const taskPath = path.join(bundle, 'task.json');
      await fs.writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      return { ...result, bundle, taskPath };
    }
    const task = await readJson(path.resolve(required(options, 'task')));
    if (task.schemaVersion !== 1 || task.projectId !== snapshot.id) throw new Error('Task belongs to a different FWV project or protocol.');
    const args = { workflowId: task.workflowId, attemptId: task.attemptId, claimId: task.claimId };
    if (!args.claimId) throw new Error('Claim this task before running a worker command.');
    if (command === 'local-analyze') {
      const workflow = await workflows.localAnalyze({ ...args, analysis: await readJson(path.resolve(required(options, 'analysis-file'))) });
      const { task: current } = await workflows.localTask({ workflowId: args.workflowId, attemptId: args.attemptId });
      const promptPath = path.join(path.dirname(path.resolve(options.task)), `prompt-${workflow.revisionId}.txt`);
      try { await fs.writeFile(promptPath, `${current.prompt}\n`, { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(promptPath, 'utf8') !== `${current.prompt}\n`) throw error; }
      return { workflow, prompt: current.prompt, promptPath };
    }
    if (command === 'local-dispatch') return await workflows.localDispatch(args);
    if (command === 'local-fail') return await workflows.localFail({ ...args, error: required(options, 'message') });
    if (command === 'local-complete') return await workflows.localComplete({ ...args,
      imageAssetId: required(options, 'image-asset'), imageRevisionId: required(options, 'image-revision'),
      execution: { provider: required(options, 'provider'), model: required(options, 'model'), tool: required(options, 'tool'),
        ...(options.notes ? { notes: options.notes } : {}) } });
    throw new Error(`Unsupported local command: ${command}.`);
  } finally { workflows.close(); }
}
