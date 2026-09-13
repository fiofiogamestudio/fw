(function () {
  (window.FwvPanels ||= []).push({ id: 'model3d', mount(host, ctx) {
    const surface = ctx.createSurface('model3d', { data: { blocked: true, reviewBlocked: true, adoptBlocked: true, previewColumns: 1, hasCandidate: false, editing: true, handoffOpen: false, phase: 'edit', summary: '', status: '', tone: 'muted' } });
    const root = surface.root, r = surface.refs, t = surface.text; host.append(root);
    let data, asset, revision, summary, change, changes = [], candidate, preview, controller, disposed = false, busy = false, serial = 0, playing = false, editing = true;
    let assetId = ctx.selection?.assetId, revisionId = ctx.selection?.revisionId, changeId = ctx.selection?.changeId;
    const notify = (status, error = false) => { if (!disposed) surface.update({ status, tone: error ? 'danger' : 'muted' }); };
    const options = (ref, entries, value) => surface.setOptions(ref, entries, value ?? entries[0]?.value ?? '');
    const source = () => ({ assetId: asset.id, revisionId: revision.id, files: revision.files });
    function updateState() {
      const adopted = Boolean(change?.adoptedCandidateId), rejected = candidate?.review.decision === 'rejected';
      surface.update({ hasModel: Boolean(asset), blocked: busy || !asset, reviewBlocked: busy || !candidate || adopted,
        adoptBlocked: busy || !candidate || rejected || adopted, hasCandidate: Boolean(candidate), previewColumns: candidate ? 2 : 1,
        editing, phase: busy ? 'busy' : candidate ? 'result' : 'edit', sourceLabel: t(candidate ? 'sourceLabel' : 'currentSourceLabel'),
        decisionInfo: adopted ? t('adopted') : rejected ? t('rejected') : candidate?.review.decision === 'accepted' ? t('accepted') : '' });
    }
    const act = fn => async () => { if (busy || disposed) return; busy = true; updateState(); try { await fn(); } catch (error) { notify(error.message, true); } finally { busy = false; if (!disposed) updateState(); } };
    const on = (ref, fn, event = 'click') => r[ref].addEventListener(event, act(fn));
    function vector(ref, length) { const values = r[ref].value.split(',').map(v => v.trim()); const numbers = values.map(Number); if (values.length !== length || values.some(v => v === '') || numbers.some(n => !Number.isFinite(n))) throw new Error(t('invalidVector', { count: length })); return numbers; }
    function stop() { controller?.abort(); controller = null; preview?.dispose(); preview = null; playing = false; }
    async function renderPreview() {
      const previousView = preview?.conditions() || change?.anchors?.view;
      stop(); if (!asset || disposed) return;
      const token = ++serial; controller = new AbortController();
      try {
        const value = await window.FwvModelPreview.create(candidate ? [r.sourceCanvas, r.candidateCanvas] : [r.sourceCanvas], candidate ? [source(), candidate] : [source()], { signal: controller.signal,
          onTime: time => { if (!disposed && token === serial && document.activeElement !== r.time) r.time.value = time.toFixed(2); } });
        if (disposed || token !== serial) { value.dispose(); return; } preview = value;
        preview.animation(Number(r.animation.value)); preview.seek(Number(r.time.value)); preview.setView(previousView); preview.skeleton(r.skeleton.checked); preview.wireframe(r.wireframe.checked);
      } catch (error) { if (!disposed && token === serial && error.name !== 'AbortError') notify(error.message, true); }
    }
    function showBone() {
      const bone = summary?.nodes.find(n => n.index === Number(r.bone.value));
      r.translation.value = (bone?.translation || [0, 0, 0]).join(', '); r.rotation.value = (bone?.rotation || [0, 0, 0, 1]).join(', '); r.scale.value = (bone?.scale || [1, 1, 1]).join(', ');
    }
    function showTexture() { const hasTexture = Boolean(summary?.images.length); surface.update({ hasTexture, textureUrl: hasTexture ? '/api/fwv/model?' + new URLSearchParams({ assetId, revisionId, view: 'texture', imageIndex: r.texture.value }) : '' }); }
    const revisionLabel = (item, index, selectedId) => t('version', { number: index + 1, current: item.id === selectedId ? t('current') : '' });
    function imageVersions() { const image = data?.assets.find(a => a.id === r.image.value); options(r.imageRevision, (image?.revisions || []).map((v, i) => ({ value: v.id, label: revisionLabel(v, i, image.selectedRevisionId) })), image?.selectedRevisionId); }
    async function showChange(selectedCandidateId) {
      change = changes.find(c => c.id === r.changes.value) || null; changeId = change?.id; ctx.setSelection({ assetId, revisionId, changeId: changeId || '' });
      const entries = change?.candidates || []; options(r.candidates, entries.length ? entries.map(c => ({ value: c.id, label: t('candidate', { name: c.name, review: t({pending:'reviewPending',accepted:'reviewAccepted',rejected:'reviewRejected'}[c.review.decision]) }) })) : [{ value: '', label: t('noCandidate') }], selectedCandidateId || entries.at(-1)?.id || '');
      candidate = entries.find(c => c.id === r.candidates.value) || null;
      editing = !candidate; surface.update({ handoffOpen: false });
      if (change) { r.request.value = change.request; r.title.value = change.title; r.preserve.value = change.preserve; }
      surface.update({ changeInfo: change ? t('change', { title: change.title, revision: change.source.revisionId }) : t('noChange') });
      updateState(); await renderPreview();
    }
    async function reloadChanges(preferredCandidateId) {
      changes = (await ctx.api('/api/fwv/changes')).changes.filter(c => c.source.assetId === assetId && c.source.revisionId === revisionId);
      options(r.changes, [{ value: '', label: t('noChange') }, ...changes.map(c => ({ value: c.id, label: c.title }))], changeId || ''); await showChange(preferredCandidateId);
    }
    async function load() {
      stop(); data = await ctx.refresh(); if (disposed) return;
      const models = data.assets.filter(a => a.kind === 'model3d'); asset = models.find(a => a.id === assetId) || models[0]; assetId = asset?.id;
      options(r.asset, models.map(a => ({ value: a.id, label: a.name })), assetId);
      revision = asset?.revisions.find(v => v.id === revisionId) || asset?.revisions.find(v => v.id === asset.selectedRevisionId); revisionId = revision?.id;
      options(r.revision, (asset?.revisions || []).map((v, i) => ({ value: v.id, label: revisionLabel(v, i, asset.selectedRevisionId) })), revisionId);
      if (!asset) { notify(t('noModel')); return; }
      summary = await ctx.api('/api/fwv/model?' + new URLSearchParams({ assetId, revisionId }));
      surface.update({ summary: t('summary', { meshes: summary.meshes.length, joints: summary.nodes.filter(n => n.joint).length, materials: summary.materials.length, animations: summary.animations.length }),
        inspection: JSON.stringify({ materials: summary.materials, hierarchy: summary.nodes, skins: summary.skins, validation: summary.validation }, null, 2) });
      options(r.animation, [{ value: '-1', label: t('setup') }, ...summary.animations.map(a => ({ value: String(a.index), label: a.name }))], '-1'); r.time.value = '0';
      options(r.bone, summary.nodes.filter(n => n.joint && !n.matrix).map(n => ({ value: String(n.index), label: n.name + ' [' + n.index + '] parent:' + n.parent }))); showBone();
      const meshes = summary.meshes.flatMap(m => m.primitives.filter(p => p.weightEditable).map(p => ({ value: m.index + ':' + p.index, label: m.name + ' / ' + p.index + ' (' + p.vertices + ' vertices)' })));
      options(r.primitive, meshes.length ? meshes : [{ value: '', label: t('noMesh') }]); r.vertex.value = '0';
      options(r.texture, summary.images.length ? summary.images.map(i => ({ value: String(i.index), label: i.name })) : [{ value: '', label: t('noTexture') }]); showTexture();
      options(r.image, [{ value: '', label: t('noImage') }, ...data.assets.filter(a => a.kind === 'image').map(a => ({ value: a.id, label: a.name }))], ''); imageVersions();
      await reloadChanges();
      if (summary.validation.errors || summary.validation.warnings) notify(t('validation', summary.validation), Boolean(summary.validation.errors));
      else notify('');
    }
    on('import', () => r.file.click());
    async function importModel(file) {
      const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
      return ctx.command('model.import', { fileName: file.name, name: file.name.replace(/\.glb$/i, ''), base64 });
    }
    on('file', async () => {
      const file = r.file.files[0]; r.file.value = ''; if (!file) return;
      const imported = await importModel(file); assetId = imported.id; revisionId = imported.selectedRevisionId; changeId = null; await load(); notify(t('imported'));
    }, 'change');
    on('asset', async () => { assetId = r.asset.value; revisionId = null; changeId = null; await load(); }, 'change');
    on('revision', async () => { revisionId = r.revision.value; changeId = null; await load(); }, 'change');
    on('changes', () => showChange(), 'change');
    on('candidates', async () => { candidate = change?.candidates.find(c => c.id === r.candidates.value) || null; editing = !candidate; updateState(); await renderPreview(); }, 'change');
    async function createChange() {
      const request = r.request.value.trim(); if (!request) throw new Error(t('needRequest'));
      const conditions = preview?.conditions() || {}, selectedAnimation = summary.animations.find(a => a.index === Number(r.animation.value));
      const anchors = { view: conditions, ...(r.bone.value ? { objects: ['node:' + r.bone.value] } : {}), ...(selectedAnimation ? { animation: { name: selectedAnimation.name, time: Number(r.time.value) || 0 } } : {}) };
      const result = await ctx.command('change.create', { sourceAssetId: assetId, sourceRevisionId: revisionId, title: r.title.value.trim() || request.replace(/\s+/g, ' ').slice(0, 80), request, preserve: r.preserve.value, anchors });
      changeId = result.id; await reloadChanges(); return result;
    }
    async function ensureChange() {
      if (!change || change.adoptedCandidateId || change.request !== r.request.value.trim() || change.preserve !== r.preserve.value.trim()) await createChange();
      return change;
    }
    async function prepare() {
      const current = await ensureChange(), prepared = await ctx.command('change.prepare', { changeId: current.id });
      if (disposed) return; r.handoff.value = prepared.prompt + '\n\n' + JSON.stringify({ sourceFiles: prepared.sourceFiles, completion: prepared.completion }, null, 2); surface.update({ handoffOpen: true });
    }
    on('create', async () => {
      await prepare(); notify(t('created'));
    });
    async function repair(payload) { const current = await ensureChange(); const result = await ctx.command('model.candidate.repair', { changeId: current.id, requestId: crypto.randomUUID(), ...payload });
      changeId = result.id; await reloadChanges(result.candidates.at(-1).id); notify(t('repaired')); }
    on('repairBone', async () => { if (!r.bone.value) throw new Error(t('pickBone')); await repair({ boneEdits: [{ nodeIndex: Number(r.bone.value), translation: vector('translation', 3), rotation: vector('rotation', 4), scale: vector('scale', 3) }] }); });
    function vertexInput() { const [meshIndex, primitiveIndex] = r.primitive.value.split(':').map(Number); return { meshIndex, primitiveIndex, vertexIndex: Number(r.vertex.value) }; }
    on('readVertex', async () => { const item = await ctx.api('/api/fwv/model?' + new URLSearchParams({ assetId, revisionId, view: 'vertex', ...vertexInput() })); r.weights.value = item.weights.join(', '); surface.update({ vertexInfo: t('vertex', { joints: item.joints.join(', '), weights: item.weights.join(', ') }) }); });
    on('repairWeight', () => repair({ weightEdits: [{ ...vertexInput(), weights: vector('weights', 4) }] }));
    on('extractTexture', async () => { await ctx.command('model.texture.extract', { assetId, revisionId, imageIndex: Number(r.texture.value) }); data = ctx.getSnapshot(); options(r.image, [{ value: '', label: t('noImage') }, ...data.assets.filter(a => a.kind === 'image').map(a => ({ value: a.id, label: a.name }))], ''); imageVersions(); notify(t('textureExtracted')); });
    on('repairTexture', () => repair({ textureEdits: [{ imageIndex: Number(r.texture.value), assetId: r.image.value, revisionId: r.imageRevision.value }] }));
    on('prepare', prepare);
    on('copy', async () => { try { await navigator.clipboard.writeText(r.handoff.value); notify(t('copied')); } catch { r.handoff.focus(); r.handoff.select(); notify(t('copyFailed')); } });
    on('importCandidate', () => r.candidateFile.click());
    on('candidateFile', async () => {
      const file = r.candidateFile.files[0]; r.candidateFile.value = ''; if (!file) return;
      const current = await ensureChange(), fixedChangeId = current.id;
      const imported = await importModel(file);
      const result = await ctx.command('change.candidate.attach', { changeId: fixedChangeId, assetId: imported.id, revisionId: imported.selectedRevisionId });
      if (disposed) return; changeId = fixedChangeId; await reloadChanges(result.candidates.at(-1).id); notify(t('candidateImported'));
    }, 'change');
    for (const [ref, decision, text] of [['accept', 'accepted', 'accepted'], ['reject', 'rejected', 'rejected']]) on(ref, async () => { await ctx.command('change.review', { changeId, candidateId: candidate.id, decision, comment: r.comment.value }); await reloadChanges(candidate.id); notify(t(text)); });
    on('adopt', async () => {
      if (!candidate || candidate.review.decision === 'rejected' || change.adoptedCandidateId) return;
      const fixed = { changeId: change.id, candidateId: candidate.id }, expectedReview = structuredClone(candidate.review), expectedAdoption = structuredClone(change.adoption ?? null);
      let accepted = expectedReview.decision === 'accepted';
      try {
        if (!accepted) { await ctx.command('change.review', { ...fixed, decision: 'accepted', expectedReview, comment: t('reviewComment') }); accepted = true; }
        if (disposed) return;
        await ctx.command('change.adopt', { ...fixed, expectedAdoption });
        await reloadChanges(fixed.candidateId); notify(t('adopted'));
      } catch (error) {
        if (!disposed) {
          await reloadChanges(fixed.candidateId).catch(() => {});
          accepted ||= change?.candidates.find(item => item.id === fixed.candidateId)?.review.decision === 'accepted';
          if (change?.id === fixed.changeId && change.adoptedCandidateId === fixed.candidateId) notify(t('adopted'));
          else notify(accepted ? t('adoptPartial', { message: error.message }) : error.message, true);
        }
      }
    });
    on('revise', async () => {
      if (change) { r.request.value = change.request; r.title.value = ''; r.preserve.value = change.preserve; }
      if (change?.adoptedCandidateId) { revisionId = null; changeId = null; await load(); }
      editing = true; updateState(); r.request.focus(); r.request.scrollIntoView({block:'center'}); notify(t('continued'));
    });
    on('back', () => ctx.navigate('assets', { assetId, revisionId, changeId }));
    on('bone', showBone, 'change'); on('texture', showTexture, 'change'); on('image', imageVersions, 'change');
    on('animation', () => { preview?.animation(Number(r.animation.value)); r.time.value = '0'; }, 'change');
    on('time', () => { playing = false; preview?.seek(Number(r.time.value)); }, 'change');
    on('play', () => { playing = !playing; preview?.play(playing); }); on('skeleton', () => preview?.skeleton(r.skeleton.checked), 'change'); on('wireframe', () => preview?.wireframe(r.wireframe.checked), 'change');
    void act(load)();
    return () => { disposed = true; serial++; stop(); surface.dispose(); };
  } });
}());
