import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

/** Original deterministic test drawing. The separated joints make manual masks legible. */
export async function createRigFixture(directory) {
  const width = 400, height = 520;
  const box = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const parts = [
    { id: 'leg-left', name: '左腿', role: 'leg-left', parentId: 'torso', polygon: box(141, 337, 54, 140), pivot: { x: 169, y: 343 } },
    { id: 'leg-right', name: '右腿', role: 'leg-right', parentId: 'torso', polygon: box(205, 337, 55, 140), pivot: { x: 231, y: 343 } },
    { id: 'torso', name: '身体', role: 'torso', parentId: null, polygon: box(132, 170, 136, 160), pivot: { x: 200, y: 315 } },
    { id: 'arm-left', name: '左手', role: 'arm-left', parentId: 'torso', polygon: box(73, 187, 53, 148), pivot: { x: 105, y: 197 } },
    { id: 'arm-right', name: '右手', role: 'arm-right', parentId: 'torso', polygon: box(274, 187, 53, 148), pivot: { x: 295, y: 197 } },
    { id: 'head', name: '头部', role: 'head', parentId: 'torso', polygon: box(134, 44, 132, 121), pivot: { x: 200, y: 156 } },
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <g stroke-linejoin="round" stroke-linecap="round">
    <g stroke="#34475a" stroke-width="5"><path d="M154 341H188V443H150Z" fill="#647b95"/><path d="M212 341H246L250 443H212Z" fill="#647b95"/></g>
    <g fill="#76563f" stroke="#463e3c" stroke-width="5"><path d="M149 437H190V470H147Q142 455 149 437Z"/><path d="M210 437H251Q258 455 253 470H210Z"/></g>
    <path d="M157 180Q200 170 243 180L263 312Q201 335 137 312Z" fill="#3a9990" stroke="#2d5d67" stroke-width="5"/>
    <path d="M174 179L200 204 226 179M200 204V314" fill="none" stroke="#bce3d2" stroke-width="7"/>
    <path d="M145 283H255" stroke="#35556a" stroke-width="13"/><rect x="188" y="274" width="25" height="22" rx="4" fill="#f4c365" stroke="#73573d" stroke-width="3"/>
    <g fill="#3a9990" stroke="#2d5d67" stroke-width="5"><path d="M91 193Q119 184 120 208L116 290H78L80 210Q80 199 91 193Z"/><path d="M280 208Q281 184 309 193 320 199 320 210L322 290H284Z"/></g>
    <g fill="#edac65" stroke="#795344" stroke-width="4"><ellipse cx="98" cy="311" rx="19" ry="19"/><ellipse cx="302" cy="311" rx="19" ry="19"/>
      <path d="M142 94L139 49 177 69Q200 60 223 69L261 49 258 94Q277 156 200 160 123 156 142 94Z"/></g>
    <path d="M151 83L148 63 166 75M234 75L252 63 249 83" fill="#cb837a"/>
    <g fill="#344250"><ellipse cx="178" cy="109" rx="5" ry="8"/><ellipse cx="222" cy="109" rx="5" ry="8"/></g>
    <path d="M192 124H208L200 132Z" fill="#976052"/><path d="M184 139Q192 146 200 137 208 146 216 139" fill="none" stroke="#795344" stroke-width="4"/>
  </g></svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const result = { name: '猫咪游侠 · 单图绑定练习', fileName: 'cat-rig-source.png', buffer, width, height, parts, motion: { idle: true, walk: true, wave: true } };
  if (directory) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, result.fileName), buffer);
    await fs.writeFile(path.join(directory, 'part-guide.json'), JSON.stringify({ width, height, parts, motion: result.motion }, null, 2) + '\n');
  }
  return result;
}
