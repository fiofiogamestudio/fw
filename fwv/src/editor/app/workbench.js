(function () {
  'use strict';
  const mounted = new WeakMap();
  let configs, loading;
  function mount(host, ctx, workbench) {
    const panelCollections = Object.fromEntries(ctx.app.navigation.workspaces.flatMap(workspace => workspace.sections)
      .filter(section => section.domainId === ctx.domain.id).map(section => [section.id, section.collectionId]));
    function resolveField(schemaPath) {
      const [collection, ...parts] = schemaPath.replaceAll('[]', '').split('.');
      let fields = ctx.domain.inspector.forms[collection]?.groups.flatMap(group => group.fields || []), field;
      for (const part of parts) { field = fields?.find(item => item.path === part); fields = field?.fields || field?.item?.fields; }
      if (!field) throw new Error('Unknown model field: ' + schemaPath);
      return field;
    }
    const surfaces = new Set();
    function createSurface(name, options = {}) {
      const surface = window.fwe.ui.createSurface(configs[name], { ...options, resolveField });
      surfaces.add(surface);
      const dispose = surface.dispose;
      surface.dispose = () => { dispose(); surfaces.delete(surface); };
      return surface;
    }
    const ui = createSurface('workbench', { data: { busy: false, ready: false, panel: '', notice: '', statusTone: 'muted', dragging: false } }), t = (key, vars) => ui.text(key, vars);
    let fweContext = ctx, authoringData = ctx.data, authoringSignature = JSON.stringify(ctx.data), applyingDraft = false;
    const state = { data: { assets: [], exports: [] }, session: null, assetId: null,
      revisionId: null, busy: false, loaded: false, panel: 'assets', panelSelection: {} };
    const selections = new Map();
    function selectedDraftId(panel) {
      const selected = selections.get(panel) || {};
      return panel === 'assets' ? `${selected.assetId || state.assetId}:${selected.revisionId || state.revisionId}` : panel === 'reskin' ? selected.workflowId || 'new' : panel === 'generate' ? 'current'
        : panel === 'images' ? `${state.assetId}:${state.revisionId}` : selected.assetId || (panel === 'rig' ? 'new' : '');
    }
    function syncPanelNavigation(panel = state.panel) {
      queueMicrotask(() => {
        if (disposed || suspended || panel !== state.panel || fweContext.domain.id !== 'fwv-authoring') return;
        const collectionId = panelCollections[panel], itemId = selectedDraftId(panel), current = fweContext.navigation.current();
        if (!fweContext.data?.[collectionId]?.some(item => item.id === itemId) || current.collectionId !== collectionId || current.itemId === itemId) return;
        void fweContext.navigation.navigate({ domainId: fweContext.domain.id, fileName: 'authoring.json', collectionId, itemId }, { updateUrl: true });
      });
    }
    function selectAuthoringRow(context, currentWorkbench) {
      const collectionId = currentWorkbench.collection?.id;
      const row = context.getByPath(context.data, context.selection.key);
      if (!row?.id || !context.data?.[collectionId]?.some(item => item.id === row.id)) return;
      const panel = Object.keys(panelCollections).find(id => panelCollections[id] === collectionId);
      const selected = panel === 'reskin' ? { workflowId: row.id === 'new' ? '' : row.id }
        : { assetId: row.data.assetId || '', revisionId: row.data.revisionId || '' };
      selections.set(panel, selected);
    }
    selectAuthoringRow(ctx, workbench);
    const drafts = {
      get(collection, id) { const entry = fweContext.data?.[collection]?.find(item => item.id === id); return entry ? structuredClone(entry.data) : null; },
      set(collection, id, data) {
        const rows = fweContext.data?.[collection];
        if (!Array.isArray(rows) || typeof id !== 'string' || !id) throw new Error(t('invalidDraft'));
        const value = structuredClone(data), index = rows.findIndex(item => item.id === id);
        if (index >= 0 && JSON.stringify(rows[index].data) === JSON.stringify(value)) return;
        fweContext.pushHistory(t('editDraft'));
        if (index >= 0) rows[index] = { id, data: value }; else rows.push({ id, data: value });
        applyingDraft = true;
        try { fweContext.markDirty(t('draft')); } finally { applyingDraft = false; }
        syncPanelNavigation();
      },
      remove(collection, id) {
        const rows = fweContext.data?.[collection], index = rows?.findIndex(item => item.id === id);
        if (index === undefined || index < 0) return;
        fweContext.pushHistory(t('removeDraft')); rows.splice(index, 1);
        applyingDraft = true; try { fweContext.markDirty(t('draft')); } finally { applyingDraft = false; }
      },
      async save() { const result = await window.fwe.resources.saveCurrent(); if (result !== true) throw new Error(t('saveFailed')); return result; },
    };
    let extensionDispose, suspended = false, disposed = false;
    const root = ui.render('root');
    const { content, picker, importButton, refreshButton } = root.refs;
    picker.addEventListener('change', () => { void importFiles(picker.files); picker.value = ''; });
    importButton.addEventListener('click', () => picker.click());
    refreshButton.addEventListener('click', () => { void refresh(true).catch(() => {}); });
    host.replaceChildren(root);
    let noticeVersion = 0, noticeIsError = false;
    function notify(text, error = false) { noticeVersion++; noticeIsError = error; ui.update({ notice: text, error, statusTone: error ? 'danger' : 'muted' }, root); }
    async function api(url, options = {}) {
      const response = await fetch(url, { cache: 'no-store', ...options,
        headers: window.fwe.session.headers(options.headers || {}) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error || t('requestFailed', { status: response.status })), { status: response.status, code: body.code });
      return body;
    }
    function syncBusy() { ui.update({ busy: state.busy, ready: Boolean(state.session) }, root); }
    async function refresh(announce = false) {
      try {
        state.session ||= await api('/api/fwv/session');
        if (state.session.protocol !== 'fwv-workbench-v1') throw new Error(t('protocolMismatch'));
        const data = await api('/api/fwv/snapshot');
        if (data.id !== state.session.projectId) throw new Error(t('projectChanged'));
        state.data = data; state.loaded = true;
        if (!data.assets.some(asset => asset.id === state.assetId)) state.assetId = data.assets[0]?.id || null;
        const selected = data.assets.find(asset => asset.id === state.assetId);
        if (!selected?.revisions.some(revision => revision.id === state.revisionId)) state.revisionId = selected?.selectedRevisionId || selected?.revisions.at(-1)?.id;
        if (state.panel === 'images' && extensionDispose) showPanel('images', { assetId: state.assetId, revisionId: state.revisionId }, { fromFwe: true, force: true });
        if (announce) notify(t('refreshed', { count: data.assets.length, time: new Date().toLocaleTimeString() }));
        syncBusy(); return data;
      } catch (error) { notify(error.message, true); throw error; }
    }
    async function command(type, payload) {
      if (state.busy) throw new Error(t('busy'));
      if (!state.session) throw new Error(t('disconnected'));
      const previousNoticeVersion = noticeVersion;
      state.busy = true; syncBusy();
      try {
        const response = await api('/api/fwv/commands', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-FWV-CSRF': state.session.csrfToken },
          body: JSON.stringify({ type, payload }) });
        if (response.result?.revisions) { state.assetId = response.result.id; state.revisionId = response.result.selectedRevisionId; }
        await refresh();
        if (noticeIsError && noticeVersion === previousNoticeVersion) notify('');
        return response.result;
      } catch (error) { notify(error.message, true); throw error; }
      finally { state.busy = false; syncBusy(); }
    }
    async function importFiles(files) {
      const inputs = Array.from(files || []); if (!inputs.length) return;
      if (state.busy) { notify(t('importBusy'), true); return; }
      let completed = 0;
      try {
        for (const file of inputs) {
          if (!/\.(png|jpe?g|webp|glb)$/i.test(file.name)) throw new Error(t('unsupported', { name: file.name }));
          if (!file.size || file.size > 20 * 1024 * 1024) throw new Error(t('oversize', { name: file.name }));
          notify(t('importProgress', { name: file.name, index: completed + 1, count: inputs.length }));
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(new Error(t('readFailed'))); reader.readAsDataURL(file);
          });
          await command(/\.glb$/i.test(file.name) ? 'model.import' : 'image.import', { name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, base64 }); completed++;
        }
        if (state.panel === 'assets') showPanel('assets', { assetId: state.assetId, revisionId: state.revisionId }, { fromFwe: true, force: true });
        else if (state.panel !== 'images') showPanel('assets', { assetId: state.assetId, revisionId: state.revisionId });
        notify(t('imported', { count: completed }));
      } catch (error) { notify(`${error.message}${completed ? t('partialImport', { count: completed }) : ''}`, true); }
    }
    let dragDepth = 0;
    root.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; ui.update({ dragging: true }, root); });
    root.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
    root.addEventListener('dragleave', () => { if (--dragDepth <= 0) ui.update({ dragging: false }, root); });
    root.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; ui.update({ dragging: false }, root); void importFiles(event.dataTransfer.files); });
    function showPanel(id, selection = {}, { fromFwe = false, force = false } = {}) {
      if (disposed || suspended) return false;
      if (!fromFwe && panelCollections[id] && fweContext.domain.workbench?.collections?.some(item => item.id === panelCollections[id])) {
        selections.set(id, { ...(selections.get(id) || {}), ...selection });
        void fweContext.navigation.navigate({ domainId: fweContext.domain.id, fileName: 'authoring.json', collectionId: panelCollections[id] }, { updateUrl: true });
        return true;
      }
      if (extensionDispose?.canLeave && !extensionDispose.canLeave()) return false;
      if (!force && state.panel === id && extensionDispose && !Object.keys(selection).length) return true;
      extensionDispose?.(); extensionDispose = null; state.panel = id;
      state.panelSelection = { ...(selections.get(id) || {}), ...selection }; selections.set(id, state.panelSelection);
      if (selection.assetId) state.assetId = selection.assetId;
      if (selection.revisionId) state.revisionId = selection.revisionId;
      ui.update({ panel: id }, root);
      content.replaceChildren();
      const definition = (window.FwvPanels || []).find(panel => panel.id === id);
      if (definition) extensionDispose = definition.mount(content, { api, command, refresh, importAssets: () => picker.click(),
        getSnapshot: () => state.data, notify, createSurface, getUiConfig: name => configs[name], getSession: () => state.session, selection: id === 'images' ? { assetId: state.assetId, revisionId: state.revisionId, ...state.panelSelection } : state.panelSelection,
        drafts, setSelection: patch => { Object.assign(state.panelSelection, patch); if (id === 'images') Object.assign(state, patch); selections.set(id, state.panelSelection); syncPanelNavigation(id); },
        navigate: (panel, selection = {}) => showPanel(panel, selection) });
    }
    function update(nextContext, nextWorkbench) {
      fweContext = nextContext;
      const signature = JSON.stringify(nextContext.data);
      const replaced = authoringData !== nextContext.data || signature !== authoringSignature;
      authoringData = nextContext.data; authoringSignature = signature;
      const selectedPanel = Object.keys(panelCollections).find(id => panelCollections[id] === nextWorkbench.collection?.id) || state.panel;
      // Navigation may arrive while the initial project snapshot is loading.
      // Remember its destination now so initialization mounts the latest route.
      if (!state.loaded) { state.panel = selectedPanel; selectAuthoringRow(nextContext, nextWorkbench); return; }
      const resuming = suspended; suspended = false;
      if (resuming) selectAuthoringRow(nextContext, nextWorkbench);
      if (state.session && (resuming || replaced && !applyingDraft || selectedPanel !== state.panel)) showPanel(selectedPanel, selections.get(selectedPanel) || {}, { fromFwe: true, force: true });
    }
    const selectedPanel = Object.keys(panelCollections).find(id => panelCollections[id] === workbench.collection?.id);
    if (selectedPanel) state.panel = selectedPanel;
    void refresh().then(() => { showPanel(state.panel, {}, { fromFwe: true, force: true }); notify(t('ready')); }).catch(() => {});
    function onResourceChanged(event) {
      if (event.detail?.domain?.id !== 'fwv-authoring' || !event.detail?.file) record.dispose();
    }
    const record = { root, update,
      suspend() { suspended = true; extensionDispose?.(); extensionDispose = null; },
      dispose() { disposed = true; record.suspend(); surfaces.forEach(surface => surface.dispose()); root.remove(); window.removeEventListener('fwe:resource-opened', onResourceChanged); window.removeEventListener('fwe:resource-cleared', onResourceChanged); }
    };
    window.addEventListener('fwe:resource-opened', onResourceChanged);
    window.addEventListener('fwe:resource-cleared', onResourceChanged);
    return record;
  }
  window.fwe.registerWorkbenchLayout('fwv-workbench', {
    noInspector: () => true,
    render(ctx, layout, workbench) {
      const host = ctx.hosts.documentTree, record = mounted.get(host);
      if (!configs) {
        loading ||= fetch('/api/fwv/ui', { headers: window.fwe.session.headers(), cache: 'no-store' })
          .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error); configs = body; })
          .catch(error => { loading = null; ctx.setStatus(error.message); });
        void loading.then(() => { if (configs) ctx.render(); }); return;
      }
      ctx.showView('document');
      if (!mounted.has(host) || !mounted.get(host)?.root.isConnected) { mounted.get(host)?.dispose(); mounted.set(host, mount(host, ctx, workbench)); }
      else mounted.get(host).update(ctx, workbench);
    }
  });
}());
