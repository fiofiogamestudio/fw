import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, readJson } from '../src/core/files.mjs';

const maximum = 4 * 1024 * 1024;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-json-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {directory, file: path.join(directory, 'manifest.json')};
}

function largeManifest() {
  return {
    note: '  保留空白\t\r\n引号 " 和反斜杠 \\  ',
    files: Array.from({length: 20000}, (_, index) => ({
      path: `assets/测试/texture ${index}-${'x'.repeat(65)}.png`,
      size: 1024, sha256: 'a'.repeat(64),
    })),
  };
}

test('small JSON remains formatted and preserves Unicode and whitespace within values', t => {
  const {file} = fixture(t), value = {message: '  喵\t\r\n"猫" \\  ', nested: [null, false, 0]};
  atomicJson(file, value);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(value, null, 2) + '\n');
  assert.deepEqual(readJson(file), value);
});

test('large formatted manifests use identical compact JSON and remain readable after metadata updates', t => {
  const {file} = fixture(t), value = largeManifest();
  assert(Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') > maximum);
  assert(Buffer.byteLength(JSON.stringify(value) + '\n') < maximum);
  atomicJson(file, value);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(value) + '\n');
  assert.deepEqual(readJson(file), value);
  value.validation = {package: 'passed', note: '无需重新导出'};
  atomicJson(file, value);
  assert(fs.statSync(file).size <= maximum);
  assert.deepEqual(readJson(file), value);
});

test('compact fallback serializes custom toJSON only once', t => {
  const {file} = fixture(t), value = largeManifest();
  let calls = 0;
  atomicJson(file, {toJSON() { calls++; return {...value, calls}; }});
  assert.equal(calls, 1);
  assert.deepEqual(readJson(file), {...value, calls: 1});
});

test('the existing 4 MiB bound accepts exact-size formatted and compact UTF-8 JSON', t => {
  const {file} = fixture(t);
  for (const spacing of [2, undefined]) {
    const overhead = Buffer.byteLength(JSON.stringify({message: ''}, null, spacing) + '\n');
    const available = maximum - overhead;
    const value = {message: '猫'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3)};
    atomicJson(file, value);
    assert.equal(fs.statSync(file).size, maximum);
    assert.deepEqual(readJson(file), value);
  }
});

test('JSON still over budget when compact is rejected before replacing the existing file or creating temporary files', t => {
  const {directory, file} = fixture(t), original = {preserve: 'existing manifest'};
  atomicJson(file, original);
  const before = fs.readFileSync(file), names = fs.readdirSync(directory);
  const value = {message: 'x'.repeat(maximum)};
  assert.throws(() => atomicJson(file, value), {code: 'oversize-json'});
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(directory), names);
  assert.deepEqual(readJson(file), original);
});

test('the reader still rejects any on-disk JSON above 4 MiB', t => {
  const {file} = fixture(t);
  fs.writeFileSync(file, JSON.stringify({message: 'x'.repeat(maximum)}));
  assert.throws(() => readJson(file), {code: 'oversize-json'});
});
