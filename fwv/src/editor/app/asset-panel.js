(function () {
  'use strict';
  const imageFile = revision => revision?.files?.find(file => file.role === 'image')
    || revision?.files?.find(file => /^image\/(png|jpeg|webp)$/.test(file.mime || ''));
  const artifactUrl = (assetId, revisionId, fileName) => '/api/fwv/artifact?' + new URLSearchParams({ assetId, revisionId, fileName });
  const activeGeneration = status => ['queued', 'running', 'ready', 'unknown'].includes(status);
  const regionKeys = ['x', 'y', 'width', 'height'];
  const shortId = value => String(value || '').replace(/^rev_/, '').slice(0, 8);
  const requestTitle = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 72);
  (window.FwvPanels ||= []).push({ id: 'assets', mount(host, ctx) {
    const ui = ctx.createSurface('assets'), t = (key, vars) => ui.text(key, vars), root = ui.root, refs = ui.refs;
    host.append(root);
    // Bitmap dimensions belong to the professional viewport. Reapplying width
    // or height as surface state would clear a canvas during ordinary UI updates.
    for (const canvas of [refs.sourceCanvas, refs.candidateCanvas]) { canvas.width = 640; canvas.height = 480; }
    const state = { assetId: ctx.selection.assetId || '', revisionId: ctx.selection.revisionId || '', changeId: '', candidateId: '',
      changes: [], sourceImage: null, candidateImage: null, region: null, disposed: false, paintToken: 0, loading: false,
      zoom: 1, backdrop: 'checker', drag: null, generation: null, provider: null, timer: null, reviewCandidateId: null, spineRepair: null,
      titleEdited: false, editing: false, generationRequestId: '' };
    let spineRepair;
    const abort = new AbortController();
    const resize = new ResizeObserver(() => {
      if (state.disposed) return;
      const ratio = window.devicePixelRatio || 1;
      for (const canvas of [refs.sourceCanvas, refs.candidateCanvas]) {
        const bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height) continue;
        const width = Math.max(1, Math.round(bounds.width * ratio)), height = Math.max(1, Math.round(bounds.height * ratio));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      }
      draw();
    });
    resize.observe(refs.sourceCanvas); resize.observe(refs.candidateCanvas);
    const asset = () => ctx.getSnapshot().assets.find(item => item.id === state.assetId);
    const revision = () => asset()?.revisions.find(item => item.id === state.revisionId);
    const currentChange = () => state.changes.find(item => item.id === state.changeId);
    const currentCandidate = () => currentChange()?.candidates?.find(item => item.id === state.candidateId);
    const draftId = () => `${state.assetId}:${state.revisionId}`;
    const modeKey = 'fwv-execution-mode:' + ctx.getSession().projectId;
    function preferredMode() { try { return localStorage.getItem(modeKey) === 'api' ? 'api' : 'local'; } catch { return 'local'; } }
    const reviewName = decision => t(decision === 'accepted' ? 'acceptedLabel' : decision === 'rejected' ? 'rejectedLabel' : 'pending');
    const validationName = report => t(report?.status === 'passed' ? 'validationPassed' : report?.status === 'failed' ? 'validationFailed' : 'validationPending');
    const imageDimensions = () => ({ width: revision()?.metadata?.image?.width || state.sourceImage?.naturalWidth || 0,
      height: revision()?.metadata?.image?.height || state.sourceImage?.naturalHeight || 0 });
    const run = fn => async () => {
      if (state.disposed || state.loading) return;
      state.loading = true; sync();
      try { await fn(); } catch (error) { if (!state.disposed) ctx.notify(error.message, true); }
      finally { state.loading = false; if (!state.disposed) sync(); }
    };
    const click = (ref, fn) => refs[ref].addEventListener('click', run(fn));
    refs.importButton.addEventListener('click', () => ctx.importAssets());
    click('refreshButton', async () => { await ctx.refresh(); await loadChanges(); chooseSource(state.assetId, state.revisionId); });
    function readDraft() {
      return { assetId: state.assetId, revisionId: state.revisionId, title: refs.title.value, request: refs.request.value,
        preserve: refs.preserve.value, ...(state.region ? { region: structuredClone(state.region) } : {}),
        objects: refs.objects.value, animationName: refs.animationName.value, time: Number(refs.time.value || 0),
        changeId: state.changeId, candidateId: state.candidateId, executionMode: refs.mode.value || 'local',
        ...(state.spineRepair ? { spineRepair: structuredClone(state.spineRepair) } : {}) };
    }
    function saveDraft({ detach = false } = {}) {
      if (!state.assetId || !state.revisionId || state.disposed) return;
      if (detach && state.changeId) {
        state.changeId = ''; state.candidateId = ''; state.candidateImage = null;
        refs.handoff.value = ''; ui.update({ hasHandoff: false }); ctx.notify(t('draftChanged'));
        draw();
      }
      if (detach) state.generationRequestId = '';
      ctx.drafts.set('changeDrafts', draftId(), readDraft()); sync();
    }
    function applyDraft(draft = {}) {
      for (const key of ['title', 'request', 'preserve', 'objects', 'animationName']) refs[key].value = draft[key] || '';
      state.titleEdited = Boolean(draft.title && draft.title !== requestTitle(draft.request));
      if (!refs.title.value) refs.title.value = requestTitle(refs.request.value);
      refs.time.value = draft.time ?? 0; refs.mode.value = draft.executionMode || preferredMode();
      state.region = draft.region ? structuredClone(draft.region) : null;
      state.changeId = draft.changeId || ''; state.candidateId = draft.candidateId || '';
      state.spineRepair = draft.spineRepair || null;
      state.editing = false; state.generationRequestId = '';
      refs.handoff.value = ''; ui.update({ hasHandoff: false }); updateRegionControls();
    }
    function updateRegionControls() {
      for (const key of regionKeys) refs['region' + key[0].toUpperCase() + key.slice(1)].value = state.region?.[key] ?? '';
      ui.update({ regionHint: state.region ? t('regionHint', state.region) : t('noRegion') });
    }
    function chooseSource(assetId, revisionId, { restore = true } = {}) {
      const selected = ctx.getSnapshot().assets.find(item => item.id === assetId) || ctx.getSnapshot().assets[0];
      state.assetId = selected?.id || '';
      state.revisionId = selected?.revisions.find(item => item.id === revisionId)?.id || selected?.selectedRevisionId || selected?.revisions.at(-1)?.id || '';
      if (restore) applyDraft(ctx.drafts.get('changeDrafts', draftId()) || {});
      ctx.setSelection({ assetId: state.assetId, revisionId: state.revisionId });
      ui.setOptions(refs.asset, ctx.getSnapshot().assets.map(item => ({ value: item.id, label: item.name })), state.assetId);
      updateRevisionOptions();
      refreshAttachOptions(); sync(); void loadPreview();
    }
    function updateRevisionOptions() {
      const selected = asset();
      ui.setOptions(refs.revision, (selected?.revisions || []).map((item, index) => ({ value: item.id,
        label: t('sourceVersion', { index: index + 1, selected: item.id === selected.selectedRevisionId ? t('selectedVersion') : '', id: shortId(item.id) }) })), state.revisionId);
    }
    function refreshAttachOptions() {
      const previous = refs.attachAsset.value;
      const assets = ctx.getSnapshot().assets.filter(item => item.kind === asset()?.kind);
      ui.setOptions(refs.attachAsset, assets.map(item => ({ value: item.id, label: item.name })), assets.some(item => item.id === previous) ? previous : assets.find(item => item.id !== state.assetId)?.id || assets[0]?.id);
      refreshAttachRevisions();
    }
    function refreshAttachRevisions() {
      const item = ctx.getSnapshot().assets.find(item => item.id === refs.attachAsset.value), previous = refs.attachRevision.value;
      ui.setOptions(refs.attachRevision, (item?.revisions || []).map((rev, index) => ({ value: rev.id, label: t('sourceVersion', { index: index + 1, selected: '', id: rev.id }) })),
        item?.revisions.some(rev => rev.id === previous) ? previous : item?.selectedRevisionId);
    }
    function sync() {
      if (state.disposed) return;
      const change = currentChange(), candidates = change?.candidates || [];
      if (change && !candidates.some(item => item.id === state.candidateId)) state.candidateId = candidates.at(-1)?.id || '';
      const candidate = currentCandidate(), dimensions = imageDimensions();
      if (state.reviewCandidateId !== (candidate?.id || null)) {
        state.reviewCandidateId = candidate?.id || null; refs.comment.value = candidate?.review?.comment || '';
      }
      const changes = state.changes.filter(item => item.source?.assetId === state.assetId && item.source?.revisionId === state.revisionId);
      ui.setOptions(refs.changes, [{ value: '', label: t('newChange') }, ...changes.map(item => ({ value: item.id, label: item.title }))], state.changeId);
      ui.setOptions(refs.candidates, candidates.length ? candidates.map(item => ({ value: item.id, label: t('candidateLabel', { name: item.name || item.assetId, review: reviewName(item.review?.decision), id: shortId(item.revisionId) }) })) : [{ value: '', label: t('noCandidate') }], state.candidateId);
      const generation = change?.generations?.at(-1); state.generation = generation;
      const imageSource = asset()?.kind === 'image', apiMode = imageSource && refs.mode.value === 'api';
      const providerReady = Boolean(state.provider?.canGenerate ?? state.provider?.keyConfigured);
      const canGenerate = imageSource && providerReady && !activeGeneration(generation?.status);
      const apiWaiting = !providerReady ? 'configureHint' : ['queued', 'running'].includes(generation?.status) ? 'waitingApi'
        : ['ready', 'succeeded'].includes(generation?.status) ? 'readyApi' : generation?.status === 'unknown' ? 'unknownApi' : 'idleApi';
      ui.update({ hasSource: Boolean(revision()), imageSource: asset()?.kind === 'image', spineSource: asset()?.kind === 'spine', modelSource: asset()?.kind === 'model3d',
        bitmapPreview: !['spine', 'model3d'].includes(asset()?.kind), hasChange: Boolean(change), hasCandidate: Boolean(candidate),
        working: state.loading, phase: state.loading ? 'busy' : candidate ? 'result' : 'edit', previewColumns: candidate ? 2 : 1,
        showPrompt: Boolean(revision() && !candidate && (!change || state.editing)), waiting: Boolean(change && !candidate && !state.editing),
        primaryLabel: t(!imageSource ? 'spinePrimary' : apiMode ? providerReady ? 'apiPrimary' : 'configurePrimary' : 'localPrimary'),
        executionHint: t(!imageSource ? 'spineHint' : apiMode ? providerReady ? 'apiHint' : 'configureHint' : 'localHint'),
        promptHint: t(imageSource ? 'promptImage' : asset()?.kind === 'spine' ? 'promptSpine' : 'promptModel'),
        waitingHint: t(!imageSource ? 'waitingSpine' : apiMode ? apiWaiting : 'waitingLocal'), needsProvider: apiMode && !providerReady,
        useLabel: t(state.loading ? 'using' : change?.adoptedCandidateId ? 'used' : 'use'),
        canUse: Boolean(candidate && candidate.review?.decision !== 'rejected' && candidate.validation?.status === 'passed' && !change?.adoptedCandidateId && !state.loading),
        rejected: candidate?.review?.decision === 'rejected',
        canReview: Boolean(candidate && !change.adoptedCandidateId), canAdopt: Boolean(candidate?.review?.decision === 'accepted' && candidate.validation?.status === 'passed' && !change?.adoptedCandidateId),
        adopted: Boolean(change?.adoptedCandidateId), apiMode, canGenerate: Boolean(canGenerate),
        canRecover: ['ready', 'succeeded'].includes(generation?.status),
        generationInfo: generation ? t('generationInfo', { id: generation.jobId, status: generation.status, error: generation.error ? `: ${typeof generation.error === 'string' ? generation.error : generation.error.message || ''}` : '' }) : '',
        sourceInfo: revision() ? t(['spine', 'model3d'].includes(asset()?.kind) ? 'structuredSourceInfo' : 'sourceInfo',
          { name: asset().name, revision: shortId(state.revisionId), kind: asset().kind === 'spine' ? 'Spine 4.2' : 'GLB', ...dimensions }) : '',
        requestSelection: change ? t('requestSelection', { title: change.title }) : '',
        candidateInfo: candidate ? t('candidateInfo', { revision: shortId(candidate.revisionId), validation: validationName(candidate.validation), review: reviewName(candidate.review?.decision) }) : t('noCandidate'),
        scopeInfo: candidate?.scope?.mode === 'preserve-outside' ? t('scopeLocked', candidate.scope.normalization) : '',
        regionHint: state.region ? t('regionHint', state.region) : t('noRegion') });
      spineRepair?.update();
    }
    function applyChange(change, { selectLast = false } = {}) {
      const index = state.changes.findIndex(item => item.id === change.id);
      if (index >= 0) state.changes[index] = change; else state.changes.push(change);
      state.changeId = change.id;
      if (selectLast) state.candidateId = change.candidates?.at(-1)?.id || '';
      saveDraft(); updateRevisionOptions(); refreshAttachOptions(); sync(); void loadPreview();
    }
    async function loadChanges() {
      const result = await ctx.api('/api/fwv/changes', { signal: abort.signal });
      if (state.disposed) return;
      state.changes = result.changes || []; sync();
    }
    async function loadImage(reference) {
      const file = imageFile(reference); if (!file) return null;
      const image = new Image(); image.decoding = 'async';
      return new Promise((resolve, reject) => { image.onload = () => resolve(image); image.onerror = () => reject(new Error(t('readError')));
        image.src = artifactUrl(reference.assetId, reference.revisionId, file.name); });
    }
    async function loadPreview() {
      const token = ++state.paintToken, rev = revision(), candidate = currentCandidate();
      state.sourceImage = null; state.candidateImage = null; draw();
      if (['spine', 'model3d'].includes(asset()?.kind)) return;
      const candidateAsset = ctx.getSnapshot().assets.find(item => item.id === candidate?.assetId);
      const candidateRevision = candidateAsset?.revisions.find(item => item.id === candidate?.revisionId);
      try {
        const [sourceImage, candidateImage] = await Promise.all([
          rev ? loadImage({ ...rev, assetId: state.assetId, revisionId: state.revisionId }) : null,
          candidateRevision ? loadImage({ ...candidateRevision, assetId: candidate.assetId, revisionId: candidate.revisionId }) : null
        ]);
        if (state.disposed || token !== state.paintToken) return;
        state.sourceImage = sourceImage; state.candidateImage = candidateImage;
        ui.update({ previewHint: sourceImage ? '' : t('noImage') }); draw(); sync();
      } catch (error) { if (!state.disposed && token === state.paintToken) ctx.notify(error.message, true); }
    }
    function transform(canvas) {
      const dimensions = imageDimensions(), width = dimensions.width || 1, height = dimensions.height || 1;
      const comparing = Boolean(currentCandidate());
      const viewportWidth = comparing ? Math.min(refs.sourceCanvas.width, refs.candidateCanvas.width) : refs.sourceCanvas.width;
      const viewportHeight = comparing ? Math.min(refs.sourceCanvas.height, refs.candidateCanvas.height) : refs.sourceCanvas.height;
      const scale = Math.min((viewportWidth - 32) / width, (viewportHeight - 32) / height) * state.zoom;
      return { scale, x: (canvas.width - width * scale) / 2, y: (canvas.height - height * scale) / 2 };
    }
    function drawCanvas(canvas, image) {
      const context = canvas.getContext('2d');
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (state.backdrop === 'checker') {
        for (let y = 0; y < canvas.height; y += 16) for (let x = 0; x < canvas.width; x += 16) {
          context.fillStyle = (x / 16 + y / 16) % 2 ? '#ccd2d5' : '#e6eaec'; context.fillRect(x, y, 16, 16);
        }
      } else { context.fillStyle = state.backdrop === 'dark' ? '#20262e' : '#f7f8fa'; context.fillRect(0, 0, canvas.width, canvas.height); }
      const view = transform(canvas);
      if (image) { context.imageSmoothingEnabled = state.zoom < 4; context.drawImage(image, view.x, view.y, image.naturalWidth * view.scale, image.naturalHeight * view.scale); }
      if (state.region) {
        const { x, y, width, height } = state.region;
        context.fillStyle = '#21a3ba22'; context.strokeStyle = '#13899d'; context.lineWidth = 3;
        context.fillRect(view.x + x * view.scale, view.y + y * view.scale, width * view.scale, height * view.scale);
        context.strokeRect(view.x + x * view.scale, view.y + y * view.scale, width * view.scale, height * view.scale);
      }
    }
    function draw() { if (!state.disposed) { drawCanvas(refs.sourceCanvas, state.sourceImage); drawCanvas(refs.candidateCanvas, state.candidateImage); } }
    function pointerPosition(event) {
      const canvas = refs.sourceCanvas, bounds = canvas.getBoundingClientRect(), view = transform(canvas), dimensions = imageDimensions();
      return { x: Math.round(Math.max(0, Math.min(dimensions.width, ((event.clientX - bounds.left) * canvas.width / bounds.width - view.x) / view.scale))),
        y: Math.round(Math.max(0, Math.min(dimensions.height, ((event.clientY - bounds.top) * canvas.height / bounds.height - view.y) / view.scale))) };
    }
    refs.sourceCanvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !state.sourceImage) return;
      event.preventDefault(); state.drag = { start: pointerPosition(event), previous: state.region };
      refs.sourceCanvas.setPointerCapture(event.pointerId);
    });
    refs.sourceCanvas.addEventListener('pointermove', event => {
      if (!state.drag) return; const point = pointerPosition(event), start = state.drag.start;
      state.region = { x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) }; draw();
    });
    refs.sourceCanvas.addEventListener('pointerup', event => {
      if (!state.drag) return;
      if (!state.region?.width || !state.region?.height) state.region = state.drag.previous;
      state.drag = null; refs.sourceCanvas.releasePointerCapture(event.pointerId); updateRegionControls(); saveDraft({ detach: true }); draw();
    });
    refs.sourceCanvas.addEventListener('pointercancel', () => { if (state.drag) { state.region = state.drag.previous; state.drag = null; draw(); } });
    refs.zoom.addEventListener('change', () => { state.zoom = Number(refs.zoom.value); draw(); });
    refs.backdrop.addEventListener('change', () => { state.backdrop = refs.backdrop.value; draw(); });
    click('clearRegion', () => { state.region = null; updateRegionControls(); saveDraft({ detach: true }); draw(); });
    refs.title.addEventListener('input', () => { state.titleEdited = Boolean(refs.title.value.trim()); saveDraft({ detach: true }); });
    refs.request.addEventListener('input', () => { if (!state.titleEdited) refs.title.value = requestTitle(refs.request.value); saveDraft({ detach: true }); });
    for (const key of ['preserve', 'objects', 'animationName', 'time']) refs[key].addEventListener('input', () => saveDraft({ detach: true }));
    for (const key of regionKeys) refs['region' + key[0].toUpperCase() + key.slice(1)].addEventListener('input', () => {
      state.region = Object.fromEntries(regionKeys.map(name => [name, Number(refs['region' + name[0].toUpperCase() + name.slice(1)].value || 0)]));
      saveDraft({ detach: true }); draw();
    });
    refs.mode.addEventListener('change', () => { try { localStorage.setItem(modeKey, refs.mode.value); } catch {} saveDraft(); });
    refs.asset.addEventListener('change', () => { saveDraft(); chooseSource(refs.asset.value, ''); });
    refs.revision.addEventListener('change', () => { saveDraft(); chooseSource(state.assetId, refs.revision.value); });
    refs.changes.addEventListener('change', () => {
      const change = state.changes.find(item => item.id === refs.changes.value);
      if (!change) { state.changeId = ''; state.candidateId = ''; saveDraft(); void loadPreview(); return; }
      const anchors = change.anchors || {};
      applyDraft({ title: change.title, request: change.request, preserve: change.preserve, region: anchors.region,
        objects: (anchors.objects || []).join(', '), animationName: anchors.animation?.name || '', time: anchors.animation?.time || 0,
        changeId: change.id, candidateId: change.candidates?.at(-1)?.id || '', executionMode: refs.mode.value });
      saveDraft(); void loadPreview();
    });
    refs.candidates.addEventListener('change', () => { state.candidateId = refs.candidates.value; saveDraft(); void loadPreview(); });
    refs.attachAsset.addEventListener('change', refreshAttachRevisions);
    async function ensureChange() {
        if (currentChange()) return currentChange();
        if (!refs.request.value.trim()) throw new Error(t('needIssue'));
        refs.title.value = refs.title.value.trim() || requestTitle(refs.request.value);
        if (state.region) { const { width, height } = imageDimensions(), region = state.region;
          if (!(region.width > 0 && region.height > 0 && region.x >= 0 && region.y >= 0 && region.x + region.width <= width && region.y + region.height <= height)) throw new Error(t('invalidRegion')); }
        const anchors = { ...(state.region ? { region: state.region } : {}),
          objects: refs.objects.value.split(/[,\n]/).map(item => item.trim()).filter(Boolean),
          ...(refs.animationName.value.trim() ? { animation: { name: refs.animationName.value.trim(), time: Number(refs.time.value || 0) } } : {}),
          view: { zoom: state.zoom, background: state.backdrop, coordinateSpace: 'source-pixels' } };
        const change = await ctx.command('change.create', { sourceAssetId: state.assetId, sourceRevisionId: state.revisionId,
          title: refs.title.value.trim(), request: refs.request.value.trim(), preserve: refs.preserve.value.trim(), anchors });
        state.editing = false; applyChange(change); return change;
    }
    async function prepare() { const result = await ctx.command('change.prepare', { changeId: state.changeId });
      refs.handoff.value = [result.prompt, '', t('sourceFiles'), ...(result.sourceFiles || []).map(file => `${file.path} (SHA-256: ${file.sha256})`)].join('\n');
      ui.update({ hasHandoff: true }); ctx.notify(t('prepared')); }
    async function generate() {
      state.generationRequestId ||= crypto.randomUUID();
      const change = await ctx.command('change.candidate.generate', { changeId: state.changeId,
        requestId: state.generationRequestId, size: '1024x1024', quality: 'auto', background: 'auto' });
      state.generationRequestId = ''; applyChange(change); ctx.notify(t('generated'));
    }
    refs.requestForm.addEventListener('submit', event => {
      event.preventDefault(); if (!refs.requestForm.reportValidity()) return;
      void run(async () => {
        if (asset()?.kind === 'image' && refs.mode.value === 'api' && !(state.provider?.canGenerate ?? state.provider?.keyConfigured)) {
          saveDraft(); ctx.navigate('generate'); return;
        }
        await ensureChange();
        if (asset()?.kind === 'image') { if (refs.mode.value === 'api') await generate(); else await prepare(); }
        else ctx.notify(t('issueCreated'));
      })();
    });
    click('prepare', prepare);
    click('copy', async () => { try { await navigator.clipboard.writeText(refs.handoff.value); ctx.notify(t('copied')); }
      catch { refs.handoff.focus(); refs.handoff.select(); ctx.notify(t('copyFailed')); } });
    click('generate', generate);
    click('recover', async () => { const change = await ctx.command('change.candidate.recover', { changeId: state.changeId, jobId: state.generation.jobId }); applyChange(change, { selectLast: true }); ctx.notify(t('importedCandidate')); });
    click('attach', async () => { const change = await ctx.command('change.candidate.attach', { changeId: state.changeId,
      assetId: refs.attachAsset.value, revisionId: refs.attachRevision.value }); applyChange(change, { selectLast: true }); ctx.notify(t('importedCandidate')); });
    refs.importCandidate.addEventListener('click', () => refs.candidateFile.click());
    refs.importAnother.addEventListener('click', () => refs.candidateFile.click());
    refs.candidateFile.addEventListener('change', () => {
      const file = refs.candidateFile.files[0]; refs.candidateFile.value = ''; if (!file) return;
      void run(async () => {
        if (!/\.(png|jpe?g|webp)$/i.test(file.name) || !file.size || file.size > 20 * 1024 * 1024) throw new Error(t('invalidImage'));
        const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error(t('readError'))); reader.readAsDataURL(file); });
        const imported = await ctx.command('image.import', { name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, base64 });
        const change = await ctx.command('change.candidate.attach', { changeId: state.changeId, assetId: imported.id, revisionId: imported.selectedRevisionId });
        applyChange(change, { selectLast: true }); ctx.notify(t('importedCandidate'));
      })();
    });
    click('validate', async () => applyChange(await ctx.command('change.candidate.validate', { changeId: state.changeId, candidateId: state.candidateId })));
    for (const [ref, decision] of [['accept', 'accepted'], ['reject', 'rejected']]) click(ref, async () => {
      applyChange(await ctx.command('change.review', { changeId: state.changeId, candidateId: state.candidateId, decision, comment: refs.comment.value })); ctx.notify(t(decision));
    });
    click('adopt', async () => { applyChange(await ctx.command('change.adopt', { changeId: state.changeId, candidateId: state.candidateId })); ctx.notify(t('adopted')); });
    click('use', async () => {
      const selectedChange = currentChange(), candidate = currentCandidate();
      if (!candidate || selectedChange.adoptedCandidateId || candidate.review?.decision === 'rejected' || candidate.validation?.status !== 'passed') return;
      const changeId = selectedChange.id, candidateId = candidate.id, expectedReview = structuredClone(candidate.review);
      const expectedAdoption = structuredClone(selectedChange.adoption ?? null), comment = refs.comment.value;
      try {
        if (expectedReview.decision !== 'accepted') {
          applyChange(await ctx.command('change.review', { changeId, candidateId, decision: 'accepted', comment, expectedReview }));
        }
        applyChange(await ctx.command('change.adopt', { changeId, candidateId, expectedAdoption })); ctx.notify(t('adopted'));
      } catch (error) {
        let refreshed = false;
        await ctx.refresh().catch(() => {});
        try { await loadChanges(); refreshed = true; } catch {}
        if (!state.disposed) {
          sync(); updateRevisionOptions(); void loadPreview();
          const latest = state.changes.find(item => item.id === changeId), reviewed = latest?.candidates?.find(item => item.id === candidateId);
          if (refreshed && latest?.adoptedCandidateId === candidateId) ctx.notify(t('adopted'));
          else ctx.notify(t(refreshed && reviewed?.review?.decision === 'accepted' ? 'acceptedNotAdopted' : 'useFailed', { message: error.message }), true);
        }
      }
    });
    function focusRequest() { requestAnimationFrame(() => { if (!state.disposed) { refs.request.focus(); refs.request.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }); }
    click('editPrompt', () => { state.editing = true; sync(); focusRequest(); });
    click('continue', async () => {
      const adopted = currentChange()?.adoption;
      if (adopted?.revisionId) {
        await ctx.refresh();
        if (!ctx.getSnapshot().assets.find(item => item.id === state.assetId)?.revisions.some(item => item.id === adopted.revisionId)) throw new Error(t('continueUnavailable'));
      }
      saveDraft();
      if (adopted?.revisionId) chooseSource(state.assetId, adopted.revisionId);
      state.changeId = ''; state.candidateId = ''; state.candidateImage = null; state.titleEdited = false; state.editing = true;
      refs.title.value = ''; refs.request.value = ''; refs.handoff.value = ''; ui.update({ hasHandoff: false });
      saveDraft(); sync(); void loadPreview(); focusRequest(); ctx.notify(t(adopted ? 'continueAdopted' : 'continueOriginal'));
    });
    for (const [ref, panel] of [['imageTool', 'images'], ['rigTool', 'rig'], ['spineTool', 'spine'], ['reskinTool', 'reskin'], ['provider', 'generate'], ['waitingProvider', 'generate'], ['modelTool', 'model3d'], ['modelImportTool', 'model3d']]) click(ref, () => {
      saveDraft(); ctx.navigate(panel, panel === 'rig' && asset()?.kind === 'image' ? { sourceAssetId: state.assetId, sourceRevisionId: state.revisionId }
        : { assetId: state.assetId, revisionId: state.revisionId, changeId: state.changeId });
    });
    chooseSource(state.assetId, state.revisionId);
    state.changeId = ctx.selection.changeId || state.changeId;
    state.candidateId = ctx.selection.candidateId || state.candidateId;
    if (window.FwvSpineRepair) spineRepair = window.FwvSpineRepair.mount(refs.spineRepair, { ...ctx,
      getSource: () => ({ asset: asset(), revision: revision() }), getChange: currentChange, getCandidate: currentCandidate,
      ensureChange,
      readDraft: () => state.spineRepair, writeDraft: value => { state.spineRepair = value; saveDraft(); },
      onCandidate: change => applyChange(change, { selectLast: true }),
      onAnchor: value => {
        refs.objects.value = value.boneName || ''; refs.animationName.value = value.animation || ''; refs.time.value = value.time || 0;
        saveDraft({ detach: true });
      } });
    spineRepair?.update();
    void Promise.all([loadChanges(), ctx.api('/api/fwv/provider', { signal: abort.signal })]).then(([, provider]) => {
      if (state.disposed) return; state.provider = provider; sync(); void loadPreview();
    }).catch(error => { if (!state.disposed) ctx.notify(error.message, true); });
    async function poll() {
      if (state.disposed) return;
      try { if (activeGeneration(state.generation?.status)) await loadChanges(); }
      catch (error) { if (!state.disposed) ctx.notify(error.message, true); }
      finally { if (!state.disposed) state.timer = setTimeout(poll, 2500); }
    }
    state.timer = setTimeout(poll, 2500);
    return () => { state.disposed = true; state.paintToken++; clearTimeout(state.timer); resize.disconnect(); abort.abort(); spineRepair?.dispose(); ui.dispose(); };
  } });
}());
