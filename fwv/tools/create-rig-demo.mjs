import path from 'node:path';
import { FwvProject } from '../src/core/project.mjs';
import { createRigFixture } from '../examples/rig-fixture/create.mjs';
import { createRigDraft, saveRigDraft, buildRigCandidate } from '../src/rig/application.mjs';

// Deterministic local example: never constructs a model provider or reads a key.
const project = new FwvProject(path.resolve(process.argv[2] ?? '.local/demo'));
let snapshot = await project.snapshot();
const fixture = await createRigFixture();
let source = snapshot.assets.find(asset => asset.kind === 'image' && asset.name === fixture.name);
if (!source) source = await project.importImage({ name: fixture.name, fileName: fixture.fileName, buffer: fixture.buffer });
let draftAsset = snapshot.assets.find(asset => asset.kind === 'rig' && asset.name === '猫咪游侠 · 拆件草稿');
if (!draftAsset) {
  const created = await createRigDraft(project, { sourceAssetId: source.id, sourceRevisionId: source.selectedRevisionId, name: '猫咪游侠 · 拆件草稿', preset: 'humanoid6' });
  const saved = await saveRigDraft(project, { assetId: created.asset.id, revisionId: created.revision.id, parts: fixture.parts, motion: fixture.motion });
  draftAsset = saved.asset;
}
snapshot = await project.snapshot();
let candidate = snapshot.assets.find(asset => asset.kind === 'spine' && asset.revisions.some(revision => revision.metadata?.rig?.draft?.assetId === draftAsset.id
  && revision.metadata.rig.draft.revisionId === draftAsset.selectedRevisionId));
if (!candidate) candidate = (await buildRigCandidate(project, { assetId: draftAsset.id, revisionId: draftAsset.selectedRevisionId })).asset;
console.log(JSON.stringify({ status: 'ready', modelRequests: 0, projectRoot: project.root, sourceAssetId: source.id,
  draftAssetId: draftAsset.id, draftRevisionId: draftAsset.selectedRevisionId,
  candidateAssetId: candidate.id, candidateRevisionId: candidate.selectedRevisionId }, null, 2));
