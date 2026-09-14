import fs from 'node:fs';
import path from 'node:path';
import { getTarget } from '../platforms.mjs';
import { child, fail } from './files.mjs';
import { inspectExportPresets, resolvePresetName } from '../doctor.mjs';

export async function ensureExportPreset(project, target) {
  const descriptor = getTarget(target);
  if (!descriptor?.platform) fail('adapter-required', '小游戏需要平台适配器提供真实导出预设，不能用 Web 预设代替。');
  const file = child(project.root, 'export_presets.cfg');
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const presets = source ? await inspectExportPresets(project.root) : [];
  const name = resolvePresetName(target, project.config.targets[target]);
  if (presets.some(preset => preset.name === name)) return { created: false, name, message: '已有同名预设，保留现有内容。' };
  const index = Math.max(-1, ...presets.map(preset => preset.index)) + 1;
  const options = descriptor.platform === 'Web' ? 'variant/thread_support=false\nvariant/extensions_support=false\nprogressive_web_app/enabled=false\n'
    : descriptor.platform === 'Android' ? 'gradle_build/use_gradle_build=false\ngradle_build/export_format=0\narchitectures/arm64-v8a=true\npackage/signed=true\n' : '';
  const addition = `\n[preset.${index}]\nname=${JSON.stringify(name)}\nplatform=${JSON.stringify(descriptor.platform)}\nrunnable=true\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path=""\nscript_export_mode=2\n\n[preset.${index}.options]\n${options}`;
  // Only append a missing preset; existing platform options remain untouched.
  fs.appendFileSync(file, addition);
  return { created: true, name, file, message: '已添加基础导出预设。请重新检查环境。' };
}
