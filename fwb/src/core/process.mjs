import fs from 'node:fs';
import { spawn } from 'node:child_process';

export async function runProcess(executable, args, { cwd, logFile, timeoutSeconds = 300, signal, env, onOutput } = {}) {
  if (signal?.aborted) throw new Error('Build cancelled.');
  const output = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
  output?.write(`$ ${executable} ${args.join(' ')}\n`);
  let collected = '';
  let timedOut = false;
  let cancelled = false;
  let bytes = 0;
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill('SIGKILL');
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSeconds * 1000);
  const abort = () => { cancelled = true; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  const consume = (data, stream) => {
    if (bytes < 16 * 1024 * 1024) output?.write(data);
    bytes += Buffer.byteLength(data, 'utf8');
    collected = (collected + data).slice(-128 * 1024);
    onOutput?.(data, stream);
    if (bytes > 32 * 1024 * 1024) stop();
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => consume(data, 'stdout')); child.stderr.on('data', data => consume(data, 'stderr'));
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (timedOut) throw new Error(`Command timed out after ${timeoutSeconds}s.`);
    if (cancelled) throw new Error('Build cancelled.');
    if (bytes > 32 * 1024 * 1024) throw new Error('Command exceeded the output limit.');
    if (code !== 0) throw new Error(`Command exited with code ${code}. ${collected.slice(-4000)}`);
    return { code, output: collected };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (output) await new Promise(resolve => output.end(resolve));
  }
}
