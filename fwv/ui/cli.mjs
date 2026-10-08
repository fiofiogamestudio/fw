#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest, buildGallery } from './core/manifest.mjs';
import { CaptureWorkspace } from './core/workspace.mjs';
import { startUiServer, DEFAULT_FWE_PATH } from './server.mjs';

const usage = 'Usage: fwv ui [serve|validate|export] --manifest <capture.json> [--fwe-path <FWE>] [--port <0..65535>] [--open] [--out <NEW directory>]';
export function parseUiArguments(argv) {
  if (argv.length === 0 || argv.some(value => ['--help', '-h'].includes(value))) return { command: 'help' };
  const args = [...argv], command = args[0].startsWith('--') ? 'serve' : args.shift(), values = {};
  if (!['serve', 'validate', 'export'].includes(command)) throw new Error(usage);
  const allowed = { serve: ['--manifest', '--fwe-path', '--port', '--open'], validate: ['--manifest'], export: ['--manifest', '--out'] }[command];
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.includes(key) || Object.hasOwn(values, key)) throw new Error(`Invalid or duplicate option: ${key}. ${usage}`);
    if (key === '--open') { values[key] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing ${key} value. ${usage}`);
    values[key] = value;
  }
  if (!values['--manifest'] || command === 'export' && !values['--out']) throw new Error(usage);
  const port = values['--port'] ?? '0';
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('port must be 0..65535.');
  return { command, manifestPath: path.resolve(values['--manifest']), fwePath: path.resolve(values['--fwe-path'] || DEFAULT_FWE_PATH), port: Number(port), open: values['--open'] === true,
    ...(values['--out'] ? { outDirectory: path.resolve(values['--out']) } : {}) };
}
export async function runUi(argv) {
  const options = parseUiArguments(argv);
  if (options.command === 'help') return { usage };
  if (options.command === 'validate') {
    const checked = await validateManifest(options.manifestPath);
    return { ok: true, manifestPath: options.manifestPath, manifestId: checked.capture.generated.sourceManifestSha256, summary: checked.capture.summary };
  }
  if (options.command === 'export') {
    const workspace = await CaptureWorkspace.open(options.manifestPath);
    return buildGallery({ ...options, review: await workspace.review.read() });
  }
  const editor = await startUiServer(options);
  const stop = () => { void editor.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  editor.closed.then(() => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
  return { url: editor.url, manifestPath: editor.manifestPath, manifestId: editor.workspace.manifestId, summary: editor.workspace.summary };
}
export const run = runUi;
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  runUi(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(`fwv ui: ${error.message}`); process.exitCode = 1; });
