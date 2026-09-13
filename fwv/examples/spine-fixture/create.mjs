import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Original synthetic artwork and animation, generated locally without third-party assets. */
export async function createSpineFixture(outputDirectory) {
  const json = Buffer.from(JSON.stringify({
    skeleton: { hash: 'fwv-owned-fixture', spine: '4.2.120', x: -40, y: 0, width: 80, height: 110, images: './' },
    bones: [{ name: 'root' }, { name: 'body', parent: 'root', y: 48 }],
    slots: [{ name: 'body-slot', bone: 'body', attachment: 'body' }],
    skins: [{ name: 'default', attachments: { 'body-slot': { body: { type: 'region', path: 'body', width: 80, height: 96 } } } }],
    animations: {
      idle: { bones: { body: { rotate: [{ time: 0, value: -12 }, { time: 0.6, value: 12 }, { time: 1.2, value: -12 }], translate: [{ time: 0, y: 0 }, { time: 0.6, y: 10 }, { time: 1.2, y: 0 }] } } },
      wave: { bones: { body: { rotate: [{ time: 0, value: -25 }, { time: 0.3, value: 25 }, { time: 0.6, value: -25 }], scale: [{ time: 0, x: 1, y: 1 }, { time: 0.3, x: 0.85, y: 1.1 }, { time: 0.6, x: 1, y: 1 }] } } },
    },
  }, null, 2) + '\n');
  const atlas = Buffer.from('fixture.png\nsize:128,128\nfilter:Linear,Linear\npma:false\nbody\nbounds:24,16,80,96\n');
  const pixels = Buffer.alloc(80 * 96 * 4);
  const replacementPixels = Buffer.alloc(pixels.length);
  for (let y = 0; y < 96; y++) for (let x = 0; x < 80; x++) {
    const inBody = ((x - 39.5) / 36) ** 2 + ((y - 52) / 40) ** 2 <= 1;
    const inEar = y < 35 && ((x >= 7 && x <= 26 && y >= Math.abs(x - 16) * 1.3) || (x >= 53 && x <= 72 && y >= Math.abs(x - 63) * 1.3));
    if (!inBody && !inEar) continue;
    const eye = (x >= 23 && x <= 28 || x >= 51 && x <= 56) && y >= 43 && y <= 52;
    const mouth = y >= 63 && y <= 65 && x >= 34 && x <= 45;
    const offset = (y * 80 + x) * 4;
    pixels.set(eye || mouth ? [41, 37, 61, 255] : [247, 162, 67, 255], offset);
    replacementPixels.set(eye || mouth ? [244, 248, 255, 255] : [105, 91, 212, 255], offset);
  }
  const body = await sharp(pixels, { raw: { width: 80, height: 96, channels: 4 } }).png().toBuffer();
  const page = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#00000000' } }).composite([{ input: body, left: 24, top: 16 }]).png().toBuffer();
  const replacement = await sharp(replacementPixels, { raw: { width: 80, height: 96, channels: 4 } }).png().toBuffer();
  const files = [{ name: 'fixture.json', buffer: json }, { name: 'fixture.atlas', buffer: atlas }, { name: 'fixture.png', buffer: page }];
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    for (const file of [...files, { name: 'replacement.png', buffer: replacement }]) await writeFile(path.join(outputDirectory, file.name), file.buffer);
  }
  return { name: 'FWV 猫咪换皮示例', files, json, atlas, pages: new Map([['fixture.png', page]]), replacement };
}

export const createFixture = createSpineFixture;
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const destination = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../../.local/reports/spine-fixture', import.meta.url));
  await createSpineFixture(destination);
  process.stdout.write(`Created original FWV Spine fixture in ${destination}\n`);
}
