import { spawnSync, spawn } from 'node:child_process';

export function fail(code, message, details) {
  throw Object.assign(new Error(message), { code, details });
}

export function run(executable, args, { cwd, inherit = false, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(executable, args, {
    cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    encoding: 'utf8', windowsHide: true, shell: false,
    stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    fail('command-failed', `${executable} failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`, { exitCode: result.status });
  }
  return { status: result.status, stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '', error: result.error?.message };
}

export function git(root, args, allowFailure = false) { return run('git', ['-C', root, ...args], { allowFailure }); }

export function powershell() {
  const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  for (const executable of candidates) if (run(executable, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { allowFailure: true }).status === 0) return executable;
  fail('powershell-required', 'Git lifecycle tools require PowerShell (Windows PowerShell or PowerShell 7 pwsh).');
}

export async function launch(executable, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 || signal === 'SIGINT' ? resolve() : reject(new Error(`Editor exited with ${code ?? signal}.`)));
  });
}
