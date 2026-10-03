import test from 'node:test';
import assert from 'node:assert/strict';
import { createGodotErrorMonitor, runGodotProcess } from '../src/core/godot-process.mjs';
import { runProcess } from '../src/core/process.mjs';

test('a Godot error before the retained output tail still fails a successful process', async () => {
  const source = 'process.stdout.write("ERROR: early import failure\\n" + "completed import\\n".repeat(15000));';
  const events = [];
  await assert.rejects(runGodotProcess(process.execPath, ['-e', source], { phase: 'import', onOutput: (data, stream) => events.push(stream) }),
    error => error.code === 'godot-import-error' && error.message.includes('early import failure'));
  assert.ok(events.length > 0); assert.ok(events.every(stream => stream === 'stdout'));
});

test('Godot errors survive split chunks, ANSI colors and independent stdout/stderr interleaving', () => {
  const monitor = createGodotErrorMonitor();
  monitor.consume('\u001b[31mSCR', 'stderr');
  monitor.consume('Importing assets\n', 'stdout');
  monitor.consume('IPT ER', 'stderr');
  monitor.consume('ROR: Parse Error: broken script\u001b[0m\n', 'stderr');
  assert.equal(monitor.firstError, 'SCRIPT ERROR: Parse Error: broken script');
  monitor.consume('ERROR: later\n');
  assert.equal(monitor.firstError, 'SCRIPT ERROR: Parse Error: broken script');
});

test('normal progress, diagnostic words inside text and truncated long lines do not become errors', () => {
  const monitor = createGodotErrorMonitor();
  monitor.consume('Godot Engine v4.7.2\nWARNING: optional resource\nImported file named Parse Error: guide\n');
  monitor.consume('progress '.repeat(1000) + 'ERROR: part of a progress message');
  monitor.consume(' complete\n');
  assert.equal(monitor.firstError, undefined);
  monitor.consume('  ERROR: next line failed\n');
  assert.equal(monitor.firstError, 'ERROR: next line failed');
});

test('Godot export retains success output, nonzero exits and real stderr diagnostics', async () => {
  const success = await runGodotProcess(process.execPath, ['-e', 'process.stdout.write("all good\\n")'], { phase: 'export' });
  assert.equal(success.output, 'all good\n');
  await assert.rejects(runGodotProcess(process.execPath, ['-e', 'process.stderr.write("ERROR: export failed\\n")'], { phase: 'export' }), { code: 'godot-export-error' });
  await assert.rejects(runGodotProcess(process.execPath, ['-e', 'process.exit(7)'], { phase: 'export' }), /code 7/);
});

test('process output preserves UTF-8 characters split across pipe writes', async () => {
  const result = await runProcess(process.execPath, ['-e', 'const b=Buffer.from("资源准备完成");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30);']);
  assert.equal(result.output, '资源准备完成');
});
