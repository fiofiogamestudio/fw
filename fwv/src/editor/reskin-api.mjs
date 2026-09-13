import { inspectReskinTemplate } from '../spine/reskin-template.mjs';
const invalid = message => Object.assign(new Error(message), { status: 400 });
export async function executeReskinCommand(state, body) {
  if (!body || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'payload,type') throw invalid('角色换皮命令不匹配。');
  const methods = { 'reskin.create': 'create', 'reskin.update': 'update', 'reskin.generate': 'generate',
    'reskin.cancel': 'cancel', 'reskin.assemble': 'assemble', 'reskin.select': 'select',
    'reskin.localClaim': 'localClaim', 'reskin.localAnalyze': 'localAnalyze', 'reskin.localDispatch': 'localDispatch',
    'reskin.localComplete': 'localComplete', 'reskin.localFail': 'localFail' };
  const method = methods[body.type];
  if (!method) throw invalid('未知的角色换皮命令。');
  return state.reskinWorkflows[method](body.payload);
}
export async function handleReskinApi({ state, url, sendJson }) {
  const keys = [...url.searchParams.keys()];
  if (url.pathname === '/api/fwv/reskin/local-task') {
    if (keys.length !== 2 || !keys.includes('workflowId') || !keys.includes('attemptId')) throw invalid('请指定本地任务所属流程和尝试。');
    sendJson(200, await state.reskinWorkflows.localTask(Object.fromEntries(url.searchParams))); return true;
  }
  if (url.pathname === '/api/fwv/reskin/workflows') {
    if (keys.length > 1 || keys.some(key => key !== 'workflowId')) throw invalid('角色流程查询参数不匹配。');
    sendJson(200, keys.length ? { workflow: await state.reskinWorkflows.get({ workflowId: url.searchParams.get('workflowId') }) }
      : { workflows: await state.reskinWorkflows.list() });
    return true;
  }
  if (url.pathname === '/api/fwv/reskin/template') {
    if (keys.length !== 2 || !keys.includes('assetId') || !keys.includes('revisionId')) throw invalid('请指定骨骼模板和版本。');
    sendJson(200, await inspectReskinTemplate(state.application, Object.fromEntries(url.searchParams))); return true;
  }
  return false;
}
