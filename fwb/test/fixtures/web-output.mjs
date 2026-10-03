// Header-valid empty Godot 4 pack for package checks, not a playable game.
export function pckFixture(version = 2) {
  const bytes = Buffer.alloc(version === 2 ? 100 : 44);
  bytes.write('GDPC'); bytes.writeUInt32LE(version, 4); bytes.writeUInt32LE(4, 8);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 24);
  if (version !== 2) bytes.writeBigUInt64LE(40n, 32);
  return bytes;
}

export const wasmFixture = () => Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
