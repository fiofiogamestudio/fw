#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FwvProject } from '../src/core/project.mjs';

const COMMANDS = {
  help: '', init: '[--name <project name>]', status: '',
  import: '--file <png/jpeg/webp> [--name <asset name>]',
  select: '--asset <id> --revision <id>',
  validate: '--asset <id> [--revision <id>]', export: '--asset <id> [--revision <id>]',
  editor: '[--fwe-path <FWE directory>] [--port 3230]',
  'skeleton2d-import': '--file <skeleton2d.json> [--name <name>] [--request-id <id>]',
  'skeleton2d-inspect': '--asset <id> --revision <id>',
  'skeleton2d-save': '--asset <id> --revision <id> --file <skeleton2d.json>',
  'skeleton2d-export': '--asset <id> --revision <id>',
};

export function parseArguments(argv) {
  const [command = 'help', ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!/^--[a-z][a-z-]*$/.test(token)) throw new Error(`Expected an option, received: ${token}.`);
    const key = token.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${token}.`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    options[key] = value;
  }
  return { command, options };
}

function required(options, key) {
  if (!options[key]) throw new Error(`--${key} is required.`);
  return options[key];
}

async function readInput(file) {
  const absolute = path.resolve(file);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Input must be a regular file of at most 32 MiB.');
  return fs.readFile(absolute);
}

export async function run(argv) {
  const { command, options } = parseArguments(argv);
  if (!Object.hasOwn(COMMANDS, command)) throw new Error(`Unknown command: ${command}. Run fwv help for available commands.`);
  if (command === 'help') return { usage: 'fwv <command> --project <directory> [options]', commands: COMMANDS };
  const allowed = new Set(['project', ...[...COMMANDS[command].matchAll(/--([a-z-]+)/g)].map(match => match[1])]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`Unknown option: --${key}.`);
  const projectRoot = path.resolve(options.project ?? '.');
  const project = new FwvProject(projectRoot);
  const revisionArgs = () => ({ assetId: required(options, 'asset'), revisionId: options.revision });
  switch (command) {
    case 'init': return project.init({ name: options.name });
    case 'status': return project.snapshot();
    case 'import': {
      const file = required(options, 'file');
      return project.importImage({ name: options.name, fileName: path.basename(file), buffer: await readInput(file) });
    }
    case 'select':
    case 'validate':
    case 'export': {
      const args = revisionArgs();
      if (command === 'select') args.revisionId = required(options, 'revision');
      const snapshot = await project.snapshot(), asset = project._asset(snapshot, args.assetId), revision = project._revision(asset, args.revisionId);
      if (['model3d', 'rig', 'reskin'].includes(asset.kind) || asset.kind !== 'skeleton2d' && !revision.files.some(file => /^image\/(png|jpeg|webp)$/i.test(file.mime))) {
        throw new Error('This command only supports 2D image assets and skeleton2d animations.');
      }
      const method = { select: 'selectRevision', validate: 'validateRevision', export: 'exportAsset' }[command];
      return project[method]({ assetId: asset.id, revisionId: revision.id });
    }
    case 'skeleton2d-import': {
      const { importSkeleton2d } = await import('../src/skeleton2d/application.mjs');
      const { validateSkeleton2dDocument } = await import('../src/skeleton2d/document.mjs');
      const file = path.resolve(required(options, 'file'));
      const document = validateSkeleton2dDocument(JSON.parse((await readInput(file)).toString('utf8').replace(/^\uFEFF/, '')));
      const textures = await Promise.all([...new Set(Object.values(document.textures))].map(async name => ({ name, buffer: await readInput(path.join(path.dirname(file), name)) })));
      return importSkeleton2d(project, { name: options.name, document, textures, idempotencyKey: options['request-id'] });
    }
    case 'skeleton2d-inspect':
    case 'skeleton2d-save':
    case 'skeleton2d-export': {
      const { inspectSkeleton2d, saveSkeleton2d, exportSkeleton2d } = await import('../src/skeleton2d/application.mjs');
      const args = { assetId: required(options, 'asset'), revisionId: required(options, 'revision') };
      if (command === 'skeleton2d-inspect') return inspectSkeleton2d(project, args);
      if (command === 'skeleton2d-export') return exportSkeleton2d(project, args);
      const document = JSON.parse((await readInput(required(options, 'file'))).toString('utf8').replace(/^\uFEFF/, ''));
      return saveSkeleton2d(project, { ...args, expectedRevisionId: args.revisionId, document });
    }
    case 'editor': {
      const { startEditor } = await import('../src/editor/server.mjs');
      const defaultFwe = fileURLToPath(new URL('../../fwe/', import.meta.url));
      const port = options.port === undefined ? 3230 : Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535.');
      const editor = await startEditor({ projectRoot, fwePath: path.resolve(options['fwe-path'] ?? defaultFwe), port });
      return { url: editor.url, projectRoot };
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}) })); process.exitCode = 1; }
}
