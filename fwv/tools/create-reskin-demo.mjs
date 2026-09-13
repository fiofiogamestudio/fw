import path from 'node:path';
import { FwvProject } from '../src/core/project.mjs';
import { createReskinFixture } from '../examples/reskin-fixture/create.mjs';
import { importSpine } from '../src/spine/application.mjs';
import { ImagesProvider } from '../src/generation/provider.mjs';
import { GenerationJobs } from '../src/generation/jobs.mjs';
import { ReskinWorkflows } from '../src/workflows/reskin.mjs';

const project = new FwvProject(path.resolve(process.argv[2] ?? '.local/demo'));
const snapshot = await project.snapshot();
if (snapshot.assets.some(asset => asset.kind === 'reskin' && asset.name === '铠甲橘猫 · 换皮流程')) {
  console.log(JSON.stringify({ status: 'already-present', projectRoot: project.root }));
} else {
  const fixture = await createReskinFixture();
  const template = await importSpine(project, fixture);
  // This script deliberately never reads provider credentials or calls a model.
  const jobs = new GenerationJobs({ project, provider: new ImagesProvider({ env: {} }) });
  const workflows = new ReskinWorkflows({ project, generationJobs: jobs });
  try {
    const workflow = await workflows.create({ templateAssetId: template.id, templateRevisionId: template.selectedRevisionId,
      name: '铠甲橘猫', brief: '把这个六部件猫咪冒险者改成穿轻甲的橘猫骑士，保留脸部表情、体型和关节位置。', style: '手绘游戏角色，橘色毛发，蓝灰色金属轻甲，浅金色扣件，保持清晰轮廓与低细节。',
      partNotes: { head: '橘猫脸，额头加小块护额，保留耳朵与表情。', torso: '蓝灰色胸甲、金色腰带扣。', 'arm-left': '蓝灰色护臂，橘色猫爪。', 'arm-right': '蓝灰色护臂，橘色猫爪。', 'leg-left': '蓝灰色护腿和深棕色靴子。', 'leg-right': '与左腿保持同款配色。' } });
    console.log(JSON.stringify({ status: 'created-plan-only', modelRequests: 0, workflowId: workflow.assetId, templateAssetId: template.id }, null, 2));
  } finally { workflows.close(); jobs.close(); }
}
