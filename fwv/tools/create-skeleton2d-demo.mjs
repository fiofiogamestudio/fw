import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { FwvProject } from '../src/core/project.mjs';
import { importSkeleton2d } from '../src/skeleton2d/application.mjs';

/** A second host-free fixture: editable mechanical windmill, not a game character adapter. */
export async function createSkeleton2dDemo(projectRoot) {
  const project = new FwvProject(projectRoot);
  try { await project.snapshot(); } catch (error) { if (error.code !== 'ENOENT') throw error; await project.init({ name: 'Reusable 2D windmill' }); }
  const document = JSON.parse(await fs.readFile(new URL('../examples/skeleton2d/windmill.json', import.meta.url), 'utf8'));
  const tower = await sharp({ create: { width: 24, height: 64, channels: 4, background: '#ddbf87' } }).png().toBuffer();
  const rotor = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><path fill="#465d80" d="M32 0h8v72h-8zM0 32h72v8H0z"/><circle cx="36" cy="36" r="7" fill="#e7bd67"/></svg>')).png().toBuffer();
  const asset = await importSkeleton2d(project, { name: 'Windmill · reusable 2D example', document, textures: [{ name: 'tower.png', buffer: tower }, { name: 'rotor.png', buffer: rotor }], idempotencyKey: 'skeleton2d-windmill-v1' });
  return { projectRoot: project.root, assetId: asset.id, revisionId: asset.selectedRevisionId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await createSkeleton2dDemo(path.resolve(process.argv[2] ?? '.local/skeleton2d-demo')), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
