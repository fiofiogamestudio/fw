import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Original six-part authoring template; deterministic pixels, no model calls. */
export async function createReskinFixture(directory) {
  const regions = [
    { name: 'head', x: 8, y: 8, w: 76, h: 72, svg: '<path d="M8 32L7 4 28 16Q38 10 48 16L69 4 68 32Q82 66 38 69-6 66 8 32Z" fill="#edaa62" stroke="#775141" stroke-width="3"/><path d="M14 24L13 12 23 19M53 19L63 12 62 25" fill="#d2786c"/><ellipse cx="25" cy="39" rx="3" ry="5" fill="#313d43"/><ellipse cx="51" cy="39" rx="3" ry="5" fill="#313d43"/><path d="M34 48L42 48 38 53Z" fill="#875453"/><path d="M30 56Q34 60 38 55 42 60 46 56" fill="none" stroke="#775141" stroke-width="2"/>' },
    { name: 'torso', x: 96, y: 8, w: 64, h: 72, svg: '<path d="M14 4Q32-2 50 4L60 62Q32 75 4 62Z" fill="#3d9193" stroke="#315964" stroke-width="3"/><path d="M20 4L32 19 44 4M32 19V63" fill="none" stroke="#bde0d0" stroke-width="4"/><path d="M10 48H54" stroke="#315964" stroke-width="6"/><rect x="27" y="44" width="10" height="9" rx="2" fill="#f1c570"/>' },
    { name: 'arm-left', x: 176, y: 8, w: 24, h: 60, svg: '<rect x="3" y="2" width="18" height="43" rx="9" fill="#3d9193" stroke="#315964" stroke-width="2"/><ellipse cx="12" cy="47" rx="9" ry="11" fill="#edaa62" stroke="#775141" stroke-width="2"/>' },
    { name: 'arm-right', x: 212, y: 8, w: 24, h: 60, svg: '<rect x="3" y="2" width="18" height="43" rx="9" fill="#3d9193" stroke="#315964" stroke-width="2"/><ellipse cx="12" cy="47" rx="9" ry="11" fill="#edaa62" stroke="#775141" stroke-width="2"/>' },
    { name: 'leg-left', x: 96, y: 104, w: 28, h: 44, svg: '<rect x="6" y="1" width="17" height="30" rx="7" fill="#4f6477"/><path d="M5 26H24L26 39Q16 44 2 39V32Z" fill="#6f5544" stroke="#423d3b" stroke-width="2"/>' },
    { name: 'leg-right', x: 140, y: 104, w: 28, h: 44, svg: '<rect x="5" y="1" width="17" height="30" rx="7" fill="#4f6477"/><path d="M4 26H23L26 32V39Q12 44 2 39Z" fill="#6f5544" stroke="#423d3b" stroke-width="2"/>' },
  ];
  const images = await Promise.all(regions.map(async part => ({ input: await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${part.w}" height="${part.h}">${part.svg}</svg>`)).png().toBuffer(), left: part.x, top: part.y })));
  const page = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#00000000' } }).composite(images).png().toBuffer();
  const atlas = Buffer.from('cat-parts.png\nsize:256,256\nfilter:Linear,Linear\npma:false\n' + regions.map(part => `${part.name}\nbounds:${part.x},${part.y},${part.w},${part.h}\n`).join(''));
  const names = ['leg-left', 'leg-right', 'torso', 'arm-left', 'arm-right', 'head'];
  const attachments = Object.fromEntries(names.map(name => { const part = regions.find(part => part.name === name); return [`${name}-slot`, { [name]: { type: 'region', path: name, width: part.w, height: part.h } }]; }));
  const json = Buffer.from(JSON.stringify({
    skeleton: { spine: '4.2.120', hash: 'fwv-original-six-part-cat', x: -54, y: -8, width: 108, height: 164 },
    bones: [{ name: 'root' }, { name: 'torso', parent: 'root', y: 58 }, { name: 'head', parent: 'torso', y: 56 },
      { name: 'arm-left', parent: 'torso', x: -38, y: -3, rotation: -5 }, { name: 'arm-right', parent: 'torso', x: 38, y: -3, rotation: 5 },
      { name: 'leg-left', parent: 'root', x: -16, y: 16 }, { name: 'leg-right', parent: 'root', x: 16, y: 16 }],
    slots: names.map(name => ({ name: `${name}-slot`, bone: name, attachment: name })), skins: [{ name: 'default', attachments }],
    animations: {
      idle: { bones: { torso: { translate: [{ time: 0, y: 0 }, { time: 0.8, y: 3 }, { time: 1.6, y: 0 }] }, head: { rotate: [{ time: 0, value: -3 }, { time: 0.8, value: 3 }, { time: 1.6, value: -3 }] } } },
      walk: { bones: { 'leg-left': { rotate: [{ time: 0, value: -18 }, { time: 0.4, value: 18 }, { time: 0.8, value: -18 }] }, 'leg-right': { rotate: [{ time: 0, value: 18 }, { time: 0.4, value: -18 }, { time: 0.8, value: 18 }] }, 'arm-left': { rotate: [{ time: 0, value: 15 }, { time: 0.4, value: -15 }, { time: 0.8, value: 15 }] }, 'arm-right': { rotate: [{ time: 0, value: -15 }, { time: 0.4, value: 15 }, { time: 0.8, value: -15 }] } } },
      wave: { bones: { 'arm-right': { rotate: [{ time: 0, value: 0 }, { time: 0.4, value: 110 }, { time: 0.65, value: 85 }, { time: 0.9, value: 110 }, { time: 1.3, value: 0 }] } } },
    },
  }, null, 2));
  const files = [{ name: 'cat.json', buffer: json }, { name: 'cat.atlas', buffer: atlas }, { name: 'cat-parts.png', buffer: page }];
  if (directory) { await fs.mkdir(directory, { recursive: true }); for (const file of files) await fs.writeFile(path.join(directory, file.name), file.buffer); }
  return { name: '六部件猫咪模板', files, json, atlas, page };
}
