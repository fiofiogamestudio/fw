(function () {
  'use strict';
  let configuration, projectSnapshot, session, initializing;
  const selections = new Map();
  const clone = value => structuredClone(value);
  async function api(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options, headers: window.fwe.session.headers(options.headers || {}) });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
    return body;
  }
  async function initialize() {
    if (!initializing) initializing = Promise.all([api('/api/fwv/ui'), api('/api/fwv/session'), api('/api/fwv/snapshot')])
      .then(([ui, currentSession, snapshot]) => { configuration = ui; session = currentSession; projectSnapshot = snapshot; })
      .catch(error => { initializing = null; throw error; });
    await initializing;
  }
  async function refresh() {
    const snapshot = await api('/api/fwv/snapshot');
    if (snapshot.id !== session.projectId) throw new Error('Project identity changed. Reload the editor.');
    projectSnapshot = snapshot;
    return snapshot;
  }
  function resolveField(context, schemaPath) {
    const domain = context.app.domains.find(entry => entry.id === 'fwv-authoring');
    const [collection, ...parts] = schemaPath.replaceAll('[]', '').split('.');
    let fields = domain.inspector.forms[collection]?.groups.flatMap(group => group.fields || []), field;
    for (const part of parts) { field = fields?.find(item => item.path === part); fields = field?.fields || field?.item?.fields; }
    if (!field) throw new Error('Unknown model field: ' + schemaPath);
    return field;
  }
  window.createFwv2dForm = function (context, panel, mount) {
    // The native collection owns browsing, selection and history. This element
    // occupies only its selected item's professional preview/edit field.
    const wrapper = window.fwe.ui.createSurface({ root: 'root', templates: { root: { type: 'stack', preset: 'compact', children: [
      { type: 'slot', ref: 'content' }, { type: 'text', text: { $path: 'notice', default: '' }, tone: 'danger' }
    ] } } });
    let disposed = false, panelDispose;
    // FWE invokes this Form's disposal. Keep ownership of surfaces created by
    // the async mount even if that mount throws before returning its cleanup.
    const surfaces = new Set();
    const isCurrent = () => !disposed && window.fwe.navigation.current().domainId === context.domain.id;
    const notify = text => { if (!disposed) wrapper.update({ notice: text }); };
    const record = {
      element: wrapper.root,
      canLeave: () => !panelDispose?.canLeave || panelDispose.canLeave() !== false,
      dispose() { if (disposed) return; disposed = true; panelDispose?.(); for (const surface of surfaces) surface.dispose(); surfaces.clear(); wrapper.dispose(); }
    };
    void initialize().then(async () => {
      if (disposed) return;
      const row = context.target;
      const reference = panel === 'gallery2d' ? context.value : selections.get(row.id) || context.value;
      if (panel === 'skeleton2d') selections.delete(row.id);
      if (!reference?.assetId) throw new Error('A registered asset selection is required.');
      let asset = projectSnapshot.assets.find(item => item.id === reference.assetId);
      if (!asset || !asset.revisions.some(item => item.id === reference.revisionId)) {
        await refresh(); asset = projectSnapshot.assets.find(item => item.id === reference.assetId);
      }
      if (disposed) return;
      const services = {
        api, getSnapshot: () => projectSnapshot, selection: clone(reference), variants: clone(row.variants || []),
        refreshView: () => { if (isCurrent()) context.render(); },
        createSurface(name, options = {}) {
          const surface = window.fwe.ui.createSurface(configuration[name], { ...options, resolveField: path => resolveField(context, path) });
          surfaces.add(surface); return surface;
        },
        async command(type, payload) {
          if (!isCurrent()) throw new Error('The selected editor resource has changed.');
          const result = await api('/api/fwv/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FWV-CSRF': session.csrfToken }, body: JSON.stringify({ type, payload }) });
          await refresh(); return result.result;
        },
        drafts: {
          get(collection, id) { return clone(context.data?.[collection]?.find(item => item.id === id)?.data || null); },
          set(collection, id, value) {
            if (!isCurrent() || panel !== 'skeleton2d' || collection !== 'skeleton2dDrafts' || id !== row.id) throw new Error('The selected draft has changed.');
            context.setValue(clone(value), { refresh: false });
            const asset = projectSnapshot.assets.find(item => item.id === id);
            const revision = asset?.revisions.find(item => item.id === value.revisionId);
            if (revision) {
              const textures = revision.files.filter(file => /^image\/(png|jpeg|webp)$/.test(file.mime));
              row.revisionLabel = 'v' + (asset.revisions.indexOf(revision) + 1);
              row.textureCount = textures.length;
              row.thumbnailUrl = '/api/fwv/skeleton2d-thumbnail?' + new URLSearchParams({ assetId: id, revisionId: revision.id });
            }
          },
          async save() {
            if (!isCurrent()) throw new Error('The selected draft has changed.');
            if (await window.fwe.resources.saveCurrent({ refresh: false }) !== true) throw new Error('Draft save failed. Check the FWE status.');
          }
        },
        async navigate(target, selection) {
          if (target !== 'skeleton2d') throw new Error('Unknown 2D target.');
          selections.set(selection.assetId, clone(selection));
          return context.navigation.navigate({ domainId: 'fwv-authoring', fileName: 'authoring.json', collectionId: 'skeleton2dDrafts', itemId: selection.assetId, mode: 'edit' }, { updateUrl: true });
        }
      };
      panelDispose = mount(wrapper.refs.content, services);
    }).catch(error => notify(error.message));
    return record;
  };
}());
