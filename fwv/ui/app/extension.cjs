module.exports = fwe => {
  async function workspace(ctx) {
    const { getWorkspace } = await import('../core/workspace.mjs');
    return getWorkspace(ctx.source.captureKey);
  }
  const check = name => { if (name !== 'catalog.json') throw Object.assign(new Error('Only the capture catalog is available.'), { status: 404 }); };
  fwe.registerSource('fwv-ui-capture', {
    async list(ctx) { await (await workspace(ctx)).assertCurrent(); return [{ name: 'catalog.json', label: 'UI 截图与覆盖清单', exists: true }]; },
    async read(ctx, name) { check(name); return (await workspace(ctx)).catalog(); },
    async write(ctx, name, payload) { check(name); return (await workspace(ctx)).saveCatalog(payload); }
  });
  fwe.registerApi('/api/fwv/ui-capture', async context => {
    const { handleCaptureApi } = await import('../server.mjs');
    return handleCaptureApi(context);
  });
};
