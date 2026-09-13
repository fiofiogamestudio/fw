import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { launch, powershell } from '../src/process.mjs';

const program = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.dirname(program);
const components = {
  fwa: { label: '开发工作台 · 需求、变化与验收', entry: 'tools/start-editor.mjs' },
  fwv: { label: 'FWD 美术工作台 · 素材、候选与验收', entry: 'tools/start-editor.mjs' },
  fwe: { label: '通用编辑器', entry: 'bin/start.js' },
  fwc: { label: 'Godot 框架 / 打开宿主工程', entry: 'tools/start.ps1' },
  fws: { label: '技能库', entry: 'tools/start.ps1' },
};

async function main(argv) {
  let [selected, ...args] = argv;
  if (selected === '--help' || selected === '-h') {
    console.log('FW 启动入口\n  start.bat [fwa|fwd|fwv|fwe|fwc|fws] [组件参数]\n  start.bat --check\nfwd 使用现有 fwv/ 美术组件和项目。演示数据与报告保存在各组件的 .local/，已有工程需显式选择。');
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
    console.log('FW 组件工作台\n');
    ids.forEach((id, index) => console.log(`  ${index + 1}. ${id.toUpperCase()} — ${components[id].label}`));
    console.log('  0. 退出\n');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await input.question('选择要打开的组件：')).trim().toLowerCase();
    input.close();
    if (answer === '0' || !answer) return;
    selected = ids[Number(answer) - 1] ?? answer;
  }
  if (selected === 'fwd') selected = 'fwv';
  const target = components[selected];
  if (!target) throw new Error(`未知组件：${selected}。使用 --help 查看入口。`);
  const root = path.join(workspace, selected);
  const entry = path.join(root, target.entry);
  if (!fs.existsSync(entry)) throw new Error(`启动入口缺失：${entry}。请先恢复该组件。`);
  if (target.entry.endsWith('.ps1')) {
    await launch(powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry, ...args], root);
  } else {
    await launch(process.execPath, [entry, ...args], root);
  }
}

try { await main(process.argv.slice(2)); }
catch (error) { console.error(`[FW] ${error.message}`); process.exitCode = 1; }
