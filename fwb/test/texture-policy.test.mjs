import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { applyTexturePolicy, resolveTexturePolicy, validateTexturePolicy } from '../src/core/texture-policy.mjs';

test('texture policy modifies selected snapshot imports only and preserves sources and exclusions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-texture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = '[remap]\nimporter="texture"\nuid="uid://stable"\n[params]\ncompress/mode=0\ncompress/lossy_quality=0.7\nprocess/size_limit=0\nmipmaps/generate=false\n';
  for (const file of ['art/world/a.png', 'art/ui/icon.png', 'other/a.png']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'original-image');
    fs.writeFileSync(path.join(root, `${file}.import`), source);
  }
  const report = applyTexturePolicy(root, { include: ['art'], exclude: ['art/ui'], mode: 'lossy', quality: 0.82, maxSize: 1536 });
  assert.equal(report.count, 1);
  const changed = fs.readFileSync(path.join(root, 'art/world/a.png.import'), 'utf8');
  assert.match(changed, /compress\/mode=1/);
  assert.match(changed, /process\/size_limit=1536/);
  assert.match(changed, /uid="uid:\/\/stable"/);
  assert.equal(fs.readFileSync(path.join(root, 'art/world/a.png'), 'utf8'), 'original-image');
  assert.equal(fs.readFileSync(path.join(root, 'art/ui/icon.png.import'), 'utf8'), source);
  assert.equal(fs.readFileSync(path.join(root, 'other/a.png.import'), 'utf8'), source);
});

test('texture policy rejects ambiguous paths, invalid quality and unsupported settings', () => {
  for (const prefix of ['../art', '/art', 'art/*', 'C:/art', 'art/']) assert.throws(() => validateTexturePolicy({ include: [prefix], mode: 'lossy' }));
  for (const quality of [-1, 2, '1', Infinity]) assert.throws(() => validateTexturePolicy({ include: ['art'], mode: 'lossy', quality }));
  assert.throws(() => validateTexturePolicy({ include: ['art'], mode: 'magic' }));
  const policy = { include: ['art'], mode: 'lossy' };
  const config = { texturePolicy: policy, targets: { 'poki': { texturePolicy: false } } };
  assert.equal(resolveTexturePolicy(config, 'web'), policy);
  assert.equal(resolveTexturePolicy(config, 'poki'), null);
  assert.equal(resolveTexturePolicy(config, 'wechat-minigame'), null);
});

test('ordered rules merge final parameters once, including resources outside the base selection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-texture-rules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = '[remap]\nimporter="texture"\n[params]\ncompress/mode=0\ncompress/lossy_quality=0.7\nprocess/size_limit=2048\n';
  const assets = ['art/backgrounds/room.png', 'art/backgrounds/detail.png', 'art/items/key.png', 'art/cover/title.png', 'art/icons/a.png', 'artwork/unselected.png'];
  for (const asset of assets) {
    fs.mkdirSync(path.dirname(path.join(root, asset)), { recursive: true });
    fs.writeFileSync(path.join(root, asset), `source:${asset}`);
    fs.writeFileSync(path.join(root, `${asset}.import`), original);
  }
  const writes = new Map();
  const writeFileSync = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    writes.set(file, (writes.get(file) ?? 0) + 1);
    return writeFileSync(file, ...args);
  });
  const policy = {
    include: ['art/backgrounds', 'art/cover'], exclude: ['art/cover'], mode: 'lossy', quality: 0.78, maxSize: 1024,
    rules: [
      { include: ['art/backgrounds'], quality: 0.8, maxSize: 768 },
      { include: ['art/backgrounds'], exclude: ['art/backgrounds/detail.png'], quality: 0.9 },
      { include: ['art/items', 'art/icons'], quality: 0.82, maxSize: 384 },
      { include: ['art/cover'], mode: 'lossless', maxSize: 0 },
    ],
  };
  const savedPolicy = structuredClone(policy);
  const report = applyTexturePolicy(root, policy);
  assert.deepEqual(policy, savedPolicy, 'caller configuration must remain unchanged');
  assert.equal(report.count, 5);
  const entries = Object.fromEntries(report.files.map(file => [file.path, file]));
  assert.deepEqual(entries['art/backgrounds/room.png'].effectivePolicy, { mode: 'lossy', quality: 0.9, maxSize: 768 });
  assert.deepEqual(entries['art/backgrounds/detail.png'].effectivePolicy, { mode: 'lossy', quality: 0.8, maxSize: 768 });
  assert.deepEqual(entries['art/items/key.png'].effectivePolicy, { mode: 'lossy', quality: 0.82, maxSize: 384 });
  assert.deepEqual(entries['art/icons/a.png'].effectivePolicy, { mode: 'lossy', quality: 0.82, maxSize: 384 });
  assert.deepEqual(entries['art/cover/title.png'].effectivePolicy, { mode: 'lossless', quality: 0.78, maxSize: 0 });
  for (const entry of report.files) {
    const importPath = path.join(root, `${entry.path}.import`);
    assert.equal(writes.get(importPath), 1, 'overlapping rules must write an import only once');
    assert.equal(entry.importBeforeSha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(entry.importSha256, createHash('sha256').update(fs.readFileSync(importPath)).digest('hex'));
    assert.equal(entry.sourceSha256, createHash('sha256').update(`source:${entry.path}`).digest('hex'));
    assert.equal(fs.readFileSync(path.join(root, entry.path), 'utf8'), `source:${entry.path}`);
  }
  assert.match(fs.readFileSync(path.join(root, 'art/items/key.png.import'), 'utf8'), /compress\/lossy_quality=0\.82\nprocess\/size_limit=384/);
  assert.match(fs.readFileSync(path.join(root, 'art/cover/title.png.import'), 'utf8'), /compress\/mode=0/);
  assert.match(fs.readFileSync(path.join(root, 'art/cover/title.png.import'), 'utf8'), /process\/size_limit=2048/, 'zero preserves the original import limit, not an earlier rule limit');
  assert.equal(fs.readFileSync(path.join(root, 'artwork/unselected.png.import'), 'utf8'), original);
  assert.equal(writes.size, 5);
});

test('rule validation rejects empty rules, unknown fields and invalid parameter boundaries', () => {
  const base = { include: ['art'], mode: 'lossy' };
  for (const rules of [null, false, {}, [], Array(1), Array(1001).fill({ include: ['art'], quality: 1 })]) {
    assert.throws(() => validateTexturePolicy({ ...base, rules }), /rules/);
  }
  const invalidRules = [
    null, false, [], {}, { include: ['art'] }, { include: ['art'], exclude: ['art/private'] },
    { include: ['art'], mode: 'lossy', unknown: true }, { include: ['art'], mode: 'lossy', rules: [] },
    { mode: 'lossy' }, { include: [], mode: 'lossy' }, { include: ['art/*'], mode: 'lossy' },
    { include: ['../art'], mode: 'lossy' }, { include: ['art'], exclude: ['/art'], mode: 'lossy' },
    ...['magic', null, 1, ['lossy']].map(mode => ({ include: ['art'], mode })),
    ...[-0.1, 1.1, NaN, Infinity, null, '0.8'].map(quality => ({ include: ['art'], quality })),
    ...[-1, 16385, 0.5, Infinity, null, '384'].map(maxSize => ({ include: ['art'], maxSize })),
  ];
  for (const rule of invalidRules) assert.throws(() => validateTexturePolicy({ ...base, rules: [rule] }), /texturePolicy\.rules\[0\]/);
  assert.throws(() => validateTexturePolicy({ ...base, unknown: true, rules: [{ include: ['art'], mode: 'lossless' }] }));
  for (const quality of [0, 1]) for (const maxSize of [0, 16384]) {
    assert.doesNotThrow(() => validateTexturePolicy({ ...base, rules: [{ include: ['art'], quality, maxSize }] }));
  }
});

test('rule-only matches still require a texture importer and honor exact path boundaries', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-texture-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const otherImport = '[remap]\nimporter="font_data_dynamic"\n[params]\n';
  fs.mkdirSync(path.join(root, 'art'));
  fs.writeFileSync(path.join(root, 'art/font.ttf'), 'font-source');
  fs.writeFileSync(path.join(root, 'art/font.ttf.import'), otherImport);
  const policy = { include: ['missing-base'], mode: 'lossy', rules: [{ include: ['art'], quality: 0.8 }] };
  assert.throws(() => applyTexturePolicy(root, policy), /did not match any texture imports/);
  assert.equal(fs.readFileSync(path.join(root, 'art/font.ttf.import'), 'utf8'), otherImport);
});
