import fs from 'node:fs';
import path from 'node:path';
import { child } from './files.mjs';

// ZIP structure only: this does not verify Android signatures, provisioning,
// SDK levels, runtime compatibility, or App Store acceptance.
function zipEntries(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    const read = (position, length) => {
      if (!Number.isSafeInteger(position) || position < 0 || position + length > size) throw new Error('ZIP record is outside the archive.');
      const buffer = Buffer.alloc(length);
      if (fs.readSync(descriptor, buffer, 0, length, position) !== length) throw new Error('ZIP record is truncated.');
      return buffer;
    };
    if (size < 22) throw new Error('Native output is not a ZIP archive.');
    const tailSize = Math.min(size, 22 + 0xffff);
    const tail = read(size - tailSize, tailSize);
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { end = offset; break; }
    }
    if (end < 0) throw new Error('ZIP end-of-central-directory record is missing or truncated.');
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Multi-volume ZIP archives are unsupported.');
    const count = tail.readUInt16LE(end + 10);
    const centralSize = tail.readUInt32LE(end + 12);
    const centralOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 archives need a dedicated platform validator.');
    if (count !== tail.readUInt16LE(end + 8)) throw new Error('ZIP entry counts do not match.');
    if (centralOffset + centralSize !== size - tailSize + end) throw new Error('ZIP central-directory bounds do not match the archive.');
    if (count * 46 > centralSize) throw new Error('ZIP central directory is truncated.');
    const entries = new Map();
    let position = centralOffset;
    for (let index = 0; index < count; index += 1) {
      const header = read(position, 46);
      if (header.readUInt32LE(0) !== 0x02014b50) throw new Error('Invalid ZIP central-directory signature.');
      const flags = header.readUInt16LE(8);
      const method = header.readUInt16LE(10);
      const compressed = header.readUInt32LE(20);
      const uncompressed = header.readUInt32LE(24);
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const localOffset = header.readUInt32LE(42);
      if (header.readUInt16LE(34)) throw new Error('ZIP entry refers to another volume.');
      if ([compressed, uncompressed, localOffset].includes(0xffffffff)) throw new Error('ZIP64 entries need a dedicated platform validator.');
      if (flags & 1) throw new Error('Encrypted ZIP entries cannot form a standard native package.');
      if (![0, 8].includes(method)) throw new Error('Unsupported ZIP compression method in native package.');
      const next = position + 46 + nameLength + extraLength + commentLength;
      if (!nameLength || next > centralOffset + centralSize) throw new Error('ZIP central-directory entry is truncated.');
      const nameBuffer = read(position + 46, nameLength);
      const name = nameBuffer.toString('utf8');
      if (name.startsWith('/') || /^[a-z]:/i.test(name) || /[\\\x00]/.test(name) || name.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..')) throw new Error('ZIP contains an unsafe entry path.');
      if (entries.has(name)) throw new Error('ZIP contains duplicate entry names.');
      if (localOffset + 30 > centralOffset) throw new Error('ZIP local entry header is outside the file area.');
      const local = read(localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP local entry header is missing.');
      if (local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) throw new Error('ZIP local and central entry metadata do not match.');
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressed > centralOffset) throw new Error('ZIP entry data is outside the file area.');
      if (!read(localOffset + 30, localNameLength).equals(nameBuffer)) throw new Error('ZIP local and central entry names do not match.');
      entries.set(name, { compressed, uncompressed });
      position = next;
    }
    if (position !== centralOffset + centralSize) throw new Error('ZIP central-directory entry size does not match.');
    return entries;
  } finally { fs.closeSync(descriptor); }
}

/** Returns package-structure checks for Android APK/AAB or an iOS Xcode ZIP. */
export function validateNativeOutputs(artifact) {
  if (!['google-play', 'app-store'].includes(artifact.target)) return [];
  const checks = [];
  const add = (id, passed, message) => checks.push({ id, status: passed ? 'pass' : 'fail', message });
  const entry = artifact.entry;
  const extension = typeof entry === 'string' ? path.extname(entry).toLowerCase() : '';
  const allowed = artifact.target === 'google-play' ? ['.apk', '.aab'] : ['.zip'];
  if (!allowed.includes(extension)) {
    add('native:format', false, artifact.target === 'google-play' ? 'Android output must be an APK or AAB.' : 'iOS output must be a Godot Xcode project ZIP; an IPA requires separate validation.');
    return checks;
  }
  let entries;
  try {
    if (!entry.startsWith('out/') || !artifact.outputs?.some(output => output.path === entry)) throw new Error('Native entry is not a recorded output.');
    entries = zipEntries(child(artifact.directory, entry));
    add('native:zip-structure', true, `Checked ZIP directory and local entry bounds (${entries.size} entries); signatures and runtime are not verified.`);
  } catch (error) {
    add('native:zip-structure', false, error.message);
    return checks;
  }
  const nonempty = name => (entries.get(name)?.uncompressed ?? 0) > 0;
  const some = expression => [...entries].some(([name, metadata]) => expression.test(name) && metadata.uncompressed > 0);
  if (extension === '.apk') {
    add('android:manifest', nonempty('AndroidManifest.xml'), 'APK requires a nonempty AndroidManifest.xml.');
    add('android:godot-library', some(/^lib\/[^/]+\/libgodot_android\.so$/), 'APK requires a native Godot library for at least one ABI.');
  } else if (extension === '.aab') {
    add('android:bundle-config', nonempty('BundleConfig.pb'), 'AAB requires a nonempty BundleConfig.pb.');
    add('android:manifest', nonempty('base/manifest/AndroidManifest.xml'), 'AAB requires the base module Android manifest.');
    add('android:godot-library', some(/^base\/lib\/[^/]+\/libgodot_android\.so$/), 'AAB requires a native Godot library in the base module.');
  } else {
    add('ios:xcode-project', some(/(?:^|\/)[^/]+\.xcodeproj\/project\.pbxproj$/), 'Godot iOS export requires an Xcode project; archive, code signing, IPA and TestFlight are separate.');
  }
  return checks;
}
