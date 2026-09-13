module.exports = (fwe) => {
  function authoringOptions(ctx) { return { projectRoot: ctx.workspaceDir, expectedProjectId: ctx.source.expectedProjectId }; }
  function assertAuthoringName(name) {
    if (name !== 'authoring.json') throw Object.assign(new Error('工作区仅提供当前项目的参数草稿。'), { status: 404 });
  }
  fwe.registerSource('fwv-authoring', {
    async list(ctx) {
      const { readAuthoring } = await import('../authoring.mjs');
      const resource = await readAuthoring(authoringOptions(ctx));
      return [{ name: 'authoring.json', label: '美术参数草稿', exists: resource.exists }];
    },
    async read(ctx, name) {
      assertAuthoringName(name);
      const { readAuthoring } = await import('../authoring.mjs');
      return readAuthoring(authoringOptions(ctx));
    },
    async write(ctx, name, payload) {
      assertAuthoringName(name);
      const { writeAuthoring } = await import('../authoring.mjs');
      return writeAuthoring({ ...authoringOptions(ctx), payload });
    }
  });
  fwe.registerSource('fwv-project', {
    list: () => [{ name: 'fwv.project.json', label: '美术项目', exists: true }],
    async read(ctx, name) {
      if (name !== 'fwv.project.json') throw Object.assign(new Error('工作区仅提供当前项目。'), { status: 404 });
      const { FwvProject } = await import('../../core/project.mjs');
      const data = await new FwvProject(ctx.workspaceDir).snapshot();
      if (data.id !== ctx.source.expectedProjectId) throw Object.assign(new Error('项目身份变化，请重启工作台。'), { status: 409 });
      return { type: 'json', data };
    }
  });
  fwe.registerApi('/api/fwv', async context => {
    const { handleWorkbenchApi } = await import('../api.mjs');
    return handleWorkbenchApi(context);
  });
};
