import { fail } from './files.mjs';
import { runProcess } from './process.mjs';

// Godot can exit successfully after reporting an import/script error. Track the
// entire stream while retaining only a small overlap and the first diagnostic.
export function createGodotErrorMonitor() {
  const tails = new Map();
  let firstError;
  return {
    consume(data, stream = 'stdout') {
      if (firstError) return;
      const raw = (tails.get(stream) ?? '') + data;
      const text = raw.replace(/\x1b\[[0-9;]*m/g, '');
      const match = text.match(/(?:^|[\r\n])[ \t]*(?:SCRIPT ERROR:|Parse Error:|Compile Error:|ERROR:)[^\r\n]*/);
      if (match) firstError = match[0].trim().slice(0, 1024);
      // Prefix a truncated overlap so its first character is not mistaken for
      // the beginning of a new line. Keep stdout/stderr boundaries independent.
      tails.set(stream, raw.length > 2048 ? 'x' + raw.slice(-2048) : raw);
    },
    get firstError() { return firstError; },
  };
}

export async function runGodotProcess(executable, args, { phase, onOutput, ...options } = {}) {
  const monitor = createGodotErrorMonitor();
  const result = await runProcess(executable, args, { ...options, onOutput(data, stream) {
    monitor.consume(data, stream);
    onOutput?.(data, stream);
  } });
  if (monitor.firstError) fail(`godot-${phase}-error`, `Godot ${phase} reported errors: ${monitor.firstError}. Inspect build.log.`);
  return result;
}
