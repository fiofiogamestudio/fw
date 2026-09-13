#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FwvProject } from '../src/core/project.mjs';

export function parseArguments(argv) {
  const [command = 'help', ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!/^--[a-z][a-z-]*$/.test(token)) throw new Error(`Expected an option, received: ${token}.`);
    const key = token.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${token}.`);
    if (key === 'trim') options[key] = true;
    else {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
      options[key] = value;
    }
  }
  return { command, options };
}

function required(options, key) {
  if (!options[key]) throw new Error(`--${key} is required.`);
  return options[key];
}

function integer(options, key, fallback) {
  if (options[key] === undefined) return fallback;
  if (!/^-?\d+$/.test(options[key])) throw new Error(`--${key} must be an integer.`);
  return Number(options[key]);
}

async function readInput(file) {
  const absolute = path.resolve(file);
  const stat = await fs.stat(absolute);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Input must be a file of at most 32 MiB.');
  return fs.readFile(absolute);
}

async function preserveGeneration(output, reference, job) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fwv-generation-recovery-'));
  const imagePath = path.join(directory, output.name);
  const manifestPath = path.join(directory, 'recovery.json');
  await fs.writeFile(imagePath, output.buffer, { flag: 'wx', mode: 0o600 });
  const manifest = {
    schemaVersion: 1, status: 'generated-not-imported', requestId: job.requestId,
    image: { name: output.name, mime: output.mime, bytes: output.buffer.length, sha256: createHash('sha256').update(output.buffer).digest('hex') },
    request: output.request, providerRequestId: output.requestId, usage: output.usage,
    revisedPrompt: output.revisedPrompt, createdAt: new Date().toISOString(),
  };
  if (reference) {
    const extension = reference.mime === 'image/jpeg' ? 'jpg' : reference.mime === 'image/webp' ? 'webp' : 'png';
    const fileName = `reference.${extension}`;
    await fs.writeFile(path.join(directory, fileName), reference.buffer, { flag: 'wx', mode: 0o600 });
    manifest.reference = { ...job.input.reference, fileName, mime: reference.mime, sha256: createHash('sha256').update(reference.buffer).digest('hex') };
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { directory, imagePath, manifestPath };
}

async function generate(project, options, env) {
  if (Boolean(options.prompt) === Boolean(options['prompt-file'])) throw new Error('Choose exactly one of --prompt or --prompt-file.');
  const referenceFields = ['reference-asset', 'reference-revision', 'reference-file'];
  const referenceCount = referenceFields.filter(key => options[key] !== undefined).length;
  if (referenceCount !== 0 && referenceCount !== 3) throw new Error('Reference input requires --reference-asset, --reference-revision and --reference-file together.');
  let prompt = options.prompt;
  if (options['prompt-file']) {
    const file = path.resolve(options['prompt-file']);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Prompt file must be a UTF-8 text file of at most 64 KiB.');
    prompt = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  }
  await project.snapshot(); // Establish project identity before a potentially billable request.
  const [{ ImagesProvider }, { GenerationJobs }] = await Promise.all([
    import('../src/generation/provider.mjs'), import('../src/generation/jobs.mjs'),
  ]);
  const provider = new ImagesProvider({ env });
  let output, reference;
  const jobs = new GenerationJobs({ project, provider: {
    publicConfig: () => provider.publicConfig(),
    generate: async args => {
      reference = args.reference ? { ...args.reference, buffer: Buffer.from(args.reference.buffer) } : undefined;
      output = await provider.generate(args);
      return output;
    },
  } });
  const input = { requestId: options['request-id'] ?? randomUUID(), prompt };
  for (const key of ['name', 'size', 'quality', 'background']) if (options[key] !== undefined) input[key] = options[key];
  if (referenceCount) input.reference = { assetId: options['reference-asset'], revisionId: options['reference-revision'], fileName: options['reference-file'] };
  let job;
  const cancel = () => { if (job) void jobs.cancel({ jobId: job.id }); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    job = await jobs.start(input);
    // A previous invocation may already have received and staged this exact result.
    if (job.status === 'ready' && job.durability === 'staged') job = await jobs.save({ jobId: job.id });
    while (['queued', 'running'].includes(job.status)) { await delay(100); job = jobs.get({ jobId: job.id }); }
    if (job.status === 'succeeded') return { status: job.status, job, provider: provider.publicConfig() };
    if (job.status === 'ready' && job.durability === 'staged') {
      const manifestPath = await project._path(['.fwv', 'generation', job.id, 'result.json']);
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const imageFile = manifest.files.find(file => file.role === 'image');
      const imagePath = await project._path(['.fwv', 'generation', job.id, imageFile.name]);
      const recovery = { directory: path.dirname(manifestPath), imagePath, manifestPath };
      throw Object.assign(new Error('Image generation completed, but project import failed. Exact image bytes and provenance were preserved in the project recovery directory. Repeat the same request ID to retry local saving; do not repeat the paid generation request.'), { code: 'GENERATION_SAVE_FAILED', status: 'ready', uncertain: false, job, recovery });
    }
    if (job.status === 'ready' && output) {
      let recovery;
      try { recovery = await preserveGeneration(output, reference, job); }
      catch (error) {
        throw Object.assign(new Error(`Image generation completed, but project import and recovery storage both failed: ${error.message}. The image may have been charged and could not be preserved. Do not retry generation automatically.`), { code: 'GENERATION_RECOVERY_FAILED', status: 'ready', uncertain: false, job });
      }
      throw Object.assign(new Error('Image generation completed, but project import failed. Exact image bytes and provenance were preserved in the recovery directory. Import the recovered image; do not repeat the paid generation request.'), { code: 'GENERATION_SAVE_FAILED', status: 'ready', uncertain: false, job, recovery });
    }
    throw Object.assign(new Error(job.error || `Generation ended with status ${job.status}.`), { code: `GENERATION_${job.status.toUpperCase()}`, status: job.status, uncertain: job.status === 'unknown', job });
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); await jobs.close();
  }
}

export async function run(argv, { env = process.env } = {}) {
  const { command, options } = parseArguments(argv);
  const allowed = {
    help: [], init: ['name'], status: [], import: ['file', 'name'],
    process: ['asset', 'revision', 'width', 'height', 'padding', 'trim', 'background', 'fit', 'remove-color', 'tolerance'],
    select: ['asset', 'revision'], validate: ['asset', 'revision'], export: ['asset', 'revision'],
    editor: ['fwe-path', 'port'], 'spine-import': ['directory', 'name'],
    'spine-replace': ['asset', 'revision', 'region', 'file', 'scale', 'x', 'y', 'rotation'],
    generate: ['prompt', 'prompt-file', 'name', 'size', 'quality', 'background', 'reference-asset', 'reference-revision', 'reference-file', 'request-id'],
    'provider-check': [],
    changes: ['change'], change: ['file'], 'change-prepare': ['change'],
    'model-import': ['file', 'name'], 'model-inspect': ['asset', 'revision'], model: ['file'],
    'rig-create': ['source-asset', 'source-revision', 'name'],
    'rig-inspect': ['asset', 'revision'], 'rig-save': ['asset', 'revision', 'file'], 'rig-build': ['asset', 'revision'],
    'local-task': ['workflow', 'attempt', 'out'], 'local-claim': ['workflow', 'attempt', 'worker', 'out'],
    'local-analyze': ['task', 'analysis-file'], 'local-dispatch': ['task'],
    'local-fail': ['task', 'message'],
    'local-complete': ['task', 'image-asset', 'image-revision', 'provider', 'model', 'tool', 'notes'],
  };
  if (!allowed[command]) throw new Error(`Unknown command: ${command}. Run fwv help for available commands.`);
  for (const key of Object.keys(options)) if (key !== 'project' && !allowed[command].includes(key)) throw new Error(`--${key} is not supported by ${command}.`);
  const projectRoot = path.resolve(options.project ?? '.');
  const project = new FwvProject(projectRoot);
  const revisionArgs = () => ({ assetId: required(options, 'asset'), revisionId: options.revision });
  switch (command) {
    case 'help': return {
      name: 'fwv', version: '0.1.0', projectOption: '--project <directory>',
      commands: {
        init: '--name <project name>', status: '',
        import: '--file <png/jpeg/webp> [--name <asset name>]',
        process: '--asset <id> [--revision <id>] [--width 256] [--height 256] [--padding 0] [--trim] [--background transparent] [--remove-color #RRGGBB] [--tolerance 0]',
        select: '--asset <id> --revision <id>', validate: '--asset <id> [--revision <id>]', export: '--asset <id> [--revision <id>]',
        editor: '[--fwe-path <FWE directory>] [--port 3230]',
        'spine-import': '--directory <JSON/Atlas/PNG directory> [--name <asset name>]',
        'spine-replace': '--asset <id> [--revision <id>] --region <atlas region> --file <image> [--scale 1] [--x 0] [--y 0] [--rotation 0]',
        generate: '(--prompt <text> | --prompt-file <UTF-8 file>) [--name <asset name>] [--size 1024x1024] [--quality auto] [--background auto] [--reference-asset <id> --reference-revision <id> --reference-file <name>] [--request-id <id>]',
        'provider-check': 'Check provider authentication using the explicit FWV_IMAGE_* environment variables.',
        changes: '[--change <change id>] List requests or inspect one exact request.',
        change: '--file <UTF-8 JSON containing type: change.*, payload: {...}>. Uses the same application commands as the workbench.',
        'change-prepare': '--change <change id> Read exact inputs and local Agent instructions without executing a model.',
        'model-import': '--file <self-contained .glb> [--name <asset name>] Import a model of at most 20 MiB.',
        'model-inspect': '--asset <model id> --revision <revision id> Inspect model, bones, materials, textures and technical checks.',
        model: '--file <UTF-8 JSON command of at most 64 KiB: type: model.*, payload: {...}>. Runs the same model repair and texture commands as the workbench.',
        'rig-create': '--source-asset <image id> --source-revision <revision id> --name <name>',
        'rig-inspect': '--asset <draft id> --revision <revision id>',
        'rig-save': '--asset <draft id> --revision <revision id> --file <JSON containing parts and motion>',
        'rig-build': '--asset <draft id> --revision <revision id>',
        'local-task': '--workflow <id> --attempt <id> [--out <bundle parent directory>]',
        'local-claim': '--workflow <id> --attempt <id> --worker <agent id> [--out <bundle parent directory>]',
        'local-analyze': '--task <claimed task.json> --analysis-file <summary/partNotes/risks JSON>',
        'local-dispatch': '--task <claimed task.json> (record once immediately before calling the image tool)',
        'local-fail': '--task <claimed task.json> --message <actual failure; dispatched calls remain unknown>',
        'local-complete': '--task <claimed task.json> --image-asset <imported id> --image-revision <revision id> --provider <actual provider> --model <actual model> --tool <actual tool> [--notes <text>]',
      },
      imageProviderEnvironment: ['FWV_IMAGE_API_KEY', 'FWV_IMAGE_BASE_URL', 'FWV_IMAGE_MODEL'],
      generationRequestIds: 'Request IDs persist within the project and identify exact input and provider settings. Repeating the same request recovers local results without submitting again; an uncertain dispatched request is never retried automatically.',
    };
    case 'init': return project.init({ name: options.name });
    case 'status': return project.snapshot();
    case 'import': {
      const file = required(options, 'file');
      return project.importImage({ name: options.name, fileName: path.basename(file), buffer: await readInput(file) });
    }
    case 'process': {
      const recipe = {
        width: integer(options, 'width', 256), height: integer(options, 'height', 256), padding: integer(options, 'padding', 0),
        trim: options.trim ?? false, fit: options.fit ?? 'contain', background: options.background ?? 'transparent',
      };
      if (options['remove-color'] !== undefined) recipe.removeBackground = { color: options['remove-color'], tolerance: integer(options, 'tolerance', 0) };
      return project.processImage({ ...revisionArgs(), recipe });
    }
    case 'select': return project.selectRevision({ assetId: required(options, 'asset'), revisionId: required(options, 'revision') });
    case 'validate': return project.validateRevision(revisionArgs());
    case 'export': return project.exportAsset(revisionArgs());
    case 'generate': return generate(project, options, env);
    case 'model-import': {
      const { importModel } = await import('../src/model/application.mjs');
      const file = required(options, 'file');
      return importModel(project, { name: options.name, fileName: path.basename(file), buffer: await readInput(file) });
    }
    case 'model-inspect': {
      const { inspectModel } = await import('../src/model/application.mjs');
      return inspectModel(project, { assetId: required(options, 'asset'), revisionId: required(options, 'revision') });
    }
    case 'model': {
      const [{ ArtChanges }, { executeModelCommand }] = await Promise.all([import('../src/workflows/changes.mjs'), import('../src/editor/model-api.mjs')]);
      const file = await readInput(required(options, 'file'));
      if (file.length > 64 * 1024) throw new Error('Model command JSON must not exceed 64 KiB. Use model-import for a GLB file.');
      const body = JSON.parse(file.toString('utf8').replace(/^\uFEFF/, ''));
      return executeModelCommand({ application: project, artChanges: new ArtChanges({ project }) }, body);
    }
    case 'changes':
    case 'change':
    case 'change-prepare': {
      const [{ ArtChanges, executeChangeCommand }, { GenerationJobs }, { ImagesProvider }] = await Promise.all([
        import('../src/workflows/changes.mjs'), import('../src/generation/jobs.mjs'), import('../src/generation/provider.mjs'),
      ]);
      const jobs = new GenerationJobs({ project, provider: new ImagesProvider({ env }) });
      const changes = new ArtChanges({ project, generationJobs: jobs });
      try {
        if (command === 'changes') return options.change ? changes.get({ changeId: options.change }) : changes.list();
        if (command === 'change-prepare') return changes.prepare({ changeId: required(options, 'change') });
        const file = await readInput(required(options, 'file'));
        if (file.length > 64 * 1024) throw new Error('Change command JSON must not exceed 64 KiB.');
        const body = JSON.parse(file.toString('utf8').replace(/^\uFEFF/, ''));
        let result = await executeChangeCommand(changes, body);
        if (body.type === 'change.candidate.generate') {
          while (result.generations.some(attempt => ['queued', 'running'].includes(attempt.status))) {
            await delay(100); result = await changes.get({ changeId: body.payload.changeId });
          }
        }
        return result;
      } finally { await jobs.close(); }
    }
    case 'local-task':
    case 'local-claim':
    case 'local-analyze':
    case 'local-dispatch':
    case 'local-fail':
    case 'local-complete': {
      const { runLocalCommand } = await import('../src/workflows/local-cli.mjs');
      return runLocalCommand(project, command, options);
    }
    case 'rig-create': {
      const { createRigDraft } = await import('../src/rig/application.mjs');
      return createRigDraft(project, { sourceAssetId: required(options, 'source-asset'), sourceRevisionId: required(options, 'source-revision'), name: required(options, 'name'), preset: 'humanoid6' });
    }
    case 'rig-inspect':
    case 'rig-save':
    case 'rig-build': {
      const { loadRigDraft, saveRigDraft, buildRigCandidate } = await import('../src/rig/application.mjs');
      const args = { assetId: required(options, 'asset'), revisionId: required(options, 'revision') };
      if (command === 'rig-inspect') return loadRigDraft(project, args);
      if (command === 'rig-build') return buildRigCandidate(project, args);
      const input = await readInput(required(options, 'file'));
      if (input.length > 1024 * 1024) throw new Error('Rig annotations must be at most 1 MiB.');
      const document = JSON.parse(input.toString('utf8').replace(/^\uFEFF/, ''));
      if (!document || typeof document !== 'object' || Array.isArray(document) || Object.keys(document).sort().join(',') !== 'motion,parts') throw new Error('Rig annotation file must contain exactly parts and motion.');
      return saveRigDraft(project, { ...args, parts: document.parts, motion: document.motion });
    }
    case 'provider-check': {
      const { ImagesProvider } = await import('../src/generation/provider.mjs');
      const provider = new ImagesProvider({ env });
      return { provider: provider.publicConfig(), check: await provider.checkConnection() };
    }
    case 'spine-import': {
      const { importSpine } = await import('../src/spine/application.mjs');
      const directory = path.resolve(required(options, 'directory'));
      const names = (await fs.readdir(directory, { withFileTypes: true })).filter(file => file.isFile() && /\.(json|atlas|png)$/i.test(file.name)).map(file => file.name);
      const files = await Promise.all(names.map(async name => ({ name, buffer: await readInput(path.join(directory, name)) })));
      return importSpine(project, { name: options.name, files });
    }
    case 'spine-replace': {
      const { replaceSpinePart } = await import('../src/spine/application.mjs');
      return replaceSpinePart(project, { ...revisionArgs(), regionName: required(options, 'region'), buffer: await readInput(required(options, 'file')),
        transform: { scale: Number(options.scale ?? 1), offsetX: Number(options.x ?? 0), offsetY: Number(options.y ?? 0), rotation: Number(options.rotation ?? 0) } });
    }
    case 'editor': {
      const { startEditor } = await import('../src/editor/server.mjs');
      const defaultFwe = fileURLToPath(new URL('../../fwe/', import.meta.url));
      const editor = await startEditor({ projectRoot, fwePath: path.resolve(options['fwe-path'] ?? defaultFwe), port: integer(options, 'port', 3230) });
      return { url: editor.url, projectRoot };
    }
    default: throw new Error(`Unknown command: ${command}. Run fwv help for available commands.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2)); }
  catch (error) {
    const result = { error: error.message };
    for (const key of ['code', 'status', 'uncertain', 'job', 'recovery']) if (error[key] !== undefined) result[key] = error[key];
    console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}
