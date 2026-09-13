const invalid = message => Object.assign(new Error(message), { status: 400 });
function fields(value, required = [], optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw invalid('生成服务操作参数不匹配。');
}
export async function executeGenerationCommand(state, body) {
  fields(body, ['type', 'payload']); const p = body.payload;
  switch (body.type) {
    case 'provider.configure': fields(p, [], ['baseUrl', 'model', 'protocol', 'apiKey', 'clearKey']); return state.imageProvider.configure(p);
    case 'provider.check': fields(p); return state.imageProvider.checkConnection();
    case 'generation.start': return state.generationJobs.start(p);
    case 'generation.cancel': fields(p, ['jobId']); return state.generationJobs.cancel(p);
    case 'generation.save': fields(p, ['jobId']); return state.generationJobs.save(p);
    default: throw invalid('未知的生成操作。');
  }
}
export function handleGenerationApi({ state, url, sendJson }) {
  if (url.pathname === '/api/fwv/provider') { sendJson(200, state.imageProvider.publicConfig()); return true; }
  if (url.pathname !== '/api/fwv/generation/jobs') return false;
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => !['jobId', 'requestId'].includes(key)) || keys.length > 1) throw invalid('生成任务查询参数不匹配。');
  sendJson(200, keys.length ? { job: state.generationJobs.get(Object.fromEntries(url.searchParams)) } : { jobs: state.generationJobs.list() });
  return true;
}
