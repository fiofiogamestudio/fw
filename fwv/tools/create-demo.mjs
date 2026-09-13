import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { createSpineFixture } from '../examples/spine-fixture/create.mjs';
import { importSpine, replaceSpinePart } from '../src/spine/application.mjs';

const root = path.resolve(process.argv[2] ?? '.local/demo');
const project = new FwvProject(root);
await project.init({ name: 'FWV · 美术制作示例' });
const drawings = [
  ['月光药剂', '#dbece9', '<path d="M108 46h40v55l33 58q10 54-53 54t-53-54l33-58z" fill="#87d3c5" stroke="#20594f" stroke-width="7"/><path d="M84 149h88l8 25q0 33-52 33t-49-33z" fill="#31968a"/><rect x="102" y="37" width="52" height="23" rx="7" fill="#c28a56" stroke="#604b40" stroke-width="6"/><path d="M104 111v34" stroke="white" stroke-width="9" stroke-linecap="round"/>'],
  ['琥珀护盾', '#f0e6d4', '<path d="M128 39l73 29-9 90q-15 36-64 63-49-27-64-63l-9-90z" fill="#d7a45c" stroke="#5e4839" stroke-width="8"/><path d="M128 59l51 22-7 69q-11 27-44 48z" fill="#a97542"/><path d="M128 86l12 25 28 4-20 20 5 28-25-13-25 13 5-28-20-20 28-4z" fill="#fff1bb"/>'],
  ['薄荷叶', '#e0edda', '<path d="M61 190Q38 69 203 48q13 123-142 142z" fill="#74a76a" stroke="#345b3c" stroke-width="7"/><path d="M56 204L178 76m-80 87-13-43m46 10 38-3m-17-23-3-29" stroke="#345b3c" stroke-width="7" fill="none" stroke-linecap="round"/>'],
  ['星辉碎片', '#e7e1f0', '<path d="M128 34l51 54 16 85-67 51-67-51 16-85z" fill="#a896d4" stroke="#554675" stroke-width="7"/><path d="M128 34v190l-32-77 32-113m0 0 30 111 37 28" fill="#cfc3f0" stroke="#7965a5" stroke-width="4"/><path d="M48 52v26m-13-13h26m139 132v20m-10-10h20" stroke="#a896d4" stroke-width="6" stroke-linecap="round"/>'],
];
for (const [index, [name, background, shape]] of drawings.entries()) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="-32 -32 320 320"><rect x="-32" y="-32" width="320" height="320" fill="${background}"/>${shape}</svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  let asset = await project.importImage({ name, fileName: `icon-${index + 1}.png`, buffer });
  asset = await project.processImage({ assetId: asset.id, revisionId: asset.selectedRevisionId,
    recipe: { width: 256, height: 256, padding: 24, trim: true, fit: 'contain', background: 'transparent', removeBackground: { color: background, tolerance: 10 } } });
  await project.validateRevision({ assetId: asset.id, revisionId: asset.selectedRevisionId });
}
const fixture = await createSpineFixture();
await fs.mkdir(path.join(root, 'source-spine'), { recursive: true });
for (const file of fixture.files) await fs.writeFile(path.join(root, 'source-spine', file.name), file.buffer);
await fs.writeFile(path.join(root, 'replacement.png'), fixture.replacement);
const skeleton = await importSpine(project, fixture);
await replaceSpinePart(project, { assetId: skeleton.id, revisionId: skeleton.selectedRevisionId, regionName: 'body', buffer: fixture.replacement, transform: {} });
console.log(JSON.stringify({ projectRoot: root, assets: (await project.snapshot()).assets.length }, null, 2));
