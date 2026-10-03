import fs from 'node:fs';
import path from 'node:path';
import { getTarget } from '../platforms.mjs';
import { child, fail } from './files.mjs';
import { inspectExportPresets, resolvePresetName } from '../doctor.mjs';
import { usesWebConversion } from './minigame-export.mjs';

export async function ensureExportPreset(project, target) {
  const descriptor = getTarget(target);
  const platform = usesWebConversion(target, project.config.targets[target]) ? 'Web' : descriptor?.platform;
  if (!platform) fail('adapter-required', '小游戏需要平台适配器提供真实导出预设，或显式配置微信 convertScript 后补全 Web 中间预设。');
  const file = child(project.root, 'export_presets.cfg');
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const presets = source ? await inspectExportPresets(project.root) : [];
  const name = resolvePresetName(target, project.config.targets[target]);
  if (presets.some(preset => preset.name === name)) return { created: false, name, message: '已有同名预设，保留现有内容。' };
  const index = Math.max(-1, ...presets.map(preset => preset.index)) + 1;
  const options = platform === 'Web' ? 'variant/thread_support=false\nvariant/extensions_support=false\nprogressive_web_app/enabled=false\n'
    : platform === 'Android' ? 'gradle_build/use_gradle_build=false\ngradle_build/export_format=0\narchitectures/arm64-v8a=true\npackage/signed=true\n' : '';
  const addition = `\n[preset.${index}]\nname=${JSON.stringify(name)}\nplatform=${JSON.stringify(platform)}\nrunnable=true\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path=""\nscript_export_mode=2\n\n[preset.${index}.options]\n${options}`;
  // Only append a missing preset; existing platform options remain untouched.
  fs.appendFileSync(file, addition);
  return { created: true, name, file, message: '已添加基础导出预设。请重新检查环境。' };
}
