(function () {
  'use strict';
  const revisionImage = revision => revision?.files?.find(file => file.role === 'image')
    || revision?.files?.find(file => /^image\/(png|jpeg|webp)$/.test(file.mime || ''));
  function artifactUrl(asset, revision) {
    const file = revisionImage(revision);
    return file ? `/api/fwv/artifact?${new URLSearchParams({ assetId: asset.id, revisionId: revision.id, fileName: file.name })}` : '';
  }
  function mount(host, ctx) {
    const ui = ctx.createSurface('image', { actions: { selectAsset: ({ data }) => {
      const asset = ctx.getSnapshot().assets.find(item => item.id === data.id);
      assetId = asset.id; revisionId = asset.selectedRevisionId;
      ctx.setSelection({ assetId, revisionId }); render();
    } } });
    const t = (key, vars) => ui.text(key, vars);
    let assetId = ctx.selection.assetId, revisionId = ctx.selection.revisionId;
    const run = action => () => { Promise.resolve().then(action).catch(error => ctx.notify(error.message, true)); };
    const deliveryPath = pkg => `${ctx.getSession()?.projectRoot || ''}/${pkg.path || `exports/${pkg.id}`}`.replaceAll('\\', '/');
    function imageInfo(rev) {
      const meta = rev.metadata?.image || {};
      return t('imageInfo', { width: meta.width || '?', height: meta.height || '?', alpha: meta.hasAlpha ? t('alpha') : '' });
    }
    function render() {
      const snapshot = ctx.getSnapshot(), images = snapshot.assets.filter(asset => asset.kind === 'image');
      const asset = images.find(item => item.id === assetId) || images[0];
      const revision = asset?.revisions.find(item => item.id === revisionId) || asset?.revisions.find(item => item.id === asset.selectedRevisionId) || asset?.revisions.at(-1);
      if (asset && revision) { assetId = asset.id; revisionId = revision.id; ctx.setSelection({ assetId, revisionId }); }
      const root = ui.render('root', { librarySummary: t('librarySummary', { count: images.length }) }), refs = root.refs;
      for (const item of images) {
        const rev = item.revisions.find(rev => rev.id === item.selectedRevisionId) || item.revisions.at(-1), meta = rev?.metadata?.image;
        refs.library.append(ui.render('asset', { id: item.id, name: item.name, selected: item.id === assetId, url: artifactUrl(item, rev),
          summary: t('assetSummary', { width: meta?.width || '?', height: meta?.height || '?', count: item.revisions.length }) }));
      }
      if (!asset || !revision) {
        const empty = ui.render('empty');
        refs.stage.append(empty); host.replaceChildren(root); return;
      }
      const original = asset.revisions.find(item => !item.parentId) || asset.revisions[0];
      const preview = ui.render('preview', { name: asset.name, originalUrl: artifactUrl(asset, original), currentUrl: artifactUrl(asset, revision), originalInfo: imageInfo(original), currentInfo: imageInfo(revision), revision: revision.id });
      ui.setOptions(preview.refs.revision, asset.revisions.map((item, index) => ({ value: item.id, label: t('version', { index: index + 1, kind: t(index === 0 ? 'original' : 'processed'), delivery: item.id === asset.selectedRevisionId ? t('delivery') : '' }) })), revision.id);
      preview.refs.revision.addEventListener('change', () => { revisionId = preview.refs.revision.value; ctx.setSelection({ assetId, revisionId }); render(); });
      preview.refs.choose.addEventListener('click', run(async () => { await ctx.command('revision.select', { assetId, revisionId }); ctx.notify(t('selected')); }));
      refs.stage.append(preview);
      const draftId = `${asset.id}:${revision.id}`, meta = revision.metadata?.image || {};
      const draft = ctx.drafts.get('imageDrafts', draftId);
      const canRevise = Boolean(revision.parentId && revision.recipe?.version === 1 && !revision.recipe.operation);
      let processingMode = canRevise ? draft?.processingMode || 'revise' : 'append';
      const defaults = mode => mode === 'revise' ? revision.recipe : { width: meta.width || 256, height: meta.height || 256, padding: 0, trim: false, fit: 'contain', background: 'transparent' };
      const recipes = { [processingMode]: draft?.recipe || defaults(processingMode) };
      const recipe = recipes[processingMode];
      const sourceSummary = () => {
        const inputId = processingMode === 'revise' ? revision.metadata?.processing?.inputRevisionId || revision.parentId : revision.id;
        return t(processingMode === 'revise' ? 'reviseSource' : 'appendSource', { input: asset.revisions.findIndex(item => item.id === inputId) + 1, current: asset.revisions.indexOf(revision) + 1 });
      };
      const latest = [...(snapshot.exports || [])].reverse().find(item => item.assetId === asset.id && item.revisionId === revision.id), report = revision.validation;
      const settings = ui.render('settings', {
        canRevise, processingMode, sourceSummary: sourceSummary(),
        width: recipe.width ?? meta.width ?? 256, height: recipe.height ?? meta.height ?? 256,
        padding: recipe.padding ?? 0, trim: Boolean(recipe.trim), fit: recipe.fit ?? 'contain', background: recipe.background ?? 'transparent',
        'color-key': Boolean(recipe.removeBackground), 'key-color': recipe.removeBackground?.color ?? '#ffffff', tolerance: recipe.removeBackground?.tolerance ?? 24,
        validationStatus: t(report?.status === 'passed' ? 'passed' : report?.status === 'failed' ? 'failed' : 'pending'),
        checks: (report?.checks || []).map(item => ({ label: t('check', { status: t(item.status === 'passed' ? 'checkPass' : 'checkFail'),
          label: item.id.startsWith('artifact:') ? t('artifact', { name: item.id.slice(9) }) : ctx.getUiConfig('image').texts[item.id] || item.id }) })),
        exportPath: latest ? deliveryPath(latest) : ''
      });
      const controls = settings.refs;
      function readRecipe() {
        const value = { width: Number(controls.width.value), height: Number(controls.height.value), padding: Number(controls.padding.value),
          trim: controls.trim.checked, fit: controls.fit.value, background: controls.background.value };
        if (controls['color-key'].checked) value.removeBackground = { color: controls['key-color'].value, tolerance: Number(controls.tolerance.value) };
        return value;
      }
      const record = () => ctx.drafts.set('imageDrafts', draftId, { assetId: asset.id, revisionId: revision.id, processingMode, recipe: readRecipe() });
      controls.processingMode.addEventListener('change', () => {
        recipes[processingMode] = readRecipe(); processingMode = controls.processingMode.value;
        const next = recipes[processingMode] || defaults(processingMode);
        ui.update({ processingMode, sourceSummary: sourceSummary(), width: next.width ?? meta.width, height: next.height ?? meta.height,
          padding: next.padding ?? 0, trim: Boolean(next.trim), fit: next.fit || 'contain', background: next.background || 'transparent',
          'color-key': Boolean(next.removeBackground), 'key-color': next.removeBackground?.color || '#ffffff', tolerance: next.removeBackground?.tolerance ?? 24 }, settings);
        record();
      });
      controls['color-key'].addEventListener('change', () => ui.update({ 'color-key': controls['color-key'].checked }, settings));
      controls.form.addEventListener('input', record); controls.form.addEventListener('change', record);
      controls.form.addEventListener('submit', event => {
        event.preventDefault(); if (!controls.form.reportValidity()) return;
        ctx.notify(t('processing'));
        void ctx.command('image.process', { assetId: asset.id, revisionId: revision.id, recipe: readRecipe(), mode: processingMode })
          .then(() => ctx.notify(t('processedNotice'))).catch(() => {});
      });
      controls.validate.addEventListener('click', run(async () => {
        const result = await ctx.command('revision.validate', { assetId: asset.id, revisionId: revision.id });
        ctx.notify(t(result.status === 'passed' ? 'validatePassed' : 'validateFailed'), result.status !== 'passed');
      }));
      controls.export.addEventListener('click', run(async () => {
        const result = await ctx.command('asset.export', { assetId: asset.id, revisionId: revision.id });
        ctx.notify(t('exported', { path: deliveryPath(result) }));
      }));
      refs.settings.append(settings); host.replaceChildren(root);
    }
    render(); return () => ui.dispose();
  }
  (window.FwvPanels ||= []).push({ id: 'images', mount });
}());
