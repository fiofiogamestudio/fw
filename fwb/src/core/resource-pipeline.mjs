import path from 'node:path';
import { fail } from './files.mjs';
import { getTarget } from '../platforms.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pipelineId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value);

export function validateHookScript(script, label) {
  if (typeof script !== 'string' || !script.trim() || script.length > 2048 || /[\x00-\x1f]/.test(script)
    || !script.endsWith('.mjs') || path.isAbsolute(script) || /[:\\]/.test(script)
    || script.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('invalid-config', `${label} must be a project-relative .mjs file without traversal.`);
  }
}

export function validateResourcePipelines(pipelines) {
  if (pipelines === undefined) return;
  if (!plain(pipelines)) fail('invalid-config', 'resourcePipelines must be a record of named resource preparation pipelines.');
  for (const [id, pipeline] of Object.entries(pipelines)) {
    if (!pipelineId(id) || !plain(pipeline) || Object.keys(pipeline).some(key => key !== 'prepareScript')) {
      fail('invalid-config', `Invalid resource pipeline: ${id}`);
    }
    validateHookScript(pipeline.prepareScript, `resourcePipelines.${id}.prepareScript`);
  }
}

/** Resolve preparation only; platform conversion and finalization remain target-specific. */
export function resolveResourcePreparation(config, targetId) {
  validateResourcePipelines(config.resourcePipelines);
  const target = config.targets?.[targetId];
  if (!target) return null;
  const selected = target.resourcePipeline;
  if (selected !== undefined && selected !== false) {
    if (!pipelineId(selected)) fail('invalid-config', `${targetId}.resourcePipeline must be a pipeline name or false.`);
    if (!Object.hasOwn(config.resourcePipelines ?? {}, selected)) fail('invalid-config', `${targetId}.resourcePipeline selects unknown pipeline: ${selected}`);
  }
  if (target.prepareScript !== undefined) {
    validateHookScript(target.prepareScript, `${targetId}.prepareScript`);
    return { script: target.prepareScript, pipeline: null, source: 'target' };
  }
  if (selected === false) return null;
  const inherited = selected ?? (getTarget(targetId)?.technology === 'web' && Object.hasOwn(config.resourcePipelines ?? {}, 'web') ? 'web' : null);
  if (inherited === null) return null;
  return { script: config.resourcePipelines[inherited].prepareScript, pipeline: inherited, source: 'pipeline' };
}
