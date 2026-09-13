(function () {
  'use strict';
  const imageFile = revision => revision?.files?.find(file => file.role === 'image') || revision?.files?.find(file => /^image\/(png|jpeg|webp)$/.test(file.mime || ''));
  const artifactUrl = (assetId, revisionId, fileName) => '/api/fwv/artifact?' + new URLSearchParams({ assetId, revisionId, fileName });
  const terminal = job => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(job?.status);
  const activeJob = job => ['queued', 'running'].includes(job?.status);
  (window.FwvPanels ||= []).push({ id: 'generate', mount(host, ctx) {
    const ui = ctx.createSurface('generation'); const jobLabels = status => ui.text(`job_${status}`); const root = ui.root; host.append(root);
    const base64 = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error(ui.text('message001'))); reader.readAsDataURL(file); });
    const { providerForm, providerFields, baseUrl, model, protocol, apiKey, keyStatus, saveSettings, checkSettings, clearKey, providerStatus,
      form, fields, name, prompt, size, quality, background, capabilityNote, importReference, referenceInput, referencePreview, generate, generationStatus,
      jobBadge, result, elapsed, jobMessage, jobMeta, cancel, query, save, openImage, uncertainty, acknowledged, newRequest, jobsSelect } = ui.refs;
    const referenceAsset = ui.refs.referenceAssetId, referenceRevision = ui.refs.referenceRevisionId, jobsField = ui.refs.jobsSelectField;
    const click = (node, handler) => node.addEventListener('click', () => { Promise.resolve().then(handler).catch(() => {}); });
    const projectId = ctx.getSnapshot().id, storageKey = `fwv.generation.pending.v1:${projectId}`;
    const abort = new AbortController();
    const state = { disposed: false, busy: false, connected: false, provider: null, snapshot: ctx.getSnapshot(), jobs: [], job: null,
      requestId: null, unresolved: false, polling: false, pollTimer: null, referenceAssetId: '', referenceRevisionId: '' };
    try { const recorded = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); if (typeof recorded?.requestId === 'string' && /^[a-z0-9-]{16,80}$/i.test(recorded.requestId)) { state.requestId = recorded.requestId; state.unresolved = true; } } catch {}
    function savePending(requestId) { state.requestId = requestId; try { if (requestId) sessionStorage.setItem(storageKey, JSON.stringify({ requestId })); else sessionStorage.removeItem(storageKey); } catch {} }
    const statusNames = new Map([[providerStatus, 'providerStatus'], [generationStatus, 'generationStatus'], [jobMessage, 'jobMessage']]);
    function note(node, text, error = false) { if (state.disposed) return; const key = statusNames.get(node); ui.update({ [key + 'Text']: text, [key + 'Error']: error }); }
    click(checkSettings, () => run(async () => {
      const result = await ctx.command('provider.check', {});
      note(providerStatus, result?.message || ui.text('message002'), result?.ok === false || result?.status === 'failed');
    }, providerStatus));
    click(clearKey, () => run(async () => {
      apiKey.value = '';
      await ctx.command('provider.configure', { baseUrl: state.provider.baseUrl, model: state.provider.model, protocol: state.provider.protocol, clearKey: true });
      await loadProvider(); note(providerStatus, ui.text('message003'));
    }, providerStatus));
    click(importReference, () => referenceInput.click());
    providerForm.addEventListener('submit', event => {
      event.preventDefault(); if (!providerForm.reportValidity()) return;
      void run(async () => {
        const payload = { baseUrl: baseUrl.value.trim(), model: model.value.trim(), protocol: protocol.value };
        if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
        // Do not retain credentials in any DOM attribute, draft or browser storage.
        apiKey.value = '';
        try { await ctx.command('provider.configure', payload); } finally { delete payload.apiKey; }
        await loadProvider(); note(providerStatus, ui.text('message004'));
      }, providerStatus);
    });

    const draft = ctx.drafts.get('generationDrafts', 'current');
    if (draft) { name.value = draft.name || ''; prompt.value = draft.prompt || ''; size.value = draft.size || '1024x1024'; quality.value = draft.quality || 'auto'; background.value = draft.background || 'auto'; state.referenceAssetId = draft.referenceAssetId || ''; state.referenceRevisionId = draft.referenceRevisionId || ''; }
    function saveDraft() { ctx.drafts.set('generationDrafts', 'current', { name: name.value, prompt: prompt.value, size: size.value, quality: quality.value, background: background.value,
      referenceAssetId: state.referenceAssetId, referenceRevisionId: state.referenceRevisionId }); }
    for (const node of [name, prompt, size, quality, background]) { node.addEventListener('input', saveDraft); node.addEventListener('change', saveDraft); }
    function updateBackground() {
      const compatible = protocol.value === 'openai-compatible'; if (compatible) background.value = 'auto';
      ui.update({ disableBackground: compatible || !state.connected || state.busy || activeJob(state.job) || state.job?.status === 'unknown' || state.unresolved || state.job?.status === 'ready',
        capabilityNoteText: compatible ? ui.text('message005') : ui.text('message006') });
    }
    function providerDirty() {
      if (!state.provider) return false;
      return baseUrl.value.trim().replace(/\/$/, '') !== state.provider.baseUrl?.replace(/\/$/, '')
        || model.value.trim() !== state.provider.model || protocol.value !== state.provider.protocol || Boolean(apiKey.value);
    }
    for (const node of [baseUrl, model, protocol, apiKey]) node.addEventListener('input', () => {
      if (providerDirty()) note(providerStatus, ui.text('message007')); sync();
    });
    protocol.addEventListener('change', () => { updateBackground(); sync(); });
    referenceAsset.addEventListener('change', () => { state.referenceAssetId = referenceAsset.value; state.referenceRevisionId = ''; renderReferences(); saveDraft(); });
    referenceRevision.addEventListener('change', () => { state.referenceRevisionId = referenceRevision.value; renderReferencePreview(); saveDraft(); });
    referenceInput.addEventListener('change', () => {
      const file = referenceInput.files[0]; referenceInput.value = ''; if (!file) return;
      void run(async () => {
        if (!/\.(png|jpe?g|webp)$/i.test(file.name) || !file.size || file.size > 20 * 1024 * 1024) throw new Error(ui.text('message008'));
        const asset = await ctx.command('image.import', { name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, base64: await base64(file) });
        state.snapshot = ctx.getSnapshot(); state.referenceAssetId = asset.id; state.referenceRevisionId = asset.selectedRevisionId; renderReferences(); saveDraft();
        note(generationStatus, ui.text('message009'));
      });
    });

    click(cancel, () => run(async () => { const job = await ctx.command('generation.cancel', { jobId: state.job.id }); acceptJob(job?.job || job); note(generationStatus, ui.text('message010')); }));
    click(query, () => run(async () => { await queryPending(); note(generationStatus, state.unresolved ? ui.text('message011') : ui.text('message012')); }));
    click(save, () => run(async () => { const job = await ctx.command('generation.save', { jobId: state.job.id }); acceptJob(job?.job || job); await refreshSnapshot(); note(generationStatus, ui.text('message013')); }));
    click(openImage, () => { saveDraft(); const job = state.job; ctx.navigate('images', { assetId: job.assetId, revisionId: job.revisionId }); });
    click(newRequest, () => {
      if (!acknowledged.checked) return; savePending(null); state.unresolved = false; state.job = null; acknowledged.checked = false;
      note(generationStatus, ui.text('message014')); renderJob(); sync();
    });
    acknowledged.addEventListener('change', sync);
    jobsSelect.addEventListener('change', () => { const job = state.jobs.find(entry => entry.id === jobsSelect.value); if (job) { state.job = job; renderJob(); } });

    function sync() {
      if (state.disposed) return;
      const active = activeJob(state.job) || state.job?.status === 'unknown' || state.unresolved;
      const providerBlocked = !state.connected || state.busy || active;
      const formBlocked = !state.connected || state.busy || active || state.job?.status === 'ready';
      ui.update({ disableProviderFields: providerBlocked, disableFields: formBlocked,
        disableGenerate: formBlocked || !(state.provider?.canGenerate ?? state.provider?.keyConfigured) || providerDirty(),
        disableCheckSettings: providerBlocked || !(state.provider?.canGenerate ?? state.provider?.keyConfigured),
        disableClearKey: providerBlocked || !state.provider?.keyConfigured,
        disableJobsSelect: state.busy || state.unresolved || ['queued', 'running', 'ready', 'unknown'].includes(state.job?.status),
        disableCancel: state.busy || !activeJob(state.job), disableQuery: state.busy || !state.requestId && !state.job?.id,
        disableSave: state.busy || state.job?.status !== 'ready', disableOpenImage: state.busy || !state.job?.assetId,
        disableNewRequest: state.busy || !acknowledged.checked }); updateBackground();
    }
    async function run(fn, target = generationStatus) {
      if (state.busy || state.disposed) return;
      state.busy = true; sync();
      try { await fn(); } catch (error) { if (!state.disposed) note(target, error.message || ui.text('message015'), true); }
      finally { state.busy = false; sync(); }
    }
    async function loadProvider() {
      const config = await ctx.api('/api/fwv/provider', { signal: abort.signal }); if (state.disposed) return;
      state.provider = config; baseUrl.value = config.baseUrl || 'https://api.openai.com/v1'; model.value = config.model || 'gpt-image-2'; protocol.value = config.protocol || 'gpt-image'; apiKey.value = '';
      const configured = Boolean(config.canGenerate ?? config.keyConfigured);
      ui.update({ providerNeedsSetup: !configured, providerSummary: configured ? ui.text('providerReady', { model: config.model }) : ui.text('providerMissing'),
        keyStatusText: config.keyConfigured ? ui.text('message016', { v0: config.keySource === 'environment' ? ui.text('message017') : ui.text('message018') }) : config.canGenerate ? ui.text('message019') : ui.text('message020') });
      if (!configured) { state.setupHint = true; note(generationStatus, ui.text('message021')); }
      else if (state.setupHint) { state.setupHint = false; note(generationStatus, ''); }
      updateBackground();
    }
    function renderReferences() {
      const assets = state.snapshot.assets.filter(asset => asset.kind === 'image');
      ui.setOptions(referenceAsset, [{ value: '', label: ui.text('message022') }, ...assets.map(asset => ({ value: asset.id, label: asset.name }))]);
      if (!assets.some(asset => asset.id === state.referenceAssetId)) state.referenceAssetId = '';
      referenceAsset.value = state.referenceAssetId; const asset = assets.find(item => item.id === state.referenceAssetId);
      if (!asset?.revisions.some(revision => revision.id === state.referenceRevisionId)) state.referenceRevisionId = asset?.selectedRevisionId || '';
      ui.setOptions(referenceRevision, (asset?.revisions || []).map((revision, index) => ({ value: revision.id, label: `v${index + 1}${revision.id === asset.selectedRevisionId ? ui.text('message023') : ''}` })));
      referenceRevision.value = state.referenceRevisionId; ui.update({ disableReferenceRevisionId: !asset }); renderReferencePreview();
      ui.update({ referenceSummary: asset ? ui.text('referenceSelected', { name: asset.name }) : ui.text('referenceEmpty') });
    }
    function renderReferencePreview() {
      referencePreview.replaceChildren(); const asset = state.snapshot.assets.find(item => item.id === state.referenceAssetId), revision = asset?.revisions.find(item => item.id === state.referenceRevisionId), file = imageFile(revision);
      if (!file) return;
      referencePreview.append(ui.render('reference', { url: artifactUrl(asset.id, revision.id, file.name), name: asset.name, width: revision.metadata?.image?.width || '?', height: revision.metadata?.image?.height || '?' }));
    }
    async function refreshSnapshot() { await ctx.refresh(); if (state.disposed) return; state.snapshot = ctx.getSnapshot(); renderReferences(); renderJob(); }
    function renderJob() {
      if (state.disposed) return; const job = state.job;
      ui.update({ jobBadgeText: state.unresolved ? ui.text('message024') : job?.status ? jobLabels(job.status) : ui.text('message025'), jobState: job?.status || (state.unresolved ? 'unknown' : 'idle') });
      result.replaceChildren();
      const asset = state.snapshot.assets.find(entry => entry.id === job?.assetId), revision = asset?.revisions.find(entry => entry.id === job?.revisionId) || asset?.revisions.find(entry => entry.id === asset.selectedRevisionId), file = imageFile(revision);
      if (file) result.append(ui.render('result', { url: artifactUrl(asset.id, revision.id, file.name), name: asset.name }));
      else result.append(ui.render('empty', { message: job?.status === 'queued' ? ui.text('message026') : job?.status === 'running' ? ui.text('message027') : job?.status === 'ready' ? ui.text('message028') : ui.text('message029') }));
      const error = typeof job?.error === 'string' ? job.error : job?.error?.message;
      note(jobMessage, error || (job?.status === 'running' ? ui.text('message030') : job?.status === 'succeeded' ? ui.text('message031') : job?.status === 'ready' ? ui.text('message032') : ''), job?.status === 'failed' || job?.durability === 'memory' || job?.durability === 'unverified');
      ui.update({ hasJobRecord: Boolean(job?.id || state.requestId), jobMetaText: job ? ui.text('message033', { v0: job.id, v1: job.requestId ? ui.text('message034') + job.requestId : '' }) : state.requestId ? ui.text('message035', { v0: state.requestId }) : '', hideCancel: !activeJob(job), hideQuery: !state.requestId && !job?.id,
        hideSave: job?.status !== 'ready', hideOpenImage: !file, hideUncertainty: !state.unresolved && job?.status !== 'unknown' });
      ui.setOptions(jobsSelect, [...state.jobs].reverse().map(entry => ({ value: entry.id, label: `${jobLabels(entry.status)} · ${entry.name || entry.id}` })));
      if (job?.id) jobsSelect.value = job.id; ui.update({ hideJobsSelect: state.jobs.length < 2 }); updateElapsed(); sync();
    }
    function updateElapsed() {
      const job = state.job; if (!job?.createdAt) { ui.update({ elapsedText: '' }); return; }
      const start = Date.parse(job.createdAt);
      if (activeJob(job) && Number.isFinite(start)) { const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000)); ui.update({ elapsedText: ui.text('message036', { v0: Math.floor(seconds / 60), v1: seconds % 60 }) }); }
      else ui.update({ elapsedText: Number.isFinite(start) ? ui.text('message037', { v0: new Date(start).toLocaleString() }) : '' });
    }
    function acceptJob(job) {
      if (!job || typeof job.id !== 'string') return;
      state.job = job; state.unresolved = false;
      const index = state.jobs.findIndex(item => item.id === job.id); if (index >= 0) state.jobs[index] = job; else state.jobs.push(job);
      if (terminal(job) && job.status !== 'unknown') savePending(null); else if (job.requestId) savePending(job.requestId);
      renderJob();
    }
    async function queryPending() {
      const parameters = state.requestId ? { requestId: state.requestId } : state.job?.id ? { jobId: state.job.id } : null;
      if (!parameters) return;
      const response = await ctx.api('/api/fwv/generation/jobs?' + new URLSearchParams(parameters), { signal: abort.signal }); if (state.disposed) return;
      if (response.job) {
        const recovered = state.unresolved && response.job.status !== 'unknown';
        acceptJob(response.job);
        if (recovered) { note(generationStatus, ''); ctx.notify('', false); }
        if (response.job.assetId) await refreshSnapshot();
      }
      else { state.unresolved = true; renderJob(); }
      return response.job || null;
    }
    async function poll() {
      if (state.disposed || state.polling || state.busy) return;
      if (!activeJob(state.job) && !state.unresolved) return;
      state.polling = true;
      try { await queryPending(); } catch (error) { if (!state.disposed) note(jobMessage, ui.text('message038', { v0: error.message }), true); }
      finally { state.polling = false; }
    }
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!form.reportValidity() || !name.value.trim() || !prompt.value.trim() || generate.disabled) return;
      void run(async () => {
        const requestId = crypto.randomUUID(); savePending(requestId); state.unresolved = true; state.job = null; saveDraft(); renderJob();
        const payload = { requestId, name: name.value.trim(), prompt: prompt.value.trim(), size: size.value, quality: quality.value, background: state.provider.protocol === 'openai-compatible' ? 'auto' : background.value };
        if (state.referenceAssetId) {
          const asset = state.snapshot.assets.find(item => item.id === state.referenceAssetId), revision = asset?.revisions.find(item => item.id === state.referenceRevisionId), file = imageFile(revision);
          if (!file) { savePending(null); state.unresolved = false; throw new Error(ui.text('message039')); }
          payload.reference = { assetId: asset.id, revisionId: revision.id, fileName: file.name };
        }
        note(generationStatus, ui.text('message040'));
        try {
          const response = await ctx.command('generation.start', payload); acceptJob(response?.job || response);
          note(generationStatus, ui.text('message041'));
          if (state.job?.assetId) await refreshSnapshot();
        } catch (error) {
          // A lost HTTP response does not establish whether the provider ran. Keep
          // the same request ID for a read-only lookup; never resend automatically.
          note(generationStatus, ui.text('message042', { v0: error.message }), true);
          state.unresolved = true; renderJob();
          try {
            const found = await queryPending();
            if (!found && error.status >= 400 && error.status < 500) {
              savePending(null); state.unresolved = false; renderJob(); note(generationStatus, ui.text('message043', { v0: error.message }), true);
            }
          } catch {}
        }
      });
    });
    async function initialize() {
      try {
        await loadProvider(); const response = await ctx.api('/api/fwv/generation/jobs', { signal: abort.signal }); if (state.disposed) return;
        state.jobs = Array.isArray(response.jobs) ? response.jobs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : []; state.connected = true;
        if (state.requestId) await queryPending();
        else { const latest = [...state.jobs].reverse().find(job => ['queued', 'running', 'ready', 'unknown'].includes(job.status)) || state.jobs.at(-1); if (latest) acceptJob(latest); }
        if (state.job?.assetId) await refreshSnapshot();
        renderReferences(); renderJob(); sync();
      } catch (error) { if (!state.disposed) note(providerStatus, ui.text('message044', { v0: error.message }), true); }
    }
    renderReferences(); renderJob(); sync(); void initialize();
    state.pollTimer = setInterval(() => { if (state.disposed) return; updateElapsed(); void poll(); }, 1500);
    return () => { state.disposed = true; apiKey.value = ''; clearInterval(state.pollTimer); abort.abort(); ui.dispose(); root.remove(); };
  } });
}());
