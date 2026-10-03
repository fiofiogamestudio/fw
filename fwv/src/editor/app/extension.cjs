module.exports = (fwe) => {
  function authoringOptions(ctx) { return { projectRoot: ctx.workspaceDir, expectedProjectId: ctx.source.expectedProjectId }; }
  function assertAuthoringName(name) {
    if (name !== 'authoring.json') throw Object.assign(new Error('工作区仅提供当前项目的参数草稿。'), { status: 404 });
  }
  fwe.registerSource('fwv-authoring', {
    async list(ctx) {
      const { readProjectedAuthoring } = await import('../catalog.mjs');
      const resource = await readProjectedAuthoring(authoringOptions(ctx));
      return [{ name: 'authoring.json', label: '2D 美术编辑', exists: resource.exists }];
    },
    async read(ctx, name) {
      assertAuthoringName(name);
      const { readProjectedAuthoring } = await import('../catalog.mjs');
      return readProjectedAuthoring(authoringOptions(ctx));
    },
    async write(ctx, name, payload) {
      assertAuthoringName(name);
      const { writeProjectedAuthoring } = await import('../catalog.mjs');
      return writeProjectedAuthoring({ ...authoringOptions(ctx), payload });
    }
  });
  fwe.registerSource('fwv-catalog', {
    async list(ctx) {
      const { listCatalog } = await import('../catalog.mjs');
      return listCatalog(authoringOptions(ctx));
    },
    async read(ctx, name) {
      if (name !== 'catalog.json') throw Object.assign(new Error('图库仅提供当前项目的素材索引。'), { status: 404 });
      const { readCatalog } = await import('../catalog.mjs');
      return readCatalog(authoringOptions(ctx));
    }
  });
  fwe.registerApi('/api/fwv', async context => {
    const { handleWorkbenchApi } = await import('../api.mjs');
    return handleWorkbenchApi(context);
  });
};
