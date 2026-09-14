import path from 'node:path';
import { readProject, initProject } from './core/project.mjs';
import { buildProject, listArtifacts, readArtifact, readArtifactLog, validateArtifact, recordEvidence } from './core/build.mjs';
import { startPreview } from './core/preview.mjs';
import { doctor } from './doctor.mjs';
import { targets } from './platforms.mjs';
import { fail } from './core/files.mjs';

const help = `FWB — Godot build and distribution workbench

  fwb init --project <game> [--godot <executable>] [--godot-version <4.x.y>]
  fwb targets
  fwb doctor --project <game> [--target web] [--profile debug]
  fwb build --project <game> [--target web] [--profile debug]
  fwb artifacts --project <game>
  fwb artifact|logs|validate --project <game> --artifact <id>
  fwb preview --project <game> --artifact <id> [--port <number>]
  fwb evidence --project <game> --artifact <id> --kind runtime|platform --result passed|failed --file <report>
  fwb upload-plan|upload --project <game> --artifact <id> --channel <name> [--execute]
  fwb editor --project <game> --fwe-path <directory> [--port <number>] [--no-open]

Builds use an isolated copy and keep their logs and manifests in .local/fwb.
Package validation, runtime evidence, and platform acceptance are separate.
Upload defaults to a plan. No command automatically submits or releases a game.
`;

export function parseArgs(args) {
  const positional = []; const options = {};
  const values = new Set(['project', 'godot', 'godot-version', 'target', 'profile', 'artifact', 'port', 'fwe-path', 'channel', 'kind', 'result', 'file']);
  const flags = new Set(['help', 'json', 'execute', 'no-open']);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    if (Object.hasOwn(options, key)) fail('invalid-arguments', `Repeated option: ${value}`);
    if (flags.has(key)) options[key] = true;
    else if (values.has(key) && args[index + 1] && !args[index + 1].startsWith('--')) options[key] = args[++index];
    else fail('invalid-arguments', `Unknown option or missing value: ${value}`);
  }
  if (positional.length > 1) fail('invalid-arguments', 'Pass project and artifact paths using named options.');
  return { command: positional[0], options };
}

export async function main(args) {
  const { command, options } = parseArgs(args);
  if (!command || options.help) { console.log(help); return; }
  const accepted = {
    init: ['project', 'godot', 'godot-version'], targets: [], doctor: ['project', 'target', 'profile'], build: ['project', 'target', 'profile'],
    artifacts: ['project'], artifact: ['project', 'artifact'], logs: ['project', 'artifact'], validate: ['project', 'artifact'], preview: ['project', 'artifact', 'port'],
    editor: ['project', 'fwe-path', 'port', 'no-open'], 'upload-plan': ['project', 'artifact', 'channel'], upload: ['project', 'artifact', 'channel', 'execute'],
    evidence: ['project', 'artifact', 'kind', 'result', 'file'],
  };
  if (!accepted[command]) fail('unknown-command', `Unknown command: ${command}`);
  for (const key of Object.keys(options)) if (!['json', 'help', ...accepted[command]].includes(key)) fail('invalid-arguments', `--${key} is not valid for ${command}.`);
  if (command !== 'targets' && !options.project) fail('missing-project', 'Specify --project <game>.');
  const root = path.resolve(options.project ?? '.');
  const report = value => { console.log(JSON.stringify(value, null, 2)); if (value?.ok === false) process.exitCode = 1; return value; };
  if (command === 'targets') return report(targets);
  if (command === 'init') return report(initProject(root, { godot: options.godot, godotVersion: options['godot-version'] }));
  if (command === 'doctor') return report(await doctor(readProject(root), options));
  if (command === 'build') {
    const controller = new AbortController(); const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try { return report(await buildProject(root, { ...options, signal: controller.signal, onEvent: event => console.error(`[${event.phase}] ${event.message}`) })); }
    finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
  if (command === 'artifacts') return report(listArtifacts(root));
  if (command === 'editor') {
    const { startEditor } = await import('./editor/server.mjs');
    const editor = await startEditor({ projectRoot: root, fwePath: options['fwe-path'] ? path.resolve(options['fwe-path']) : undefined, port: Number(options.port ?? 0), open: !options['no-open'] && process.env.FWE_NO_BROWSER !== '1' });
    report({ ok: true, url: editor.url });
    const close = async () => { await editor.close(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    return editor;
  }
  if (!options.artifact) fail('missing-artifact', 'Specify --artifact <id>.');
  if (command === 'artifact') return report(readArtifact(root, options.artifact));
  if (command === 'logs') { console.log(readArtifactLog(root, options.artifact)); return; }
  if (command === 'validate') return report(await validateArtifact(root, options.artifact));
  if (command === 'evidence') return report(await recordEvidence(root, options.artifact, options));
  if (command === 'preview') {
    const preview = await startPreview(root, options.artifact, { port: Number(options.port ?? 0) });
    report({ ok: true, artifactId: options.artifact, url: preview.url });
    process.once('SIGINT', () => preview.close()); process.once('SIGTERM', () => preview.close());
    return preview;
  }
  if (command === 'upload-plan' || command === 'upload') {
    const { planUpload, uploadArtifact } = await import('./core/publish.mjs');
    return report(command === 'upload-plan' ? await planUpload(root, options.artifact, { channel: options.channel }) : await uploadArtifact(root, options.artifact, { channel: options.channel, execute: options.execute === true }));
  }
}
