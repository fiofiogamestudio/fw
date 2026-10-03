import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { launch, powershell } from '../src/process.mjs';

const program = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.dirname(program);
const components = {
  fwa: { label: 'Development workbench - goals, changes and acceptance', entry: 'tools/start-editor.mjs' },
  fwv: { label: 'FWD 2D editor - image gallery and skeletal animation', entry: 'tools/start-editor.mjs' },
  fwb: { label: 'Build workbench - platforms, checks and packages', entry: 'tools/start-editor.mjs' },
  fwe: { label: 'Content editor', entry: 'bin/start.js' },
  fwc: { label: 'Godot framework / open a host project', entry: 'tools/start.ps1' },
  fws: { label: 'Agent skills', entry: 'tools/start.ps1' },
};

async function main(argv) {
  let [selected, ...args] = argv;
  if (selected === '--help' || selected === '-h') {
    console.log('FW launcher\n  start.bat [fwa|fwv|fwb|fwe|fwc|fws] [component arguments]\n  start.bat --check\nFWV uses the fwv/ package and existing asset project. Component demos and reports use .local/. Pass an explicit project to open an existing host.');
    return;
  }
  if (selected === '--check') {
    const entries = Object.entries(components).map(([id, value]) => ({ id, entry: path.join(workspace, id, value.entry), bat: path.join(workspace, id, 'start.bat') }));
    const missing = entries.filter(value => !fs.existsSync(value.entry) || !fs.existsSync(value.bat));
    console.log(JSON.stringify({ ok: missing.length === 0, workspace, entries, missing }, null, 2));
    if (missing.length) process.exitCode = 1;
    return;
  }
  if (!selected) {
    const ids = Object.keys(components);
    console.log('FW Component Workbench\n');
    ids.forEach((id, index) => console.log(`  ${index + 1}. ${id.toUpperCase()} — ${components[id].label}`));
    console.log('  0. Exit\n');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await input.question('Select a component: ')).trim().toLowerCase();
    input.close();
    if (answer === '0' || !answer) return;
    selected = ids[Number(answer) - 1] ?? answer;
  }
  if (selected === 'fwd') selected = 'fwv'; // Legacy launcher alias; FWV is the canonical name.
  const target = components[selected];
  if (!target) throw new Error(`Unknown component: ${selected}. Use --help to list entry points.`);
  const root = path.join(workspace, selected);
  const entry = path.join(root, target.entry);
  if (!fs.existsSync(entry)) throw new Error(`Missing component entry: ${entry}. Restore the selected component first.`);
  if (target.entry.endsWith('.ps1')) {
    await launch(powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry, ...args], root);
  } else {
    await launch(process.execPath, [entry, ...args], root);
  }
}

try { await main(process.argv.slice(2)); }
catch (error) { console.error(`[FW] ${error.message}`); process.exitCode = 1; }
