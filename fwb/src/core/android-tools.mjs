import fs from 'node:fs';
import path from 'node:path';
import { child, fail } from './files.mjs';

// Godot 4 reads Android paths from EditorSettings, not directly from ANDROID_HOME.
// A private self-contained editor keeps both the source installation and user settings intact.
export function prepareAndroidTools(directory, diagnosis) {
  const original = diagnosis.engine.executable;
  if (!path.isAbsolute(original) || !fs.existsSync(original)) fail('missing-engine', 'Android 构建需要可访问的 Godot 可执行文件。');
  const tools = child(directory, 'tools'); fs.mkdirSync(tools, { recursive: true });
  let executable;
  const bundle = original.match(/^(.*\.app)[/\\]Contents[/\\]MacOS[/\\]/)?.[1];
  if (bundle) {
    const destination = path.join(tools, path.basename(bundle)); fs.cpSync(bundle, destination, { recursive: true });
    executable = path.join(destination, path.relative(bundle, original));
  } else {
    executable = path.join(tools, path.basename(original)); fs.copyFileSync(original, executable);
    const parent = path.dirname(original), companion = original.replace(/_console\.exe$/i, '.exe');
    if (companion !== original && fs.existsSync(companion)) fs.copyFileSync(companion, path.join(tools, path.basename(companion)));
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.name === 'GodotSharp' && entry.isDirectory()) fs.cpSync(path.join(parent, entry.name), path.join(tools, entry.name), { recursive: true });
      else if (entry.isFile() && /\.(dll|so|dylib)$/.test(entry.name)) fs.copyFileSync(path.join(parent, entry.name), path.join(tools, entry.name));
    }
  }
  fs.writeFileSync(path.join(tools, '._sc_'), '');
  const settingsDir = path.join(tools, 'editor_data'); fs.mkdirSync(settingsDir, { recursive: true });
  const minor = diagnosis.engine.version.match(/^(4\.\d+)/)?.[1];
  if (!minor) fail('invalid-engine-version', '无法确定 Godot 编辑器设置版本。');
  const fields = { 'export/android/android_sdk_path': diagnosis.toolchain?.androidSdkPath, 'export/android/java_sdk_path': diagnosis.toolchain?.javaHome };
  const settings = '[gd_resource type="EditorSettings" format=3]\n\n[resource]\n' + Object.entries(fields).filter(([, value]) => value).map(([key, value]) => `${key} = ${JSON.stringify(value.replaceAll('\\', '/'))}`).join('\n') + '\n';
  fs.writeFileSync(path.join(settingsDir, `editor_settings-${minor}.tres`), settings);
  return { executable, settingsDir };
}
