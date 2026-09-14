import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateNativeOutputs } from '../src/core/native-validation.mjs';

const apkEntries = ['AndroidManifest.xml', 'lib/arm64-v8a/libgodot_android.so'];
const aabEntries = ['BundleConfig.pb', 'base/manifest/AndroidManifest.xml', 'base/lib/arm64-v8a/libgodot_android.so'];
const iosEntries = ['Starport/Starport.xcodeproj/project.pbxproj'];
const crc32 = data => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

function zip(names) {
  const locals = []; const central = []; let offset = 0;
  for (const name of names) {
    const encoded = Buffer.from(name);
    const body = Buffer.from('structure fixture, not a runnable native package');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(body), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(encoded.length, 26);
    locals.push(local, encoded, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc32(body), 16); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(body.length, 24);
    header.writeUInt16LE(encoded.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, encoded);
    offset += local.length + encoded.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function fixture(t, target, filename, names, mutate) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fwb-native-'));
  t.after(() => {
    assert.ok(directory.startsWith(path.join(os.tmpdir(), 'fwb-native-')));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(directory, 'out'));
  let bytes = Array.isArray(names) ? zip(names) : Buffer.from(names);
  if (mutate) bytes = mutate(bytes);
  fs.writeFileSync(path.join(directory, 'out', filename), bytes);
  return { target, directory, entry: `out/${filename}`, outputs: [{ path: `out/${filename}` }] };
}

const passed = checks => checks.length > 0 && checks.every(check => check.status === 'pass');

test('non-native targets are left to their own validator', () => {
  assert.deepEqual(validateNativeOutputs({ target: 'web' }), []);
});

for (const [target, filename, entries] of [['google-play', 'game.apk', apkEntries], ['google-play', 'game.aab', aabEntries], ['app-store', 'game.zip', iosEntries]]) {
  test(`${filename} accepts the expected Godot archive structure`, t => {
    const checks = validateNativeOutputs(fixture(t, target, filename, entries));
    assert.equal(passed(checks), true, JSON.stringify(checks));
    assert.ok(checks[0].message.includes('runtime are not verified'));
  });
  test(`${filename} rejects plain text renamed as a native package`, t => {
    assert.equal(passed(validateNativeOutputs(fixture(t, target, filename, 'not a zip'))), false);
  });
  test(`${filename} rejects a ZIP with only unrelated files`, t => {
    assert.equal(passed(validateNativeOutputs(fixture(t, target, filename, ['readme.txt']))), false);
  });
}

test('APK with a manifest but no Godot native library fails', t => {
  const checks = validateNativeOutputs(fixture(t, 'google-play', 'game.apk', ['AndroidManifest.xml', 'classes.dex']));
  assert.equal(checks.find(check => check.id === 'android:godot-library').status, 'fail');
});

test('APK entries cannot satisfy AAB validation', t => {
  assert.equal(passed(validateNativeOutputs(fixture(t, 'google-play', 'game.aab', apkEntries))), false);
});

test('an IPA is not presented as a validated Xcode project ZIP', t => {
  const checks = validateNativeOutputs(fixture(t, 'app-store', 'game.ipa', iosEntries));
  assert.equal(checks[0].status, 'fail');
  assert.match(checks[0].message, /separate validation/);
});

test('missing or unrecorded native entry fails', t => {
  const artifact = fixture(t, 'google-play', 'game.apk', apkEntries);
  artifact.entry = 'out/missing.apk';
  assert.equal(passed(validateNativeOutputs(artifact)), false);
  artifact.outputs.push({ path: artifact.entry });
  assert.equal(passed(validateNativeOutputs(artifact)), false);
});

test('truncated archive and invalid local-entry offset fail', t => {
  const truncated = fixture(t, 'google-play', 'game.apk', apkEntries, bytes => bytes.subarray(0, bytes.length - 3));
  assert.equal(passed(validateNativeOutputs(truncated)), false);
  const badOffset = fixture(t, 'google-play', 'other.apk', apkEntries, bytes => {
    const centralOffset = bytes.readUInt32LE(bytes.length - 6);
    bytes.writeUInt32LE(bytes.length - 2, centralOffset + 42);
    return bytes;
  });
  assert.equal(passed(validateNativeOutputs(badOffset)), false);
});

test('duplicate names and traversal entries fail', t => {
  const duplicate = fixture(t, 'google-play', 'game.apk', [...apkEntries, apkEntries[0]]);
  assert.equal(passed(validateNativeOutputs(duplicate)), false);
  const traversal = fixture(t, 'google-play', 'other.apk', [...apkEntries, '../outside']);
  assert.equal(passed(validateNativeOutputs(traversal)), false);
});

test('ZIP64 is explicitly unsupported instead of accepting incomplete checks', t => {
  const artifact = fixture(t, 'google-play', 'game.apk', apkEntries, bytes => { bytes.writeUInt32LE(0xffffffff, bytes.length - 6); return bytes; });
  const checks = validateNativeOutputs(artifact);
  assert.equal(checks[0].status, 'fail');
  assert.match(checks[0].message, /ZIP64/);
});
