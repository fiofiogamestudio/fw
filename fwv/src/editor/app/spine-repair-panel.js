(function () {
  'use strict';
  const localKeys = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearX', 'shearY', 'length'];
  const meshId = mesh => mesh ? JSON.stringify({ skin: mesh.skin, slot: mesh.slot, attachment: mesh.attachment }) : '';
  window.FwvSpineRepair = { mount(host, ctx) {
    const ui = ctx.createSurface('spineRepair'), t = (key, vars) => ui.text(key, vars), r = ui.refs;
    host.append(ui.root);
    const state = { key: '', previewKey: '', info: null, source: null, disposed: false, generation: 0, previewGeneration: 0,
      players: [], loading: false, weightGeneration: 0, vertex: null, draft: {}, weightTimer: null, requestId: '' };
    const previewText = key => ctx.getUiConfig('preview').texts[key] || key;
    const selectedBone = () => state.info?.bones.find(item => item.name === r.boneName.value);
    const selectedMesh = () => state.info?.meshes.find(item => meshId(item) === r.mesh.value);
    const selectedInfluence = () => state.vertex?.influences.find(item => item.boneName === r.influenceBone.value);
    const currentBase = () => ctx.getChange() ? { changeId: ctx.getChange().id }
      : { assetId: state.source.asset.id, revisionId: state.source.revision.id };
    const run = action => async () => {
      if (state.disposed || state.loading) return;
      state.loading = true; sync();
      try { await action(); } catch (error) { if (!state.disposed) ctx.notify(error.message, true); }
      finally { state.loading = false; if (!state.disposed) sync(); }
    };
    async function inspect(extra = {}) {
      const result = await ctx.api('/api/fwv/commands', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-FWV-CSRF': ctx.getSession().csrfToken },
        body: JSON.stringify({ type: 'change.spine.inspect', payload: { ...currentBase(), ...extra } }) });
      return result.result;
    }
    function readDraft() {
      const mesh = selectedMesh();
      return { boneName: r.boneName.value, parent: r.parent.value,
        ...Object.fromEntries(localKeys.map(key => [key, Number(r[key].value)])),
        ...(mesh ? { skin: mesh.skin, slot: mesh.slot, attachment: mesh.attachment, vertexIndex: Number(r.vertexIndex.value || 0),
          influenceBone: r.influenceBone.value, weight: Number(r.weight.value || 0) } : {}) };
    }
    function save() { if (!state.info) return; state.requestId = ''; state.draft = readDraft(); ctx.writeDraft(state.draft); sync(); }
    function edits() {
      const bone = selectedBone(), mesh = selectedMesh(), influence = selectedInfluence();
      const local = bone ? Object.fromEntries(localKeys.map(key => [key, Number(r[key].value)]).filter(([key, value]) => Number.isFinite(value) && value !== bone.local[key])) : {};
      const parentChanged = Boolean(bone && r.parent.value && r.parent.value !== bone.parent);
      const boneEdits = bone && (Object.keys(local).length || parentChanged) ? [{ boneName: bone.name,
        ...(Object.keys(local).length ? { local } : {}), ...(parentChanged ? { parent: r.parent.value } : {}) }] : [];
      const weight = Number(r.weight.value), weightEdits = mesh?.editable && influence && Number.isFinite(weight) && weight !== influence.weight
        ? [{ skin: mesh.skin, slot: mesh.slot, attachment: mesh.attachment, vertexIndex: Number(r.vertexIndex.value), boneName: influence.boneName, weight }] : [];
      return { boneEdits, weightEdits, count: Object.keys(local).length + Number(parentChanged) };
    }
    function sync() {
      if (state.disposed) return;
      const bone = selectedBone(), mesh = selectedMesh(), change = ctx.getChange(), pending = edits();
      ui.update({ hasChange: Boolean(change), hasCandidate: Boolean(ctx.getCandidate()),
        candidateEdits: (ctx.getCandidate()?.metadata?.spineRepair?.edits || []).map(edit => {
          if (edit.type === 'bone') {
            const changes = localKeys.filter(key => edit.before.local[key] !== edit.after.local[key]).map(key => `${key}: ${edit.before.local[key]} -> ${edit.after.local[key]}`);
            if (edit.before.parent !== edit.after.parent) changes.unshift(t('parentChange', { before: edit.before.parent || t('rootBone'), after: edit.after.parent || t('rootBone') }));
            return t('boneChange', { bone: edit.boneName, changes: changes.join(', ') });
          }
          return t('weightChange', { mesh: edit.attachment, index: edit.vertexIndex,
            changes: (edit.after || []).map(item => `${item.boneName}: ${edit.before.find(previous => previous.boneName === item.boneName)?.weight} -> ${item.weight}`).join(', ') });
        }).join('\n'),
        canCreate: Boolean(!change?.adoptedCandidateId && !state.loading && (pending.boneEdits.length || pending.weightEdits.length)),
        canParent: Boolean(bone?.allowedParents?.length), canWeights: Boolean(mesh?.weighted && mesh?.editable), vertexMax: Math.max(0, (mesh?.vertexCount || 1) - 1),
        editSummary: pending.count || pending.weightEdits.length ? t('editSummary', { boneEdits: pending.count, weightEdits: pending.weightEdits.length }) : t('noEdits'),
        boneSummary: bone ? t('boneSummary', { children: bone.children.join(', ') || t('none'), constraints: bone.constraints.map(item => `${item.type}:${item.name}`).join(', ') || t('none'),
          timelines: bone.timelines.map(item => `${item.animation} (${item.properties.join(', ')})`).join(', ') || t('none') }) : '',
        meshSummary: mesh ? t('meshSummary', { type: mesh.type, count: mesh.vertexCount, weighted: t(mesh.weighted ? 'weighted' : 'unweighted'), editable: t(mesh.editable ? 'yes' : 'no'), reason: mesh.reason ? ` / ${mesh.reason}` : '' }) : t('noMesh'),
        vertexSummary: state.vertex ? t('vertexSummary', { index: state.vertex.vertexIndex, sum: state.vertex.sum,
          influences: state.vertex.influences.map(item => t('influence', { bone: item.boneName, weight: item.weight, x: item.x, y: item.y })).join('\n') }) : '' });
    }
    function selectBone({ restore = false } = {}) {
      const bone = selectedBone(); if (!bone) return;
      const draft = restore && state.draft.boneName === bone.name ? state.draft : {};
      ui.setOptions(r.parent, bone.allowedParents.length ? bone.allowedParents.map(name => ({ value: name, label: name })) : [{ value: '', label: t('rootBone') }], draft.parent ?? bone.parent ?? '');
      for (const key of localKeys) r[key].value = draft[key] ?? bone.local[key];
      renderPose(); sync();
    }
    function selectInfluence({ restore = false } = {}) {
      const influence = selectedInfluence();
      r.weight.value = restore && state.draft.influenceBone === influence?.boneName ? state.draft.weight ?? influence?.weight ?? 0 : influence?.weight ?? 0;
      sync();
    }
    async function loadVertex({ restore = false } = {}) {
      const mesh = selectedMesh(), token = ++state.weightGeneration;
      state.vertex = null; sync();
      if (!mesh?.editable || !mesh.weighted) { ui.setOptions(r.influenceBone, [], ''); r.weight.value = 0; return; }
      const vertexIndex = Number(r.vertexIndex.value || 0);
      if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= mesh.vertexCount) return;
      const result = await inspect({ mesh: { skin: mesh.skin, slot: mesh.slot, attachment: mesh.attachment }, vertexIndex });
      if (state.disposed || token !== state.weightGeneration) return;
      state.vertex = result.vertex;
      ui.setOptions(r.influenceBone, (state.vertex?.influences || []).map(item => ({ value: item.boneName, label: item.boneName })), restore ? state.draft.influenceBone : r.influenceBone.value);
      selectInfluence({ restore });
    }
    function stopPlayers() { state.previewGeneration++; for (const player of state.players) player?.dispose(); state.players = []; }
    function renderPose() {
      const animation = r.animation.value, time = Number(r.time.value || 0), skin = selectedMesh()?.skin;
      for (const player of state.players) {
        if (!player) continue;
        if (skin && player.skins.includes(skin)) player.setSkin(skin);
        player.setAnimation(animation); player.setDebug({ bones: r.showBones.checked, mesh: r.showMesh.checked, selectedBone: r.showBones.checked ? r.boneName.value : null }); player.draw(time);
      }
      if (state.players[0] && state.players[1]) state.players[1].setFrame(state.players[0].getFrame());
    }
    async function loadPlayers() {
      stopPlayers();
      const token = state.previewGeneration, source = state.source, candidate = ctx.getCandidate();
      const candidateAsset = ctx.getSnapshot().assets.find(item => item.id === candidate?.assetId), candidateRevision = candidateAsset?.revisions.find(item => item.id === candidate?.revisionId);
      const loaded = [];
      ui.update({ previewStatus: t('loading'), previewError: false });
      try {
        loaded[0] = await window.FwvSpinePreview(r.sourceCanvas, source.asset, source.revision, { text: previewText });
        if (candidateRevision) loaded[1] = await window.FwvSpinePreview(r.candidateCanvas, candidateAsset, candidateRevision, { text: previewText });
        if (state.disposed || token !== state.previewGeneration) { loaded.forEach(player => player?.dispose()); return; }
        state.players = loaded; renderPose();
        ui.update({ previewStatus: t(candidateRevision ? 'comparisonReady' : 'ready'), previewError: false });
      } catch (error) {
        loaded.forEach(player => player?.dispose());
        if (!state.disposed && token === state.previewGeneration) ui.update({ previewStatus: t('previewError', { message: error.message }), previewError: true });
      }
    }
    async function load() {
      const token = ++state.generation;
      try {
        const info = await inspect(); if (state.disposed || token !== state.generation) return;
        state.info = info; state.draft = structuredClone(ctx.readDraft() || {});
        ui.setOptions(r.boneName, info.bones.map(item => ({ value: item.name, label: `${item.name}${item.parent ? ` / ${item.parent}` : ''}` })), state.draft.boneName || r.boneName.value);
        ui.setOptions(r.mesh, info.meshes.length ? info.meshes.map(item => ({ value: meshId(item), label: `${item.skin} / ${item.slot} / ${item.attachment}` })) : [{ value: '', label: t('noMesh') }],
          state.draft.attachment ? meshId(state.draft) : meshId(info.meshes.find(item => item.editable) || info.meshes[0]));
        ui.setOptions(r.animation, [{ value: '', label: t('setup') }, ...info.animations.map(item => ({ value: item.name, label: `${item.name} (${item.duration}s)` }))], r.animation.value);
        r.vertexIndex.value = state.draft.vertexIndex || 0;
        ui.update({ summary: t('summary', { bones: info.bones.length, meshes: info.meshes.length, animations: info.animations.length }),
          diagnostics: info.diagnostics.map(item => `${item.severity}: ${item.message}`).join('\n') || t('none'), limits: t('limits', { limits: info.limits.join('; ') }) });
        selectBone({ restore: true }); await loadVertex({ restore: true }); sync();
      } catch (error) { if (!state.disposed && token === state.generation) ctx.notify(t('readError', { message: error.message }), true); }
    }
    function update() {
      if (state.disposed) return;
      const source = ctx.getSource(), candidate = ctx.getCandidate();
      if (source.asset?.kind !== 'spine' || !source.revision) { if (state.key) stopPlayers(); state.key = ''; state.previewKey = ''; return; }
      state.source = source;
      const key = `${source.asset.id}:${source.revision.id}:${ctx.getChange()?.id || ''}`;
      if (key !== state.key) { state.key = key; state.info = null; state.vertex = null; void load(); }
      const previewKey = `${source.asset.id}:${source.revision.id}:${candidate?.assetId || ''}:${candidate?.revisionId || ''}`;
      if (previewKey !== state.previewKey) { state.previewKey = previewKey; void loadPlayers(); }
      sync();
    }
    r.boneName.addEventListener('change', () => { selectBone(); save(); });
    for (const key of [...localKeys, 'parent']) r[key].addEventListener(key === 'parent' ? 'change' : 'input', save);
    r.mesh.addEventListener('change', () => { r.vertexIndex.value = 0; void run(async () => { await loadVertex(); renderPose(); save(); })(); });
    r.vertexIndex.addEventListener('input', () => {
      clearTimeout(state.weightTimer); state.weightTimer = setTimeout(() => { void run(async () => { await loadVertex(); save(); })(); }, 180);
    });
    r.influenceBone.addEventListener('change', () => { selectInfluence(); save(); }); r.weight.addEventListener('input', save);
    for (const key of ['animation', 'time', 'showBones', 'showMesh']) r[key].addEventListener(key === 'time' ? 'input' : 'change', renderPose);
    r.anchor.addEventListener('click', () => { ctx.onAnchor({ boneName: r.boneName.value, animation: r.animation.value, time: Number(r.time.value || 0) }); ctx.notify(t('anchored')); });
    r.create.addEventListener('click', run(async () => {
      const pending = edits(); if (!pending.boneEdits.length && !pending.weightEdits.length) return;
      const selectedChange = ctx.getChange() || await ctx.ensureChange();
      state.requestId ||= crypto.randomUUID();
      const change = await ctx.command('change.candidate.spine-repair', { changeId: selectedChange.id, requestId: state.requestId,
        ...(pending.boneEdits.length ? { boneEdits: pending.boneEdits } : {}), ...(pending.weightEdits.length ? { weightEdits: pending.weightEdits } : {}) });
      state.requestId = ''; ctx.onCandidate(change); ctx.notify(t('created'));
    }));
    const resize = new ResizeObserver(renderPose); resize.observe(r.sourceCanvas); resize.observe(r.candidateCanvas);
    return { update, dispose() { state.disposed = true; state.generation++; state.weightGeneration++; clearTimeout(state.weightTimer); resize.disconnect(); stopPlayers(); ui.dispose(); } };
  } };
}());
