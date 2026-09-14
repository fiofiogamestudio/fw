import fs from 'node:fs';
import { child, digest, fail } from './files.mjs';

const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); return n >>> 0; });
const crc32 = data => { let crc = 0xffffffff; for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
export function packageArtifact(artifact) {
  if (artifact.status !== 'built' || !artifact.outputs?.length) fail('invalid-package', '只有构建成功的产物可以下载。');
  if (artifact.outputs.length > 60000 || artifact.outputs.reduce((n, file) => n + file.size, 0) > 256 * 1024 * 1024) fail('package-too-large', '大于 256 MiB 的产物请使用“打开目录”交付。');
  const local = [], central = []; let offset = 0;
  for (const output of artifact.outputs) {
    if (!output.path.startsWith('out/')) fail('invalid-package', '产物必须位于输出目录。');
    const file = child(artifact.directory, output.path);
    if (fs.statSync(file).size !== output.size) fail('changed-output', '产物大小已变化，请重新构建。');
    const bytes = fs.readFileSync(file);
    if (digest(bytes) !== output.sha256) fail('changed-output', '产物哈希已变化，请重新构建。');
    const name = Buffer.from(output.path.slice(4)), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(record, name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(artifact.outputs.length, 8); end.writeUInt16LE(artifact.outputs.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
