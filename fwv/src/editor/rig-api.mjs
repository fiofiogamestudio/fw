import { createRigDraft, forkRigDraft, saveRigDraft, buildRigCandidate, loadRigDraft } from '../rig/application.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw invalid('立绘骨骼操作参数不匹配。');
}

export async function executeRigCommand(application, body) {
  fields(body, ['type', 'payload']);
  const input = body.payload;
  switch (body.type) {
    case 'rig.create':
      fields(input, ['sourceAssetId', 'sourceRevisionId', 'name'], ['preset']);
      return createRigDraft(application, input);
    case 'rig.save':
      fields(input, ['assetId', 'revisionId', 'parts', 'motion']);
      return saveRigDraft(application, input);
    case 'rig.fork':
      fields(input, ['assetId', 'revisionId'], ['name', 'parts', 'motion']);
      return forkRigDraft(application, input);
    case 'rig.build':
      fields(input, ['assetId', 'revisionId']);
      return buildRigCandidate(application, input);
    default: throw invalid('未知的立绘骨骼操作。');
  }
}

export async function handleRigApi({ state, url, sendJson }) {
  if (url.pathname !== '/api/fwv/rig/draft') return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes('assetId') || !keys.includes('revisionId')) throw invalid('请指定拆件草稿与确切版本。');
  sendJson(200, await loadRigDraft(state.application, Object.fromEntries(url.searchParams)));
  return true;
}
