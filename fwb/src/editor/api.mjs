export const MAX_BODY_BYTES = 64 * 1024;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
export function readCommand(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) { req.resume(); return Promise.reject(invalid('操作内容超过 64 KiB。', 413)); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { failed = true; chunks.length = 0; reject(invalid('操作内容超过 64 KiB。', 413)); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(invalid('操作内容不是有效 JSON。')); }
    });
    req.on('error', reject); req.on('aborted', () => reject(invalid('请求已中断。')));
  });
}
export async function handleWorkbenchApi({ app, req, res, url, sendJson }) {
  const state = app.fwbWorkbench;
  if (!state) throw invalid('请通过 fwb editor 启动工作台。', 503);
  res.setHeader('Cache-Control', 'no-store');
  try {
    const route = url.pathname;
    const query = [...url.searchParams.keys()];
    const expectsId = ['/api/fwb/job', '/api/fwb/artifact', '/api/fwb/release', '/api/fwb/download'].includes(route);
    if (expectsId ? query.length !== 1 || query[0] !== 'id' : query.length !== 0) throw invalid('查询参数不匹配。');
    if (req.method === 'GET' && route === '/api/fwb/session') {
      sendJson(200, { protocol: state.protocol, csrfToken: state.csrfToken, projectRoot: state.projectRoot, fweVersion: state.fweVersion }); return true;
    }
    if (req.method === 'GET' && route === '/api/fwb/snapshot') { sendJson(200, await state.snapshot()); return true; }
    if (req.method === 'GET' && route === '/api/fwb/config') { sendJson(200, await state.configuration()); return true; }
    if (req.method === 'GET' && route === '/api/fwb/environment') { sendJson(200, await state.environment()); return true; }
    if (req.method === 'GET' && route === '/api/fwb/releases') { sendJson(200, await state.releases()); return true; }
    if (req.method === 'GET' && route === '/api/fwb/release') { sendJson(200, await state.release(url.searchParams.get('id'))); return true; }
    if (req.method === 'GET' && route === '/api/fwb/job') { sendJson(200, await state.job(url.searchParams.get('id'))); return true; }
    if (req.method === 'GET' && route === '/api/fwb/artifact') { sendJson(200, await state.artifact(url.searchParams.get('id'))); return true; }
    if (req.method === 'GET' && route === '/api/fwb/download') {
      const artifact = await state.artifact(url.searchParams.get('id'));
      const { packageArtifact } = await import('../core/package.mjs');
      const bytes = packageArtifact(artifact); res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.id}.zip"`); res.end(bytes); return true;
    }
    if (req.method === 'POST' && route === '/api/fwb/commands') { const job = await state.command(await readCommand(req)); app.workspaceDir = state.projectRoot; sendJson(202, { job }); return true; }
    throw invalid('API 不存在。', 404);
  } catch (error) { sendJson(error.status || 400, { error: error.message }); return true; }
}
