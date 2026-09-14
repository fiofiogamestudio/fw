module.exports = (fwe) => {
  fwe.registerSource('fwb-project', {
    list: () => [{ name: 'fwb.project.json', label: '平台与产物', exists: true }],
    async read(ctx, name) {
      if (name !== 'fwb.project.json') throw Object.assign(new Error('工作台仅提供当前工程。'), { status: 404 });
      const [{ readProject }, { PLATFORM_LABELS }] = await Promise.all([import('../../core/project.mjs'), import('../state.mjs')]);
      const project = await readProject(ctx.app?.fwbWorkbench?.projectRoot || ctx.workspaceDir);
      return { type: 'json', data: { platforms: Object.entries(PLATFORM_LABELS).map(([target, label]) => ({ target, label, configured: Object.hasOwn(project.config.targets, target), upload: 'plan-only' })) } };
    },
  });
  fwe.registerApi('/api/fwb', async context => {
    const { handleWorkbenchApi } = await import('../api.mjs');
    return handleWorkbenchApi(context);
  });
};
